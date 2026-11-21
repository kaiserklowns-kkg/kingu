import { describe, expect, test } from 'bun:test';
import {
	agentRingProgress,
	displayText,
	isPassiveInput,
	MAX_BODY_BYTES,
	parseProgramStatus,
	PROGRAM_STALE_AFTER_MS,
	programIndicator,
	programLabel,
	reduceChildren,
	reduceProgram,
	withChildren,
	type ProgramChild,
	ringArc,
	withPercent,
	type ProgramEvent,
	type ProgramFacet
} from './programStatus';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const report = (body: string) => {
	const m = parseProgramStatus(body);
	return m?.type === 'report' ? m.report : null;
};

describe('parseProgramStatus', () => {
	test('state, progress and a base64 message', () => {
		expect(report(`state=working:progress=40:msg=${b64('Compiling')}`)).toEqual({ id: null, state: 'working', progress: 40, msg: 'Compiling' });
		expect(report('state=working')).toEqual({ id: null, state: 'working' });
		expect(report(' state = done ')).toEqual({ id: null, state: 'done' });
		expect(parseProgramStatus(' ? ')).toEqual({ type: 'query' });
	});

	test('no state, an unknown state or a bad id: ignored whole', () => {
		expect(parseProgramStatus('progress=40')).toBeNull();
		expect(parseProgramStatus('state=busy')).toBeNull();
		expect(parseProgramStatus('')).toBeNull();
		expect(parseProgramStatus('state=working:id=a b')).toBeNull();
		expect(parseProgramStatus('state=working:id=a//b:id=ok')).toBeNull();
		expect(parseProgramStatus(`state=working:id=${Array(9).fill('a').join('/')}`)).toBeNull();
		expect(report('state=working:id=build/step-1')?.id).toBe('build/step-1');
		expect(report('state=clear')).toEqual({ id: null, state: 'clear' });
	});

	test('progress only on live states, 0-100, digits only', () => {
		expect(report('state=working:progress=007')?.progress).toBe(7);
		expect(report('state=blocked:progress=100')?.progress).toBe(100);
		expect(report('state=working:progress=101')?.progress).toBeUndefined();
		expect(report('state=working:progress=-1')?.progress).toBeUndefined();
		expect(report('state=working:progress=4.5')?.progress).toBeUndefined();
		expect(report('state=working:progress=1e2')?.progress).toBeUndefined();
		expect(report('state=done:progress=50')?.progress).toBeUndefined();
	});

	test('kind only on blocked; app is a short plain token', () => {
		expect(report('state=blocked:kind=auth')?.kind).toBe('auth');
		expect(report('state=blocked:kind=root')?.kind).toBeUndefined();
		expect(report('state=working:kind=auth')?.kind).toBeUndefined();
		expect(report('state=working:app=claude-code')?.app).toBe('claude-code');
		expect(parseProgramStatus(`state=working:app=${'a'.repeat(33)}`)).toBeNull();
	});

	test('limits void the report, even when a valid duplicate follows', () => {
		expect(parseProgramStatus(`state=working:msg=${'A'.repeat(2736)}:msg=${b64('ok')}`)).toBeNull();
		expect(parseProgramStatus(`state=working:title=${b64('x'.repeat(193))}`)).toBeNull();
		expect(parseProgramStatus(`state=working:${'k'.repeat(17)}=1`)).toBeNull();
		expect(parseProgramStatus(`state=working:msg=${b64('a')}${':x=1'.repeat(2000)}`)).toBeNull();
		expect(parseProgramStatus('s'.repeat(MAX_BODY_BYTES + 1))).toBeNull();
		expect(report(`state=working:title=${b64('x'.repeat(192))}`)?.title).toHaveLength(192);
	});

	test('text must be base64 of valid UTF-8 without control characters', () => {
		expect(parseProgramStatus(`state=working:msg=${b64('a\nb')}`)).toBeNull();
		expect(parseProgramStatus(`state=working:msg=${b64('a\x1b[31m')}`)).toBeNull();
		expect(parseProgramStatus(`state=working:msg=${Buffer.from([0xff, 0xfe]).toString('base64')}`)).toBeNull();
		expect(parseProgramStatus('state=working:msg=A')).toBeNull();
		expect(report(`state=working:msg=${b64('สร้าง 40%').replace(/=+$/, '')}`)?.msg).toBe('สร้าง 40%');
		// A raw (not base64) message is a malformed pair: skipped, the state still applies.
		expect(report('state=working:msg=hello world')).toEqual({ id: null, state: 'working' });
	});
});

