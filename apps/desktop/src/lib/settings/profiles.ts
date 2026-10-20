// Profiles (VS Code's user data profiles, settings and keybindings): pure helpers, so bun tests
// can check them. The store is profiles.svelte.ts; Rust keeps the files (user_profiles.rs).

import type { SettingSchema } from './registry';

export type Profile = { id: string; name: string };
/** Mirrors Rust `ProfileList`: `active` null is the Default profile. */
export type ProfileList = { active: string | null; profiles: Profile[] };

export const DEFAULT_PROFILE_NAME = 'Default';

/** Application-scoped settings apply to every profile from the Default profile's file (VS Code). */
export const isApplicationScoped = (s: SettingSchema | undefined) => s?.scope === 'application';

/**
 * The user layer with a profile active: the profile's values, except application-scoped settings,
 * which come from the Default profile's settings.json (and are ignored in the profile's own).
 */
export function profileUserValues(profile: Record<string, unknown>, defaults: Record<string, unknown>, schemas: SettingSchema[]): Record<string, unknown> {
	const app = new Set(schemas.filter(isApplicationScoped).map((s) => s.id));
	const out: Record<string, unknown> = {};
	for (const [id, v] of Object.entries(profile)) if (!app.has(id)) out[id] = v;
	for (const [id, v] of Object.entries(defaults)) if (app.has(id)) out[id] = v;
	return out;
}

/** The active profile's name for `${profileName}` in the window title: empty for Default (VS Code). */
export function activeProfileName(list: ProfileList): string {
	return list.profiles.find((p) => p.id === list.active)?.name ?? '';
}
