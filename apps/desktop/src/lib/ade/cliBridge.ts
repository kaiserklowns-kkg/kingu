// The `kingu` command's requests as the window sees them (Rust cli_server.rs checks them first):
// pure helpers for cliBridge.svelte.ts.

export type CliRequest = { id: number; method: string; params: Record<string, unknown> };

export type CreateParams = { title: string; prompt: string; base: string | null; mode: 'terminal' | 'timeline' | null; open: boolean };
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

/** The folder that holds an installed link (`/usr/local/bin/kingu` → `/usr/local/bin`). */
export const dirOf = (path: string): string => path.replace(/\/[^/]*$/, '') || '/';