describe('displayText', () => {
	test('strips invisible formatting and bounds the length', () => {
		expect(displayText('‮done​ ')).toBe('done');
		expect(displayText(' ​ ')).toBeUndefined();
		expect(displayText('x'.repeat(500))).toHaveLength(400);
	});
});

const rep = (body: string): ProgramEvent => ({ type: 'report', report: report(body)! });
const run = (events: ProgramEvent[], start = 1000) => events.reduce<ProgramFacet | undefined>((f, e, i) => reduceProgram(f, e, start + i), undefined);

describe('reduceProgram', () => {
	test('each report replaces the record whole', () => {
		expect(run([rep(`state=working:progress=40:msg=${b64('Build')}`)])).toEqual({ state: 'working', progress: 40, message: 'Build', observedAt: 1000 });
		expect(run([rep('state=working:progress=40'), rep('state=working')])).toEqual({ state: 'working', observedAt: 1001 });
	});

	test('a root clear and a terminal reset remove it', () => {
		expect(run([rep('state=working:progress=40'), rep('state=clear')])).toBeUndefined();
		expect(run([rep('state=done'), { type: 'reset' }])).toBeUndefined();
	});

	test('a new prompt ends live states and keeps a finished result until the user types', () => {
		expect(run([rep('state=working:progress=40'), { type: 'end' }])).toBeUndefined();
		expect(run([rep('state=blocked:kind=auth'), { type: 'end' }])).toBeUndefined();
		expect(run([rep('state=idle'), { type: 'end' }])).toBeUndefined();
		expect(run([rep('state=error'), { type: 'end' }])?.state).toBe('error');
		expect(run([rep('state=done'), { type: 'end' }, { type: 'input' }])).toBeUndefined();
		expect(run([rep('state=working:progress=40'), { type: 'input' }])?.progress).toBe(40);
	});

	test('reports for ids beneath the root change nothing', () => {
		expect(run([rep('state=working:progress=40'), rep('state=done:id=step-1'), rep('state=clear:id=step-1')])?.progress).toBe(40);
		expect(run([rep('state=working:id=step-1')])).toBeUndefined();
	});

	test('a repeated report keeps the same object until the refresh interval passes', () => {
		const first = reduceProgram(undefined, rep('state=working:progress=40'), 1000)!;
		expect(reduceProgram(first, rep('state=working:progress=40'), 2000)).toBe(first);
		expect(reduceProgram(first, rep('state=working:progress=40'), 7000)?.observedAt).toBe(7000);
		expect(reduceProgram(first, rep('state=working:progress=41'), 2000)?.progress).toBe(41);
	});
});

describe('programIndicator', () => {
	const f = (over: Partial<ProgramFacet>): ProgramFacet => ({ state: 'working', observedAt: 1000, ...over });

	test('working and blocked draw live, with the percentage when given', () => {
		expect(programIndicator(f({ progress: 40 }), 2000)).toEqual({ status: 'working', progress: 40 });
		expect(programIndicator(f({}), 2000)).toEqual({ status: 'working' });
		expect(programIndicator(f({ state: 'blocked', kind: 'auth', message: 'Expired' }), 2000)).toEqual({ status: 'permission', kind: 'auth', message: 'Expired' });
	});

	test('a live report goes when the shell is back in front or it went stale', () => {
		expect(programIndicator(f({ progress: 40 }), 2000, true)).toBeNull();
		expect(programIndicator(f({ progress: 40 }), 1000 + PROGRAM_STALE_AFTER_MS + 1)).toBeNull();
		expect(programIndicator(f({ progress: 40 }), 1000 + PROGRAM_STALE_AFTER_MS)).not.toBeNull();
	});

	test('done and error stay as a result, without a percentage; idle shows nothing', () => {
		expect(programIndicator(f({ state: 'done' }), 1000 + PROGRAM_STALE_AFTER_MS * 2, true)).toEqual({ status: 'done' });
		expect(programIndicator(f({ state: 'error', message: 'exit 1' }), 2000, true)).toEqual({ status: 'failed', message: 'exit 1' });
		expect(programIndicator(f({ state: 'idle' }), 2000)).toBeNull();
		expect(programIndicator(undefined, 2000)).toBeNull();
	});
});

