import { expect, test } from 'bun:test';
import { PROFILES } from './agentProfiles';
import { hostLaunch, hostProfiles, INSTALL_PAGES, type HostAgent } from './sshAgents';

const on = (name: string, fallback = false): HostAgent => ({ name, path: `/home/me/.local/bin/${name}`, fallback });

test('a CLI on the login PATH starts as written; one only a fallback folder has starts by its path', () => {
	expect(hostLaunch(['claude', '--model', 'opus'], [on('claude')])).toEqual({ kind: 'ok', argv: ['claude', '--model', 'opus'] });
	expect(hostLaunch(['codex'], [on('codex', true)])).toEqual({ kind: 'ok', argv: ['/home/me/.local/bin/codex'] });
	expect(hostLaunch(['env', 'A=1', 'B=2', 'codex', 'x'], [on('codex', true)])).toEqual({ kind: 'ok', argv: ['env', 'A=1', 'B=2', '/home/me/.local/bin/codex', 'x'] });
});

test("a CLI the host doesn't have is named, with its install page", () => {
	const r = hostLaunch(['claude'], [on('codex')]);
	expect(r.kind).toBe('missing');
	if (r.kind !== 'missing') return;
	expect(r.program).toBe('claude');
	expect(r.profile.id).toBe('claude');
	expect(r.installPage).toBe('https://code.claude.com/docs');
	const custom = hostLaunch(['my-agent', '--go'], []);
	expect(custom).toMatchObject({ kind: 'missing', program: 'my-agent', installPage: null });
});

test('a profile that needs a second program is missing without it', () => {
	const dsh = PROFILES.find((p) => p.requires?.length);
	if (!dsh) return;
	const bin = dsh.bins[0]!;
	const need = dsh.requires![0]!;
	expect(hostLaunch([bin], [on(bin)])).toMatchObject({ kind: 'missing', program: need });
	expect(hostLaunch([bin], [on(bin), on(need)]).kind).toBe('ok');
});

test('a program given by path is the user\'s own file on the host and is not second-guessed', () => {
	expect(hostLaunch(['/opt/tools/claude', '-c'], [])).toEqual({ kind: 'ok', argv: ['/opt/tools/claude', '-c'] });
	expect(hostLaunch(['env', 'X=1', '~/bin/agent'], [])).toEqual({ kind: 'ok', argv: ['env', 'X=1', '~/bin/agent'] });
});

test('the agents a host has are listed in catalog order with the program that selects each', () => {
	const rows = hostProfiles([on('codex'), on('claude'), on('not-an-agent')]);
	expect(rows.map((r) => `${r.profile.id}:${r.bin}`)).toEqual(['claude:claude', 'codex:codex']);
	expect(hostProfiles([])).toEqual([]);
});

test('every install page belongs to a known profile', () => {
	const ids = new Set(PROFILES.map((p) => p.id));
	expect(Object.keys(INSTALL_PAGES).filter((id) => !ids.has(id))).toEqual([]);
	for (const url of Object.values(INSTALL_PAGES)) expect(url.startsWith('https://')).toBe(true);
});
