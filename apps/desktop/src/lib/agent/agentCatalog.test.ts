import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILES } from '#lib/ade/agentProfiles.ts';
import { agentCatalog, catalogEntry, onSurface } from './agentCatalog';
import { CLAUDE, type RuntimeInfo } from './runtimes';

const acp = (id: string, custom = false): RuntimeInfo => ({ id, name: id, protocol: 'acp', features: { rewind: false, models: false }, custom });
const RUNTIMES: RuntimeInfo[] = [
	CLAUDE,
	{ id: 'arkai', name: 'Arkai', protocol: 'arkai', features: { rewind: true, models: true }, custom: false },
	{ id: 'codex', name: 'Codex', protocol: 'codex', features: { rewind: false, models: true }, custom: false },
	acp('gemini'),
	acp('mine', true)
];

describe('agentCatalog', () => {
	test('every CLI profile once, in profile order, then chat-only runtimes', () => {
		const ids = agentCatalog(RUNTIMES).map((e) => e.id);
		expect(ids.slice(0, PROFILES.length)).toEqual(PROFILES.map((p) => p.id));
		expect(ids.slice(PROFILES.length)).toEqual(['arkai', 'mine']);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).not.toContain('custom');
	});

	test('claude is on both surfaces even before Rust answers', () => {
		const claude = catalogEntry(agentCatalog(), 'claude')!;
		expect(claude.surfaces).toEqual(['ide', 'ade']);
		expect(claude.chatRuntime).toBe(CLAUDE);
		expect(claude.capabilities).toEqual({ structured: true, terminal: true, resume: true, fork: true, models: true, effort: true });
	});

	test('a CLI and a runtime with one id are one entry', () => {
		const cat = agentCatalog(RUNTIMES);
		const codex = catalogEntry(cat, 'codex')!;
		expect(codex.cliProfile?.id).toBe('codex');
		expect(codex.chatRuntime?.protocol).toBe('codex');
		expect(codex.surfaces).toEqual(['ide', 'ade']);
		expect(codex.capabilities.fork).toBe(false);
		expect(catalogEntry(cat, 'gemini')!.capabilities.effort).toBe(false);
	});

	test('a CLI without a runtime is ADE only; a runtime without a CLI is IDE only', () => {
		const cat = agentCatalog(RUNTIMES);
		const aider = catalogEntry(cat, 'aider')!;
		expect(aider.surfaces).toEqual(['ade']);
		expect(aider.capabilities).toEqual({ structured: false, terminal: true, resume: true, fork: false, models: false, effort: false });
		for (const e of cat) if (e.cliProfile && !e.chatRuntime) expect([e.id, e.capabilities.resume]).toEqual([e.id, e.cliProfile.canResume]);
		const arkai = catalogEntry(cat, 'arkai')!;
		expect(arkai.surfaces).toEqual(['ide']);
		expect(arkai.cliProfile).toBeUndefined();
		expect(arkai.title).toBe('Arkai');
	});

	test("Rust's known chat runtimes join their CLI profile by id (drift guard for agent/runtimes.rs KNOWN)", () => {
		const rs = readFileSync(join(import.meta.dir, '../../../src-tauri/src/agent/runtimes.rs'), 'utf8');
		const known = [...rs.matchAll(/Known \{ id: "([^"]+)", name: "([^"]+)",[^}]*protocol: Protocol::(\w+)/g)];
		expect(known.map((m) => m[1])).toEqual(['codex', 'gemini', 'qwen', 'opencode', 'goose', 'grok', 'omp']);
		const runtimes: RuntimeInfo[] = known.map(([, id, name, p]) => ({ id, name, protocol: p.toLowerCase() as RuntimeInfo['protocol'], features: { rewind: false, models: true }, custom: false }));
		const cat = agentCatalog(runtimes);
		for (const r of runtimes) {
			const e = catalogEntry(cat, r.id)!;
			expect([r.id, e.cliProfile?.id, e.chatRuntime?.id, e.surfaces]).toEqual([r.id, r.id, r.id, ['ide', 'ade']]);
		}
		// Every other profile stays CLI-only: a runtime is never invented for it.
		for (const e of cat) if (!runtimes.some((r) => r.id === e.id) && e.id !== 'claude') expect([e.id, e.chatRuntime]).toEqual([e.id, undefined]);
	});

	test('onSurface splits the catalog', () => {
		const cat = agentCatalog(RUNTIMES);
		expect(onSurface(cat, 'ade').length).toBe(PROFILES.length);
		expect(onSurface(cat, 'ide').map((e) => e.id)).toEqual(['claude', 'codex', 'gemini', 'arkai', 'mine']);
	});
});
