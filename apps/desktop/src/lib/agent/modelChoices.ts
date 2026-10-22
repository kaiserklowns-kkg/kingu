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

export type ModelChoice = { value: string; resolved_model?: string; label: string; description: string };

/** The picker's rows: `current` and `fallbackDefault` first when not listed, then the list (or the aliases). */
export function modelChoices(current: string | null | undefined, fallbackDefault: string | null | undefined, listed: readonly ModelOption[]): ModelChoice[] {
	const list = listed.length ? listed : FALLBACK_MODELS;
	const out: ModelChoice[] = [];
	const seen = new Set<string>();
	const add = (value: string, label: string, description: string, resolved_model?: string) => {
		if (!value || seen.has(value)) return;
		seen.add(value);
		out.push({ value, ...(resolved_model ? { resolved_model } : {}), label: label || value, description });
	};
	// A model id the list does not name (the chat's own, the settings default): its friendly name,
	// the id under it.
	for (const m of [current, fallbackDefault]) if (m && !list.some((o) => o.value === m || o.resolved_model === m)) add(m, friendlyModel(m), m);
	for (const o of list) add(o.value, o.display_name, o.description, o.resolved_model);
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
			.map((m) => ({ value: m.value, ...(typeof m.resolved_model === 'string' ? { resolved_model: m.resolved_model } : {}), display_name: m.display_name, description: typeof m.description === 'string' ? m.description : '', ...(Array.isArray(m.effort_levels) ? { effort_levels: m.effort_levels.filter((x) => typeof x === 'string') } : {}) }));
	} catch {
		return [];
	}
}

/**
 * A Claude model id as people say it: `claude-opus-5-5` → "Opus 5.5", `claude-sonnet-4-5-20250929`
 * → "Sonnet 4.5", `opus` → "Opus". Anything else stays as it is.
 */
export function friendlyModel(id: string): string {
	const m = /^(?:claude-)?(opus|sonnet|haiku)((?:-\d{1,2})*)(?:-\d{8})?(\[1m\])?$/i.exec(id.trim());
	if (!m) return id;
	const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
	const version = m[2] ? m[2].slice(1).split('-').join('.') : '';
	return [family, version, m[3] ? '1M' : ''].filter(Boolean).join(' ');
}

/** A picker row's second line: the description, else the id, but never one that repeats the label (any case). */
export function modelSublabel(choice: ModelChoice): string | undefined {
	const label = choice.label.trim().toLowerCase();
	return [choice.description, choice.value].find((d) => !!d && d.trim().toLowerCase() !== label) || undefined;
}
