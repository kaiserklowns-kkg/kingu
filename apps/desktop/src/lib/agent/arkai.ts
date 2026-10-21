// Arkai's providers and models for the chat's model picker (Rust `agent/arkai.rs`,
// `arkai_providers`): the user's providers from `kingu.arkai.providers`, plus a local Ollama
// when it answers. A chat on Arkai keeps its model as `<provider>/<model>`. Pure, so `bun test`
// covers it.

import { t } from '#lib/i18n/index.ts';

export type ArkaiModel = { id: string; name?: string; contextWindow?: number; maxTokens?: number; light?: boolean };
export type ArkaiProviderInfo = {
	id: string;
	name: string;
	api: 'openai' | 'anthropic';
	base_url: string;
	local: boolean;
	has_key: boolean;
	implicit: boolean;
	models: ArkaiModel[];
	error: string | null;
};

export const ARKAI_RUNTIME = 'arkai';
/** The agent host's window for a model nobody describes, and light mode's limit (arkai/spec.ts). */
const DEFAULT_CONTEXT_WINDOW = 32_768;
const LIGHT_CONTEXT_WINDOW = 16_384;

/** Whether Arkai runs the model in light mode: its setting, else a small context window (as the agent host decides). */
export function arkaiLight(m: ArkaiModel): boolean {
	return m.light ?? (m.contextWindow ?? DEFAULT_CONTEXT_WINDOW) <= LIGHT_CONTEXT_WINDOW;
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The chat's model value for a provider's model. */
export const arkaiModelValue = (provider: string, model: string) => `${provider}/${model}`;

/** `provider/model` split (the model id may itself hold `/`, as OpenRouter's do); null for another kind of value. */
export function splitArkaiModel(value: string | null | undefined): { provider: string; model: string } | null {
	const at = value?.indexOf('/') ?? -1;
	if (!value || at <= 0) return null;
	const provider = value.slice(0, at);
	const model = value.slice(at + 1);
	return PROVIDER_ID.test(provider) && model.trim() ? { provider, model } : null;
}

/** The Rust list, checked loosely (an unexpected entry is dropped). */
export function parseArkaiProviders(v: unknown): ArkaiProviderInfo[] {
	if (!Array.isArray(v)) return [];
	return v.flatMap((p): ArkaiProviderInfo[] => {
		if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !PROVIDER_ID.test(p.id) || typeof p.name !== 'string') return [];
		const models = (Array.isArray(p.models) ? p.models : []).filter((m: unknown): m is ArkaiModel => !!m && typeof m === 'object' && typeof (m as ArkaiModel).id === 'string' && !!(m as ArkaiModel).id);
		return [
			{
				id: p.id,
				name: p.name,
				api: p.api === 'anthropic' ? 'anthropic' : 'openai',
				base_url: typeof p.base_url === 'string' ? p.base_url : '',
				local: p.local === true,
				has_key: p.has_key === true,
				implicit: p.implicit === true,
				models,
				error: typeof p.error === 'string' ? p.error : null
			}
		];
	});
}

export type ArkaiChoice = { value: string; label: string; description: string };
export type ArkaiGroup = { provider: string; label: string; models: ArkaiChoice[] };

/**
 * The picker's groups: one per provider with models, and the chat's own model in a group of its
 * own when no provider lists it (a provider removed since, or a model typed into settings).
 */
export function arkaiGroups(providers: readonly ArkaiProviderInfo[], current: string | null | undefined): ArkaiGroup[] {
	const groups: ArkaiGroup[] = providers
		.filter((p) => p.models.length)
		.map((p) => ({
			provider: p.id,
			label: p.name,
			models: p.models.map((m) => ({
				value: arkaiModelValue(p.id, m.id),
				label: m.name || m.id,
				description: [m.id, m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k` : '', arkaiLight(m) ? t('arkai.picker.light') : ''].filter(Boolean).join(' · ')
			}))
		}));
	const split = splitArkaiModel(current);
	if (current && split && !groups.some((g) => g.models.some((m) => m.value === current))) {
		groups.unshift({ provider: split.provider, label: split.provider, models: [{ value: current, label: split.model, description: current }] });
	}
	return groups;
}

/** The model a new Arkai chat starts on: `current` when it is an Arkai model, else the first one listed. */
export function arkaiDefault(providers: readonly ArkaiProviderInfo[], current: string | null | undefined): string | null {
	if (splitArkaiModel(current)) return current!;
	const p = providers.find((x) => x.models.length);
	return p ? arkaiModelValue(p.id, p.models[0]!.id) : null;
}

/** A provider that needs a key it does not have (a remote one, set up by the user). */
export const needsKey = (p: ArkaiProviderInfo) => !p.local && !p.has_key;