describe('agentRingProgress', () => {
	const live: ProgramFacet = { state: 'working', progress: 60, observedAt: 1000 };

	test('only while both the agent row and the report are live', () => {
		expect(agentRingProgress('working', live, 2000)).toBe(60);
		expect(agentRingProgress('permission', { ...live, state: 'blocked' }, 2000)).toBe(60);
		expect(agentRingProgress('idle', live, 2000)).toBeUndefined();
		expect(agentRingProgress('working', { state: 'done', observedAt: 1000 }, 2000)).toBeUndefined();
		expect(agentRingProgress('working', { state: 'working', observedAt: 1000 }, 2000)).toBeUndefined();
		expect(agentRingProgress('working', live, 1000 + PROGRAM_STALE_AFTER_MS + 1)).toBeUndefined();
		expect(agentRingProgress('working', undefined, 2000)).toBeUndefined();
	});
});

describe('ring and labels', () => {
	test('a small percentage still shows an arc; zero shows none', () => {
		expect(ringArc(0)).toBe(0);
		expect(ringArc(1)).toBe(8);
		expect(ringArc(40)).toBe(40);
		expect(ringArc(140)).toBe(100);
	});

	test('the label carries the percentage and the message', () => {
		expect(withPercent('Working', 40)).toBe('Working · 40%');
		expect(withPercent('Working', undefined)).toBe('Working');
		expect(programLabel({ status: 'working', progress: 40, message: 'Compiling' })).toBe('Working · 40%: Compiling');
		expect(programLabel({ status: 'permission', kind: 'auth' })).toBe('Sign-in required');
		expect(programLabel({ status: 'permission' })).toBe('Needs you');
		expect(programLabel({ status: 'failed' })).toBe('Failed');
	});
});

describe('isPassiveInput', () => {
	test('focus reports, hover motion and query replies are not typing', () => {
		expect(isPassiveInput('\x1b[I')).toBe(true);
		expect(isPassiveInput('\x1b[O\x1b[I')).toBe(true);
		expect(isPassiveInput('\x1b[<35;10;4M')).toBe(true);
		expect(isPassiveInput('\x1b[12;40R')).toBe(true);
		expect(isPassiveInput('\x1b[?1;2c')).toBe(true);
		expect(isPassiveInput('\x1b[<0;10;4M')).toBe(false);
		expect(isPassiveInput('a')).toBe(false);
		expect(isPassiveInput('\r')).toBe(false);
		expect(isPassiveInput('\x1b[A')).toBe(false);
		expect(isPassiveInput('')).toBe(false);
	});
});

describe('sub-tasks (ids beneath the root)', () => {
	const ev = (body: string): ProgramEvent => ({ type: 'report', report: report(body)! });
	const kids = (events: ProgramEvent[]) => events.reduce<readonly ProgramChild[]>((k, e) => reduceChildren(k, e), []);

	test('a child report replaces that child; done ends it; clearing an id clears beneath it', () => {
		const k = kids([ev(`id=a:state=working:title=${b64('Explore repo')}:app=claude`), ev('id=a/b:state=blocked:kind=permission'), ev('id=c:state=working')]);
		expect(k.map((c) => c.id)).toEqual(['a', 'a/b', 'c']);
		expect(k[0]).toEqual({ id: 'a', state: 'working', label: 'Explore repo', app: 'claude' });
		expect(kids([ev('id=c:state=working'), ev('id=c:state=done')])).toEqual([]);
		expect(reduceChildren(k, ev('id=a:state=clear')).map((c) => c.id)).toEqual(['c']);
		expect(reduceChildren(k, ev('state=clear'))).toEqual([]);
		expect(reduceChildren(k, { type: 'end' })).toEqual([]);
		expect(reduceChildren(k, { type: 'input' })).toBe(k);
		// The root's own reports leave the children alone.
		expect(reduceChildren(k, ev('state=done'))).toBe(k);
	});

	test('live children keep a finished program working (Orca held turn), not OpenCode', () => {
		const done: ProgramFacet = { state: 'done', observedAt: 1000 };
		const live: ProgramChild[] = [{ id: 'a', state: 'working', label: 'Explore' }, { id: 'b', state: 'idle' }];
		const i = withChildren(programIndicator(done, 1000), done, live, 1000);
		expect(i).toEqual({ status: 'working', children: [live[0]] });
		expect(programLabel(i!)).toContain('Explore');
		expect(withChildren(null, undefined, [{ id: 'x', state: 'blocked', kind: 'question' }], 1000)?.status).toBe('permission');
		expect(withChildren(programIndicator(done, 1000), done, [{ id: 'b', state: 'idle' }], 1000)?.status).toBe('done');
		const oc: ProgramFacet = { ...done, app: 'opencode' };
		expect(withChildren(programIndicator(oc, 1000), oc, live, 1000)?.status).toBe('done');
	});
});
