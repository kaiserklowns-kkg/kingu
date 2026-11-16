// A worktree on an SSH host, opened as a folder: the shapes Rust's ssh_remote.rs returns, how its
// git changes are grouped, and how an agent running there over `ssh -t` gets its status from the
// terminal (title, output timing). Pure, so `bun test` covers it; the store is sshWorkspace.svelte.ts.

import { isWorking } from './agentCli';
import { applyHook, initialHookState, needsInput, type HookState } from './agentHooks';
import { hookFresh } from './agentPresence';
import { applyTitle, type TitleTrack } from './agentTitle';
import type { TaskStatus } from './model';

export type RemoteEntry = { name: string; dir: boolean };
export type RemoteListing = { entries: RemoteEntry[]; truncated: boolean };
export type RemoteFile = { size: number; text: string | null; binary: boolean; too_large: boolean };
export type RemoteChange = { path: string; orig: string | null; x: string; y: string };
export type RemoteStatus = { branch: string | null; upstream: string | null; ahead: number; behind: number; changes: RemoteChange[] };
export type RemoteDiff = { original: string; modified: string; binary: boolean; too_large: boolean };
export type RemoteBranches = { branches: string[]; default: string | null };
export type RemoteHits = { hits: { path: string; line: number; text: string }[]; truncated: boolean };
export type RemotePoll = { status: RemoteStatus; sum: string | null };
export type SparsePreset = { id: string; name: string; directories: string[] };

/** A row of Source Control: one file in one group. */
export type ChangeRow = { path: string; orig: string | null; letter: string; staged: boolean };

const CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * git's XY letters → the Staged and Changes groups (as VS Code's and Orca's Source Control do):
 * untracked files and worktree edits are Changes, index edits are Staged; a file in both shows
 * twice; a merge conflict shows once, under Changes, as `!`.
 */
export function groupChanges(changes: readonly RemoteChange[]): { staged: ChangeRow[]; unstaged: ChangeRow[] } {
	const staged: ChangeRow[] = [];
	const unstaged: ChangeRow[] = [];
	for (const c of changes) {
		if (CONFLICT.has(c.x + c.y)) {
			unstaged.push({ path: c.path, orig: c.orig, letter: '!', staged: false });
			continue;
		}
		if (c.x === '?') {
			unstaged.push({ path: c.path, orig: null, letter: 'U', staged: false });
			continue;
		}
		if (c.x !== ' ' && c.x !== '!') staged.push({ path: c.path, orig: c.orig, letter: c.x, staged: true });
		if (c.y !== ' ' && c.y !== '!') unstaged.push({ path: c.path, orig: c.orig, letter: c.y, staged: false });
	}
	const byPath = (a: ChangeRow, b: ChangeRow) => a.path.localeCompare(b.path);
	return { staged: staged.sort(byPath), unstaged: unstaged.sort(byPath) };
}

/** `a/b/c.ts` + `d` → `a/b/c.ts/d`; the top (`''`) + `d` → `d`. */
export const joinRel = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** A worktree's key in the store (the same path can live on two hosts). */
export const worktreeKey = (host: string, path: string) => `${host}\u0000${path}`;

/** Comma or newline separated folders typed for a sparse checkout, trimmed, without empties. */
export function parseFolders(text: string): string[] {
	return [
		...new Set(
			text
				.split(/[,\n]/)
				.map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
				.filter(Boolean)
		)
	];
}

/** Base branches offered for a new task: origin's default first, then git's order (local, then remote-tracking). */
export function baseChoices(b: RemoteBranches): string[] {
	return [...(b.default ? [b.default] : []), ...b.branches.filter((x) => x !== b.default)];
}

/**
 * An agent CLI running in an SSH terminal. Orca gets its state from hooks posting to a relay on
 * the host, with the program's own report in the terminal stream as the fallback "for a fresh SSH
 * host" (src/main/agent-hooks/README.md: hooks win). Kingu: a claude on the host gets per-session
 * hooks appending to a file there, read over ssh (`hook`); the terminal title the way local
 * terminals are read (agentTitle.ts), then output timing, fill in when hooks say nothing.
 */
export type RemoteAgent = { title?: TitleTrack; hook?: HookState; hookToken?: string; hookOffset?: number; lastOutput?: number; closed?: boolean; startedAt: number };

export const remoteAgentTitle = (a: RemoteAgent, title: string, now: number): RemoteAgent => ({ ...a, title: applyTitle(a.title, title, now) });

export const remoteAgentHooks = (a: RemoteAgent, events: readonly object[], offset: number, now: number): RemoteAgent => ({
	...a,
	hookOffset: offset,
	hook: events.reduce<HookState>((st, ev) => applyHook(st, ev, now), a.hook ?? initialHookState(now))
});

/** The agent's status as a task card shows it, or null once it quit (or its tab closed). */
export function remoteAgentStatus(a: RemoteAgent, now: number): TaskStatus | null {
	if (a.closed) return null;
	const h = a.hook;
	if (h?.hooks) {
		if (h.phase === 'ended') return null;
		if (h.phase !== 'starting' && hookFresh(h, now)) return needsInput(h) ? 'waiting' : h.phase === 'working' ? 'running' : 'review';
	}
	if (a.title?.exited) return null;
	const s = a.title?.status;
	if (s === 'permission') return 'waiting';
	if (s === 'working') return 'running';
	if (s === 'idle') return 'review';
	return isWorking(a.lastOutput, now) || (a.lastOutput === undefined && now - a.startedAt < 10_000) ? 'running' : 'review';
}
