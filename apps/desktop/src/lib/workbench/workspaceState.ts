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
