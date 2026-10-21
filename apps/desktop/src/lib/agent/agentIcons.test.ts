import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ICON_FILES, AGENT_ICONS, agentIcon, agentIconKey, providerIconKey } from './agentIcons';
import { PROFILES } from '#lib/ade/agentProfiles.ts';
import { AGENT_NAMES } from '#lib/ade/agentTitle.ts';
import { PROVIDERS } from '#lib/workbench/usage.ts';
import { AI_TEXT_AGENTS } from '#lib/settings/ade/git.ts';

const ASSETS = join(import.meta.dir, '../assets/agent-icons');

/** The chat runtimes Rust knows (agent/runtimes.rs `KNOWN`, plus claude and arkai), read from the source so a new one cannot miss its icon. */
function rustRuntimes(): { id: string; name: string; program: string }[] {
	const src = readFileSync(join(import.meta.dir, '../../../src-tauri/src/agent/runtimes.rs'), 'utf8');
	const known = [...src.matchAll(/Known \{ id: "([^"]+)", name: "([^"]+)", program: "([^"]+)"/g)].map((m) => ({ id: m[1], name: m[2], program: m[3] }));
	return [{ id: 'claude', name: 'Claude Code', program: 'claude' }, { id: 'arkai', name: 'Arkai', program: 'arkai' }, ...known];
}

describe('agent icons', () => {
	test('every chat runtime resolves by id, display name and program', () => {
		const runtimes = rustRuntimes();
		expect(runtimes.length).toBeGreaterThan(5);
		for (const r of runtimes) {
			expect([r.id, agentIconKey(r.id)]).not.toEqual([r.id, null]);
			expect(agentIconKey(r.name)).toBe(agentIconKey(r.id));
			expect(agentIconKey(r.program)).toBe(agentIconKey(r.id));
		}
	});

	test('every agent CLI profile resolves by id, title and each program, also as a saved task command', () => {
		for (const p of PROFILES) {
			const key = agentIconKey(p.id);
			expect([p.id, key]).not.toEqual([p.id, null]);
			expect(agentIconKey(p.title)).toBe(key);
			for (const bin of p.bins) {
				expect(agentIconKey(bin)).toBe(key);
				expect(agentIconKey(`cli:${bin} --flag value`)).toBe(key);
				expect(agentIconKey(`env FOO=1 /usr/local/bin/${bin}`)).toBe(key);
			}
		}
	});

	test('the agents Orca knows by terminal title, the usage and account providers and the git AI agents all resolve', () => {
		for (const id of [...AGENT_NAMES, ...PROVIDERS, 'devin', ...AI_TEXT_AGENTS.filter((a) => a && a !== 'custom')]) expect([id, agentIconKey(id)]).not.toEqual([id, null]);
		for (const id of PROVIDERS) expect([id, agentIconKey(providerIconKey(id))]).not.toEqual([id, null]);
	});

	test('the marks Orca draws', () => {
		expect(agentIconKey('claude')).toBe('claude');
		expect(agentIconKey('Claude Code')).toBe('claude');
		expect(agentIconKey('codex')).toBe('codex');
		expect(agentIconKey('cursor-agent')).toBe('cursor');
		expect(agentIconKey('qwen')).toBe('qwen-code');
		expect(agentIconKey('agy')).toBe('antigravity');
		expect(agentIconKey('GitHub Copilot CLI')).toBe('copilot');
		expect(agentIconKey('Factory Droid')).toBe('droid');
		expect(agentIconKey('oh-my-pi')).toBe('omp');
		expect(agentIconKey('arkai')).toBe('arkai');
		// Claude keeps its orange; Codex, Copilot, OpenCode, Pi and Aider follow the text colour.
		expect(AGENT_ICONS.claude.paths[0].fill).toBe('#D97757');
		for (const k of ['codex', 'copilot', 'opencode', 'pi', 'aider'] as const) for (const p of AGENT_ICONS[k].paths) expect('fill' in p).toBe(false);
		expect(agentIcon('gemini')).toEqual({ kind: 'image', file: 'gemini.png' });
		expect(agentIcon('arkai')).toEqual({ kind: 'mark', id: 'arkai-mark' });
		// The usage status bar's own marks.
		expect(providerIconKey('gemini')).toBe('gemini-spark');
		expect(providerIconKey('opencode')).toBe('opencode-go');
		expect(providerIconKey('codex')).toBe('codex');
	});

	test('an unknown agent gets the generic letter tile; no agent yet a question mark', () => {
		expect(agentIconKey('my-acp-agent')).toBeNull();
		expect(agentIcon('my-acp-agent')).toEqual({ kind: 'letter', letter: 'M' });
		expect(agentIcon('cli:./tools/run-bot --x')).toEqual({ kind: 'letter', letter: 'R' });
		expect(agentIcon(null)).toEqual({ kind: 'letter', letter: '?' });
		expect(agentIcon('')).toEqual({ kind: 'letter', letter: '?' });
	});

	test('every bundled file exists, and every file in the folder is used', () => {
		for (const f of AGENT_ICON_FILES) expect([f, existsSync(join(ASSETS, f))]).toEqual([f, true]);
		const onDisk = readdirSync(ASSETS).filter((f) => /\.(png|svg)$/.test(f));
		expect(onDisk.sort()).toEqual([...AGENT_ICON_FILES].sort());
	});
});
