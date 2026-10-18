// The open editors of a folder, kept per folder in localStorage so reopening it (or restarting
// Kingu) brings its files back, like VS Code's workspace-scoped editor state. Pure.

export type OpenEditorsState = { paths: string[]; active: string | null };

/** Workspace files only: diffs, the Settings editor, settings.json and ADE pages are not restored. */
export const isRestorable = (path: string) => !path.includes(':') && path.trim() !== '';

export function openEditorsState(tabs: readonly { path: string }[], active: string | null): OpenEditorsState {
	const paths = [...new Set(tabs.map((t) => t.path).filter(isRestorable))];
	return { paths, active: active && paths.includes(active) ? active : (paths.at(-1) ?? null) };
}

export function parseOpenEditors(raw: unknown): OpenEditorsState | null {
	if (!raw || typeof raw !== 'object') return null;
	const { paths, active } = raw as Record<string, unknown>;
	if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) return null;
	const kept = paths.filter(isRestorable);
	return { paths: kept, active: typeof active === 'string' && kept.includes(active) ? active : (kept.at(-1) ?? null) };
}

/** `workbench.startupEditor: readme`: the folder's README, like VS Code's readme startup editor. */
export function readmeOf(names: readonly string[]): string | null {
	const order = ['readme.md', 'readme.markdown', 'readme.txt', 'readme', 'readme.rst'];
	for (const want of order) {
		const hit = names.find((n) => n.toLowerCase() === want);
		if (hit) return hit;
	}
	return null;
}
