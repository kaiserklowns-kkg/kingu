// The `kingu` command's requests as the window sees them (Rust cli_server.rs checks them first):
// pure helpers for cliBridge.svelte.ts.

export type CliRequest = { id: number; method: string; params: Record<string, unknown> };

/** `dispatchedBy`: the task whose agent asked (Rust checked the orchestration depth). */
export type CreateParams = { title: string; prompt: string; base: string | null; mode: 'terminal' | 'timeline' | null; open: boolean; dispatchedBy?: string | null };
export type OpenParams = { path: string; kind: 'file' | 'folder'; line: number | null; column: number | null };

/** What `kingu open` does here: open a folder, a file of the open folder, or refuse. */
export type OpenTarget = { kind: 'folder'; path: string } | { kind: 'file'; rel: string; line: number | null; column: number | null } | { error: 'noFolder' | 'outside' };

export function openTarget(root: string | null, p: OpenParams): OpenTarget {
	if (p.kind === 'folder') return { kind: 'folder', path: p.path };
	if (!root) return { error: 'noFolder' };
	const base = root.replace(/\/+$/, '') + '/';
	if (!p.path.startsWith(base) || p.path.length === base.length) return { error: 'outside' };
	return { kind: 'file', rel: p.path.slice(base.length), line: p.line ?? null, column: p.column ?? null };
}

/** `kingu [options] [paths…]` (VS Code's `code`) as Rust hands it to the window it picked. */
export type EditorParams = {
	/** Folders to open (`folderMode` open), add or remove; null: the window has them already. */
	folders: string[];
	folderMode: 'open' | 'add' | 'remove' | null;
	mode: 'open' | 'diff' | 'merge' | 'add' | 'remove';
	files: { path: string; line: number | null; column: number | null }[];
	/** `--wait`: report `cli_wait_done` with this id once every editor opened here is closed. */
	waitId: number | null;
	profile: string | null;
};

/** One editor to open for an editor request: a file (at a position) or a compare of two. */
export type EditorOpen = { kind: 'file'; key: string; line: number | null; column: number | null } | { kind: 'compare'; left: string; right: string };

/**
 * The editors an editor request opens, by key (`keyFor`: the window's editor key of an absolute
 * path). `-d a b`: a compare of a and b. `-m a b base result`: the result file, after a compare of
 * the two versions (Kingu's merge editor works on git's conflict stages only).
 */
export function editorOpens(p: Pick<EditorParams, 'mode' | 'files'>, keyFor: (absolute: string) => string): EditorOpen[] {
	const key = (i: number) => keyFor(p.files[i].path);
	if (p.mode === 'diff' && p.files.length === 2) return [{ kind: 'compare', left: key(0), right: key(1) }];
	if (p.mode === 'merge' && p.files.length === 4) return [{ kind: 'compare', left: key(0), right: key(1) }, { kind: 'file', key: key(3), line: null, column: null }];
	return p.files.map((f) => ({ kind: 'file', key: keyFor(f.path), line: f.line ?? null, column: f.line ? (f.column ?? 1) : null }));
}

/** Whether every editor a `--wait` waits on is closed (none open among `open`). */
export const waitOver = (waitedOn: readonly string[], open: Iterable<string>): boolean => {
	const set = new Set(open);
	return waitedOn.every((k) => !set.has(k));
};

/**
 * The profile `--profile <name>` names: null for the Default profile (by its name), a profile's
 * id (exact name first, else the only case-insensitive match), undefined when there is none.
 */
export function profileFor(profiles: readonly { id: string; name: string }[], name: string, defaultName: string): string | null | undefined {
	const wanted = name.trim();
	const exact = profiles.find((p) => p.name === wanted);
	if (exact) return exact.id;
	if (wanted.toLowerCase() === defaultName.toLowerCase()) return null;
	const loose = profiles.filter((p) => p.name.toLowerCase() === wanted.toLowerCase());
	return loose.length === 1 ? loose[0].id : undefined;
}

/** The folder that holds an installed link (`/usr/local/bin/kingu` → `/usr/local/bin`). */
export const dirOf = (path: string): string => path.replace(/\/[^/]*$/, '') || '/';
