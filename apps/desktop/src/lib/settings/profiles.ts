// Profiles (VS Code's user data profiles, settings and keybindings): pure helpers, so bun tests
// can check them. The store is profiles.svelte.ts; Rust keeps the files (user_profiles.rs).

import type { SettingSchema } from './registry';

export type Profile = { id: string; name: string; transient?: boolean };
/** Mirrors Rust `ProfileList`: `active` is the window's profile, null for Default. */
export type ProfileList = { active: string | null; profiles: Profile[]; associations?: Record<string, string> };

export const DEFAULT_PROFILE_NAME = 'Default';

/** Application-scoped settings apply to every profile from the Default profile's file (VS Code). */
export const isApplicationScoped = (s: SettingSchema | undefined) => s?.scope === 'application';

export const APPLY_TO_ALL_PROFILES = 'workbench.settings.applyToAllProfiles';

/** `workbench.settings.applyToAllProfiles` from the Default profile's settings.json (it is application-scoped). */
export function applyToAllProfiles(defaults: Record<string, unknown>): Set<string> {
	const list = defaults[APPLY_TO_ALL_PROFILES];
	return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
}

/** Whether `id` lives in the Default profile's file for every profile: application-scoped, or
 * listed in `workbench.settings.applyToAllProfiles`. */
export function sharedByAllProfiles(id: string, schema: SettingSchema | undefined, defaults: Record<string, unknown>): boolean {
	return isApplicationScoped(schema) || applyToAllProfiles(defaults).has(id);
}

/**
 * The user layer with a profile active: the profile's values, except settings shared by all
 * profiles (application-scoped ones and `workbench.settings.applyToAllProfiles`), which come from
 * the Default profile's settings.json (and are ignored in the profile's own).
 */
export function profileUserValues(profile: Record<string, unknown>, defaults: Record<string, unknown>, schemas: SettingSchema[]): Record<string, unknown> {
	const shared = new Set([...schemas.filter(isApplicationScoped).map((s) => s.id), ...applyToAllProfiles(defaults)]);
	const out: Record<string, unknown> = {};
	for (const [id, v] of Object.entries(profile)) if (!shared.has(id)) out[id] = v;
	for (const [id, v] of Object.entries(defaults)) if (shared.has(id)) out[id] = v;
	return out;
}

/** The active profile's name for `${profileName}` in the window title: empty for Default (VS Code). */
export function activeProfileName(list: ProfileList): string {
	return list.profiles.find((p) => p.id === list.active)?.name ?? '';
}

/** Mirrors Rust `TemplateSummary`: what a `.code-profile` file holds (Import Profile…). */
export type TemplateSummary = { name: string; settings: boolean; keybindings: boolean; snippets: number };

/** The parts of a template, as message keys for Import Profile…'s hint. */
export function templateContents(s: TemplateSummary): { key: 'profiles.partSettings' | 'profiles.partKeybindings' | 'profiles.partSnippets'; count: number }[] {
	return [
		...(s.settings ? [{ key: 'profiles.partSettings' as const, count: 1 }] : []),
		...(s.keybindings ? [{ key: 'profiles.partKeybindings' as const, count: 1 }] : []),
		...(s.snippets ? [{ key: 'profiles.partSnippets' as const, count: s.snippets }] : [])
	];
}
