// User keybindings (VS Code: keybindings.json). Pure: parsing and how user entries change a
// command's default key. `{ "key": "cmd+i", "command": "x" }` adds a key; `"-x"` removes x's
// default (or only the given key). An entry's `when` clause is kept per key and evaluated at key
// time (contextKey.ts), on top of the command's own condition.

import { parseJsonc } from '#lib/settings/jsonc.ts';

export type KeybindingEntry = { key?: string; command: string; when?: string; args?: unknown };
export type UserKeybindings = {
	added: ReadonlyMap<string, string[]>;
	removed: ReadonlyMap<string, ReadonlySet<string> | 'all'>;
	/** `when` of a user key, by `whenKey(command, key)`. */
	when: ReadonlyMap<string, string>;
	/** `args` of a user key, by `whenKey(command, key)`: handed to the command (Insert Snippet's `snippet`). */
	args: ReadonlyMap<string, unknown>;
};

export const whenKey = (command: string, key: string) => `${command}\u0000${normalizeKey(key)}`;

export const NO_USER_KEYBINDINGS: UserKeybindings = { added: new Map(), removed: new Map(), when: new Map(), args: new Map() };

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
	const when = new Map<string, string>();
	const args = new Map<string, unknown>();
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
			if (typeof e.when === 'string' && e.when.trim()) when.set(whenKey(e.command, key), e.when);
			else when.delete(whenKey(e.command, key));
			if (e.args !== undefined) args.set(whenKey(e.command, key), e.args);
			else args.delete(whenKey(e.command, key));
		}
	}
	return { added, removed, when, args };
}

/** The keys that run `id`: the user's own first, then the default unless it was removed. */
export function keysFor(id: string, defaultKey: string | undefined, user: UserKeybindings): string[] {
	const out = [...(user.added.get(id) ?? [])];
	const removed = user.removed.get(id);
	const def = defaultKey && normalizeKey(defaultKey);
	if (def && removed !== 'all' && !removed?.has(def) && !out.includes(def)) out.push(def);
	return out;
}

// --- Layouts (the IDE is VS Code, the Agents layout is Orca)

/** The layout a command's keybinding belongs to; unscoped commands are bound in both. */
export type KeyScope = 'ide' | 'agents';

/** The keys the commands scoped to `layout` own there. */
export function ownedKeys(entries: Iterable<{ scope?: KeyScope; keys: readonly string[] }>, layout: KeyScope): Set<string> {
	const owned = new Set<string>();
	for (const e of entries) if (e.scope === layout) for (const k of e.keys) owned.add(normalizeKey(k));
	return owned;
}

/**
 * The keys of a command that are live in `layout`: none for a command scoped to the other layout,
 * and an unscoped command's default steps aside where a scoped one owns the key (Orca's ⌘T opens
 * a terminal tab in the Agents layout; VS Code's opens Go to Symbol in the IDE). A key the user
 * bound themselves always stays.
 */
export function liveKeys(keys: readonly string[], scope: KeyScope | undefined, layout: KeyScope, owned: ReadonlySet<string>, userKeys: readonly string[] = []): string[] {
	if (scope && scope !== layout) return [];
	if (scope) return [...keys];
	return keys.filter((k) => userKeys.includes(k) || !owned.has(normalizeKey(k)));
}

/** A starter file like VS Code's, with the format explained. */
export const KEYBINDINGS_TEMPLATE = `// วางคีย์ลัดของคุณที่นี่ เพื่อเขียนทับคีย์ลัดเริ่มต้น (Place your key bindings in this file to override the defaults.)
// { "key": "cmd+i", "command": "workbench.action.quickOpen" } เพิ่มคีย์ / "-workbench.action.quickOpen" ลบคีย์เริ่มต้น
[
]
`;
