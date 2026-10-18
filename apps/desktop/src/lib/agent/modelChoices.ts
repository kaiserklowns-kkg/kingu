// The chat's model picker (VS Code's model picker), pure so `bun test` covers it: the models the
// SDK lists (`supportedModels()`, the last list any session reported, cached), else Claude's
// aliases; plus the chat's own model and the settings default when the list lacks them.

import type { ModelOption } from './events';

/** Shown until a session has listed its models. */
export const FALLBACK_MODELS: readonly ModelOption[] = [
	{ value: 'opus', display_name: 'Opus', description: '' },
	{ value: 'sonnet', display_name: 'Sonnet', description: '' },
	{ value: 'haiku', display_name: 'Haiku', description: '' }
];

export type ModelChoice = { value: string; label: string; description: string };

/** The picker's rows: `current` and `fallbackDefault` first when not listed, then the list (or the aliases). */
export function modelChoices(current: string | null | undefined, fallbackDefault: string | null | undefined, listed: readonly ModelOption[]): ModelChoice[] {
	const list = listed.length ? listed : FALLBACK_MODELS;
	const out: ModelChoice[] = [];
	const seen = new Set<string>();
	const add = (value: string, label: string, description: string) => {
		if (!value || seen.has(value)) return;
		seen.add(value);
		out.push({ value, label: label || value, description });
	};
	for (const m of [current, fallbackDefault]) if (m && !list.some((o) => o.value === m)) add(m, m, '');
	for (const o of list) add(o.value, o.display_name, o.description);
	return out;
}

/** A cached list read back (localStorage): only well-formed rows. */
export function parseCachedModels(raw: string | null): ModelOption[] {
	if (!raw) return [];
	try {
		const v: unknown = JSON.parse(raw);
		if (!Array.isArray(v)) return [];
		return v
			.filter((m): m is ModelOption => !!m && typeof m === 'object' && typeof m.value === 'string' && !!m.value && typeof m.display_name === 'string')
			.map((m) => ({ value: m.value, display_name: m.display_name, description: typeof m.description === 'string' ? m.description : '' }));
	} catch {
		return [];
	}
}
