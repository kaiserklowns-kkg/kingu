// The pure parts of per-workspace UI state (workspaceStorage.svelte.ts), so bun tests cover them.

import { rootTag, storeName } from '#lib/terminal/sessions.ts';

/** The storage name of `base`'s state for workspace `scope` (see workspaceStateKey). */
export const scopedName = (base: string, scope: string) => storeName(base, rootTag(scope));

/** The part of `saved` under `keys`; null when it is not an object or has none of them. */
export function pick(saved: unknown, keys: readonly string[]): Record<string, unknown> | null {
	if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
	const all = saved as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const k of keys) if (Object.hasOwn(all, k)) out[k] = all[k];
	return Object.keys(out).length ? out : null;
}

// --- Cleanup (VS Code's unused workspace storage cleaner)

/** Every workspace whose state this page keeps, by its tag: the workspace and when it was last open. */
export type StorageIndex = Record<string, { scope: string; used: number }>;

/** Workspaces kept at most; the least recently used beyond it lose their state. */
export const MAX_WORKSPACES = 200;

export function parseIndex(raw: unknown): StorageIndex {
	const out: StorageIndex = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
	for (const [tag, v] of Object.entries(raw as Record<string, unknown>)) {
		const e = v as { scope?: unknown; used?: unknown } | null;
		if (/^[0-9a-f]{8}$/.test(tag) && e && typeof e.scope === 'string' && typeof e.used === 'number') out[tag] = { scope: e.scope, used: e.used };
	}
	return out;
}

/** `index` with `scope` open now. */
export const touched = (index: StorageIndex, scope: string, now: number): StorageIndex => ({ ...index, [rootTag(scope)]: { scope, used: now } });

/**
 * The tags whose state goes: the `stale` scopes' (no window can show them again), and the least
 * recently used beyond `max`; never one in `keep` (the windows open now).
 */
export function tagsToDrop(index: StorageIndex, stale: ReadonlySet<string>, keep: ReadonlySet<string>, max = MAX_WORKSPACES): string[] {
	const drop = new Set<string>();
	const live = Object.entries(index).filter(([, e]) => !keep.has(e.scope));
	for (const [tag, e] of live) if (stale.has(e.scope)) drop.add(tag);
	const rest = Object.entries(index).filter(([tag]) => !drop.has(tag));
	if (rest.length > max) {
		const oldest = rest.filter(([, e]) => !keep.has(e.scope)).sort((a, b) => a[1].used - b[1].used);
		for (const [tag] of oldest.slice(0, rest.length - max)) drop.add(tag);
	}
	return [...drop];
}

/** The storage names that belong to `tags` (every per-workspace store is `<base>:<tag>`). */
export function namesOfTags(names: readonly string[], tags: ReadonlySet<string>): string[] {
	return names.filter((n) => {
		const i = n.lastIndexOf(':');
		return i > 0 && tags.has(n.slice(i + 1));
	});
}

/**
 * `defaults` with what `saved` has of the same type over them: what a store shows for a
 * workspace (null `saved`: a workspace it never saw, so all defaults). A `null` default takes
 * any object.
 */
export function withSaved<T extends Record<string, unknown>>(defaults: T, saved: Record<string, unknown> | null): T {
	const out: Record<string, unknown> = { ...defaults };
	for (const [k, d] of Object.entries(defaults)) {
		const v = saved?.[k];
		if (v === undefined) continue;
		if (typeof v === typeof d && Array.isArray(v) === Array.isArray(d)) out[k] = v;
	}
	return out as T;
}
