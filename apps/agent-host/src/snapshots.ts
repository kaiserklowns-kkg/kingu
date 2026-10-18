// Snapshots before file edits (VS Code's chat editing session): a PreToolUse hook reads the file
// an edit tool is about to change and sends its prior content to the app as a `file_snapshot`
// event, so the chat's working set can show the diff and Undo it. Hooks run in every permission
// mode (canUseTool is skipped in acceptEdits), and the SDK waits for the hook before the tool runs.
//
// Only files inside the run's cwd are read; a symlink or a path outside it is reported as
// skipped (the app lists it without Undo). Rust validates the path again before storing.

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import type { HookCallbackMatcher, HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from './protocol.ts';

/** Tools that write files, and the input field holding the path. */
export const EDIT_TOOLS: Readonly<Record<string, string>> = { Edit: 'file_path', MultiEdit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' };
/** Files this large are not snapshotted (Rust has the same limit). */
export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export type FileSnapshot = Extract<AgentEvent, { kind: 'file_snapshot' }>;

/** The edited file's path from a tool input, absolute (relative ones are taken from `cwd`). */
export function editPath(tool: string, input: unknown, cwd: string): string | null {
	const field = EDIT_TOOLS[tool];
	if (!field || !input || typeof input !== 'object') return null;
	const raw = (input as Record<string, unknown>)[field];
	if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) return null;
	return normalize(isAbsolute(raw) ? raw : join(cwd, raw));
}

const inside = (dir: string, path: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** The nearest existing ancestor of `path`, resolved. */
function realAncestor(path: string): string | null {
	let at = path;
	for (;;) {
		try {
			return realpathSync(at);
		} catch {
			const up = dirname(at);
			if (up === at) return null;
			at = up;
		}
	}
}

/** Reads the file's current state for a snapshot event (never throws). */
export function snapshotOf(tool: string, toolUseId: string, path: string, cwd: string): FileSnapshot {
	const base = { kind: 'file_snapshot' as const, tool_use_id: toolUseId, tool, path, existed: false, size: 0, content_b64: null, skipped: null };
	let root: string;
	try {
		root = realpathSync(cwd);
	} catch {
		return { ...base, skipped: 'outside' };
	}
	const parent = realAncestor(dirname(path));
	if (!inside(normalize(cwd), path) && !inside(root, path)) return { ...base, skipped: 'outside' };
	if (!parent || !inside(root, parent)) return { ...base, skipped: 'outside' };
	let st;
	try {
		st = lstatSync(path);
	} catch {
		return base; // does not exist yet: the tool creates it
	}
	if (st.isSymbolicLink()) return { ...base, existed: true, skipped: 'symlink' };
	if (!st.isFile()) return { ...base, existed: true, skipped: 'unreadable' };
	if (st.size >= MAX_SNAPSHOT_BYTES) return { ...base, existed: true, size: st.size, skipped: 'too_large' };
	try {
		const bytes = readFileSync(path);
		return { ...base, existed: true, size: bytes.length, content_b64: Buffer.from(bytes).toString('base64') };
	} catch {
		return { ...base, existed: true, size: st.size, skipped: 'unreadable' };
	}
}

/** The SDK `hooks` option: a PreToolUse hook on the edit tools that emits a snapshot first. */
export function snapshotHooks(cwd: string, emit: (ev: FileSnapshot) => void, log: (line: string) => void = () => {}): Partial<Record<'PreToolUse', HookCallbackMatcher[]>> {
	return {
		PreToolUse: [
			{
				matcher: Object.keys(EDIT_TOOLS).join('|'),
				hooks: [
					async (input: HookInput, toolUseID) => {
						try {
							if (input.hook_event_name !== 'PreToolUse') return {};
							const path = editPath(input.tool_name, input.tool_input, input.cwd || cwd);
							if (path) emit(snapshotOf(input.tool_name, toolUseID ?? input.tool_use_id ?? '', path, cwd));
						} catch (e) {
							// A snapshot must never stop the edit.
							log(`snapshot failed: ${e instanceof Error ? e.name : 'error'}`);
						}
						return {};
					}
				]
			}
		]
	};
}
