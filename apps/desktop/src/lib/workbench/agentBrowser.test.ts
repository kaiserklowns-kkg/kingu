import { describe, expect, test } from 'bun:test';
import { indicatorOf, isAgentLabel, logJson, logRow, replaySteps, sessionName, type AgentLogEntry, type AgentPage } from './agentBrowser';

const page = (o: Partial<AgentPage> = {}): AgentPage => ({ label: 'agent-browser-1-1', url: 'https://a.dev/', agentOpened: true, opener: 'chat:/r:c1', stopped: false, driving: false, ...o });
const entry = (seq: number, o: Partial<AgentLogEntry> = {}): AgentLogEntry => ({
	seq,
	atMs: 1_700_000_000_000 + seq,
	session: 'chat:/r:c1',
	page: 'agent-browser-1-1',
	step: { tool: 'click', ref: `e${seq}` },
	ok: true,
	outcome: `Clicked e${seq}`,
	secret: false,
	...o
});

describe('the tab indicator', () => {
	test('shows nothing for a page no agent may use, then shared, driving and stopped', () => {
		expect(indicatorOf(undefined, null)).toBeNull();
		expect(indicatorOf(page(), 'Clicked x')).toEqual({ kind: 'shared', action: null, agentOpened: true });
		expect(indicatorOf(page({ driving: true }), 'Clicked Sign in')).toEqual({ kind: 'driving', action: 'Clicked Sign in', agentOpened: true });
		expect(indicatorOf(page({ stopped: true, driving: true }), 'x')?.kind).toBe('stopped');
		expect(indicatorOf(page({ agentOpened: false }), null)?.agentOpened).toBe(false);
		expect(isAgentLabel('agent-browser-9-2')).toBe(true);
		expect(isAgentLabel('ade-browser-primary-b1')).toBe(false);
	});
});

describe('the action log (Kingu-only)', () => {
	test('replays this page\'s successful navigations, clicks and typing in order, never password typing', () => {
		const log = [
			entry(3),
			entry(1, { step: { tool: 'open', url: 'https://a.dev/' } }),
			entry(2, { step: { tool: 'read' } }),
			entry(4, { step: { tool: 'type', ref: 'e4' }, secret: true }),
			entry(5, { ok: false }),
			entry(6, { page: 'other' }),
			entry(7, { step: { tool: 'type', ref: 'e7', text: 'kingu', submit: true } }),
			entry(8, { step: { tool: 'screenshot' } })
		];
		expect(replaySteps(log, 'agent-browser-1-1')).toEqual([{ tool: 'open', url: 'https://a.dev/' }, { tool: 'click', ref: 'e3' }, { tool: 'type', ref: 'e7', text: 'kingu', submit: true }]);
		expect(replaySteps(log, 'nope')).toEqual([]);
	});

	test('rows say what happened and whose chat it was; JSON keeps one page', () => {
		expect(logRow(entry(1), () => '12:00')).toEqual({ label: '✓ Clicked e1', description: '12:00 · chat c1 · click' });
		expect(logRow(entry(2, { ok: false, outcome: 'gone' }), () => 't').label).toBe('✗ gone');
		expect(logRow(entry(3, { secret: true, outcome: 'Typed in e3' }), () => 't').label).toContain('password, not kept');
		expect(sessionName('run:abcd1234')).toBe('run abcd1234');
		const json = JSON.parse(logJson([entry(1), entry(2, { page: 'other' })], 'agent-browser-1-1'));
		expect(json).toHaveLength(1);
		expect(json[0].step).toEqual({ tool: 'click', ref: 'e1' });
	});
});
