// Session handoff ADE → IDE chat (docs/AI-SURFACES.md §9): which of a task's CLI sessions an
// agent chat can continue. Only an explicit command does it (the task menu's "Continue in Agent
// Chat…"), and only where the chat runtime resumes from the CLI's own session store: Claude Code's
// CLI and the Claude Agent SDK share `~/.claude/projects`. Codex's app-server and ACP agents keep
// their own, so their sessions are not offered. Nothing moves: the chat gets the session id (as
// AI Vault's Continue here does), the task keeps its own. Pure.

import { profileOf } from '#lib/ade/agentProfiles.ts';
import { sessionProgram, sessionsOf, type SessionRef } from '#lib/ade/sessionHistory.ts';
import { agentCatalog, catalogEntry, type CatalogEntry } from './agentCatalog.ts';

/** CLI profiles whose session store their chat runtime of the same id reads. */
const SHARED_STORE: ReadonlySet<string> = new Set(['claude']);

/** The chat runtime that can continue a session `agent` (a task's `cli:…` agent) ran; null when none can. */
export function chatRuntimeFor(agent: string, catalog: readonly CatalogEntry[] = agentCatalog()): string | null {
	const id = profileOf([sessionProgram(agent)]).id;
	const e = catalogEntry(catalog, id);
	return e && SHARED_STORE.has(id) && e.chatRuntime && e.capabilities.resume ? e.chatRuntime.id : null;
}

/** A task's sessions an agent chat can continue, newest first. */
export function chatHandoffSessions(meta: Parameters<typeof sessionsOf>[0], catalog?: readonly CatalogEntry[]): SessionRef[] {
	return sessionsOf(meta).filter((s) => chatRuntimeFor(s.agent, catalog) !== null);
}
