// User keybindings (VS Code: keybindings.json). Pure: parsing and how user entries change a
// command's default key. `{ "key": "cmd+i", "command": "x" }` adds a key; `"-x"` removes x's
// default (or only the given key). `when` clauses are not evaluated: an entry with one is kept
// and applies everywhere the command's own condition allows.

import { parseJsonc } from '#lib/settings/jsonc.ts';

export type KeybindingEntry = { key?: string; command: string; when?: string };
export type UserKeybindings = { added: ReadonlyMap<string, string[]>; removed: ReadonlyMap<string, ReadonlySet<string> | 'all'> };

export const NO_USER_KEYBINDINGS: UserKeybindings = { added: new Map(), removed: new Map() };

/** `cmd+shift+P  cmd+k` → `cmd+shift+p cmd+k`. */
export const normalizeKey = (key: string) =>
	key
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.join(' ');

/** Parses keybindings.json: an array of entries; anything else is an error for the caller to show. */
export function parseKeybindings(text: string): KeybindingEntry[] {
	if (!text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) return [];
	const value = parseJsonc<unknown>(text);
	if (!Array.isArray(value)) throw new Error('keybindings.json must be a JSON array');
	return value.filter((e): e is KeybindingEntry => !!e && typeof e === 'object' && typeof (e as KeybindingEntry).command === 'string');
}

export function userKeybindings(entries: readonly KeybindingEntry[]): UserKeybindings {
	const added = new Map<string, string[]>();
	const removed = new Map<string, Set<string> | 'all'>();
	for (const e of entries) {
		const key = typeof e.key === 'string' ? normalizeKey(e.key) : '';
		if (e.command.startsWith('-')) {
			const id = e.command.slice(1);
			if (!key) removed.set(id, 'all');
			else if (removed.get(id) !== 'all') removed.set(id, new Set([...((removed.get(id) as Set<string> | undefined) ?? []), key]));
			// A later removal also drops an earlier user key, like VS Code's ordered resolution.
			if (added.has(id)) added.set(id, key ? added.get(id)!.filter((k) => k !== key) : []);
		} else if (key) {
			// Later entries win: the newest key comes first (it is the one menus show).
			added.set(e.command, [key, ...(added.get(e.command) ?? []).filter((k) => k !== key)]);
		}
	}
	return { added, removed };
}

/** The keys that run `id`: the user's own first, then the default unless it was removed. */
export function keysFor(id: string, defaultKey: string | undefined, user: UserKeybindings): string[] {
	const out = [...(user.added.get(id) ?? [])];
	const removed = user.removed.get(id);
	const def = defaultKey && normalizeKey(defaultKey);
	if (def && removed !== 'all' && !removed?.has(def) && !out.includes(def)) out.push(def);
	return out;
}

/** A starter file like VS Code's, with the format explained. */
export const KEYBINDINGS_TEMPLATE = `// วางคีย์ลัดของคุณที่นี่ เพื่อเขียนทับคีย์ลัดเริ่มต้น (Place your key bindings in this file to override the defaults.)
// { "key": "cmd+i", "command": "workbench.action.quickOpen" } เพิ่มคีย์ / "-workbench.action.quickOpen" ลบคีย์เริ่มต้น
[
]
`;
