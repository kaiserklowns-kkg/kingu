// The Loaded Scripts view (VS Code: loadedScriptsView.ts): the sources a debug session has loaded,
// kept current by `loadedSource` events, as a tree of folders (workspace-relative inside the
// folder, else by their absolute path or the adapter's name). Pure, so the event handling and the
// tree are unit-tested.

import type { Source } from './protocol.ts';

/** A source's identity: its path, else the adapter's reference, else its name. */
export const sourceKey = (s: Source) => (s.path ? `p:${s.path}` : s.sourceReference ? `r:${s.sourceReference}` : `n:${s.name ?? ''}`);

/** A `loadedSource` event (reason `new`, `changed` or `removed`) applied to the list. */
export function applyLoadedSource(list: readonly Source[], reason: string, source: Source): Source[] {
	const key = sourceKey(source);
	const rest = list.filter((s) => sourceKey(s) !== key);
	if (reason === 'removed') return rest.length === list.length ? [...list] : rest;
	// `changed` keeps the source's place; `new` (again) moves it last.
	if (reason === 'changed' && rest.length < list.length) return list.map((s) => (sourceKey(s) === key ? source : s));
	return [...rest, source];
}

export type ScriptNode =
	| { kind: 'folder'; id: string; label: string; children: ScriptNode[] }
	| { kind: 'source'; id: string; label: string; source: Source; rel: string | null; description?: string };

/**
 * The tree: sources under the workspace by their folders, the others grouped under their
 * directory (absolute paths) or under the adapter's virtual root (`<node_internals>`, `eval`…).
 * Folders with one child folder fold together (`src/lib`) like VS Code's compressed tree.
 */
export function scriptTree(sources: readonly Source[], root: string, filter = ''): ScriptNode[] {
	const q = filter.trim().toLowerCase();
	const prefix = root ? (root.endsWith('/') ? root : `${root}/`) : null;
	type Dir = { dirs: Map<string, Dir>; files: ScriptNode[] };
	const top: Dir = { dirs: new Map(), files: [] };
	const seen = new Set<string>();
	for (const s of sources) {
		const key = sourceKey(s);
		if (seen.has(key)) continue;
		seen.add(key);
		const rel = s.path && prefix && s.path.startsWith(prefix) ? s.path.slice(prefix.length) : null;
		const shown = rel ?? s.path ?? s.name ?? '';
		if (q && !shown.toLowerCase().includes(q)) continue;
		const parts = shown.split('/').filter(Boolean);
		const label = parts.pop() ?? shown;
		// Outside the folder: one group per top directory (`/usr`, `<node_internals>`), so the workspace comes first.
		let dir = top;
		for (const p of rel === null && s.path ? ['/', ...parts] : parts) {
			let next = dir.dirs.get(p);
			if (!next) dir.dirs.set(p, (next = { dirs: new Map(), files: [] }));
			dir = next;
		}
		dir.files.push({ kind: 'source', id: key, label, source: s, rel, description: rel === null && s.path ? s.path.slice(0, s.path.lastIndexOf('/')) : undefined });
	}
	const build = (d: Dir, path: string): ScriptNode[] => {
		const folders: ScriptNode[] = [...d.dirs.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, sub]) => {
				let label = name;
				let at = sub;
				let id = `${path}/${name}`;
				// Compress chains of single folders.
				while (at.files.length === 0 && at.dirs.size === 1) {
					const [n, s] = [...at.dirs.entries()][0];
					label = label === '/' ? `/${n}` : `${label}/${n}`;
					id = `${id}/${n}`;
					at = s;
				}
				return { kind: 'folder' as const, id, label, children: build(at, id) };
			});
		const files = [...d.files].sort((a, b) => a.label.localeCompare(b.label));
		return [...folders, ...files];
	};
	// Workspace folders first, then the `/` and virtual groups.
	const nodes = build(top, '');
	const outside = (n: ScriptNode) => n.kind === 'folder' && (n.label.startsWith('/') || n.label.startsWith('<'));
	return [...nodes.filter((n) => !outside(n)), ...nodes.filter(outside)];
}

/** How many sources a tree shows. */
export function countSources(nodes: readonly ScriptNode[]): number {
	return nodes.reduce((n, x) => n + (x.kind === 'source' ? 1 : countSources(x.children)), 0);
}
