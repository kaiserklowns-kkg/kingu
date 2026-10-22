// The chat's reasoning effort (old Kingu's "Effort Level" in the model picker,
// modelPickerModelConfig.ts + platform/agentHost/common/reasoningEffort.ts): which levels the
// chat's model takes on its runtime, the one in effect, and the picker's rows. Pure, so
// `bun test` covers it; effortChoice.svelte.ts feeds it the app's state. What each runtime is sent
// for a level: apps/agent-host/src/effort.ts.

import { t } from '#lib/i18n/index.ts';
import type { MenuRow } from './composerMenu.ts';
import type { ModelOption } from './events';
import type { RuntimeProtocol } from './runtimes.ts';

/** Lowest to highest; `off` is old's `none` (no reasoning). */
export const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v);

/** `levels` in scale order, unknown values and repeats dropped. */
export const effortList = (levels: readonly unknown[]): Effort[] => EFFORTS.filter((e) => levels.includes(e));

const LABEL_KEY = {
	off: 'composer.effort.off',
	minimal: 'composer.effort.minimal',
	low: 'composer.effort.low',
	medium: 'composer.effort.medium',
	high: 'composer.effort.high',
	xhigh: 'composer.effort.xhigh',
	max: 'composer.effort.max'
} as const;
const DESCRIPTION_KEY = {
	off: 'composer.effort.offHint',
	minimal: 'composer.effort.minimalHint',
	low: 'composer.effort.lowHint',
	medium: 'composer.effort.mediumHint',
	high: 'composer.effort.highHint',
	xhigh: 'composer.effort.xhighHint',
	max: 'composer.effort.maxHint'
} as const;

/** Old's getReasoningEffortLabel: None, Minimal, Low, Medium, High, Extra High, Max. */
export const effortLabel = (e: Effort) => t(LABEL_KEY[e]);
export const effortDescription = (e: Effort) => t(DESCRIPTION_KEY[e]);

// ---- the levels a model takes ---------------------------------------------------------------

/** Claude Code's levels for a model the SDK has not listed yet (its aliases, a typed id). */
const CLAUDE_GUESS: readonly Effort[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Claude Code: the listed model's `efforts` (SDK `supportedEffortLevels`, `off` first). A model
 * the list does not name: Opus / Sonnet / Fable families take the usual levels; Haiku and
 * anything else none until a session lists it.
 */
export function claudeLevels(model: string | null | undefined, listed: readonly ModelOption[]): Effort[] {
	const id = (model ?? '').trim();
	const row = id ? listed.find((m) => m.value === id) : undefined;
	if (row) return effortList(row.efforts ?? []);
	if (!id) return [...CLAUDE_GUESS];
	return /^(?:claude-)?(?:opus|sonnet|fable)\b/i.test(id) ? [...CLAUDE_GUESS] : [];
}

/** Old's CODEX_REASONING_EFFORTS: until Codex lists the thread model's own (`effort_options`). */
export const CODEX_GUESS: readonly Effort[] = ['minimal', 'low', 'medium', 'high'];

/**
 * Arkai: the reasoning knob a model has at its provider. Mirrors `arkaiEffortKind` in
 * apps/agent-host/src/effort.ts, which turns the level into the request's fields.
 */
export type ArkaiEffortKind = 'anthropic-adaptive' | 'anthropic-budget' | 'openai' | 'openrouter' | 'gemini' | null;

export function arkaiEffortKind(api: 'openai' | 'anthropic', baseUrl: string, model: string): ArkaiEffortKind {
	const m = model.toLowerCase().replace(/^.*\//, '');
	if (/^claude-/.test(m)) {
		if (/^claude-(?:opus|sonnet|haiku)-(?:[5-9]|4-[6-9])/.test(m)) return api === 'anthropic' ? 'anthropic-adaptive' : /openrouter\.ai/i.test(baseUrl) ? 'openrouter' : null;
		if (/^claude-(?:3-7-sonnet|(?:opus|sonnet|haiku)-4)/.test(m)) return api === 'anthropic' ? 'anthropic-budget' : /openrouter\.ai/i.test(baseUrl) ? 'openrouter' : null;
		return null;
	}
	if (api !== 'openai') return null;
	if (/generativelanguage\.googleapis\.com/i.test(baseUrl) && /^gemini-(?:2\.5|[3-9])/.test(m)) return 'gemini';
	if (/^(?:o[1-9](?:-|$)|gpt-5)/.test(m)) return /openrouter\.ai/i.test(baseUrl) ? 'openrouter' : 'openai';
	return null;
}

/** The levels of an Arkai model (`model` is the id at its provider). */
export function arkaiLevels(api: 'openai' | 'anthropic', baseUrl: string, model: string): Effort[] {
	const m = model.toLowerCase().replace(/^.*\//, '');
	switch (arkaiEffortKind(api, baseUrl, model)) {
		case 'anthropic-adaptive':
			return ['off', 'low', 'medium', 'high', 'max'];
		case 'anthropic-budget':
			return ['off', 'low', 'medium', 'high'];
		case 'openai':
			// GPT-5 takes `minimal` too; the o-series low / medium / high.
			return m.startsWith('gpt-5') ? ['minimal', 'low', 'medium', 'high'] : ['low', 'medium', 'high'];
		case 'openrouter':
			return ['off', 'low', 'medium', 'high'];
		case 'gemini':
			// 2.5 Pro cannot think less than a little.
			return /pro/.test(m) ? ['low', 'medium', 'high'] : ['off', 'low', 'medium', 'high'];
		default:
			return [];
	}
}

/** What effortLevels needs to know about the chat. */
export type EffortContext = {
	protocol: RuntimeProtocol;
	/** The chat's model (Claude: an id or alias; Arkai: `provider/model`). */
	model: string | null | undefined;
	/** Claude Code's listed models (modelCatalog). */
	listed: readonly ModelOption[];
	/** Arkai: the provider of the chat's model. */
	arkai?: { api: 'openai' | 'anthropic'; baseUrl: string; model: string } | null;
	/** What the agent itself said last (`effort_options`, Codex and ACP). */
	advertised?: { levels: readonly Effort[]; current: Effort | null } | null;
};

/** The levels the chat's model takes on its runtime; empty: the picker is hidden. */
export function effortLevels(c: EffortContext): Effort[] {
	switch (c.protocol) {
		case 'claude':
			return claudeLevels(c.model, c.listed);
		case 'arkai':
			return c.arkai ? arkaiLevels(c.arkai.api, c.arkai.baseUrl, c.arkai.model) : [];
		case 'codex':
			return c.advertised ? [...c.advertised.levels] : [...CODEX_GUESS];
		case 'acp':
			// Only an agent that advertises a thought level (agent-host acp.ts).
			return c.advertised ? [...c.advertised.levels] : [];
	}
}

/**
 * The level the model runs with when none is picked (old's resolveDefaultReasoningEffort): the
 * agent's own, else `medium` for Claude Opus / Haiku 5.5 and `high` for other Claude models,
 * `off` where thinking is off unless asked (older Claude models on Arkai), `medium` otherwise;
 * the first level when that one is not offered.
 */
export function modelDefault(levels: readonly Effort[], c: Pick<EffortContext, 'protocol' | 'model' | 'arkai' | 'advertised'>): Effort | null {
	if (!levels.length) return null;
	const declared = c.advertised?.current;
	if (declared && levels.includes(declared)) return declared;
	const id = (c.protocol === 'arkai' ? (c.arkai?.model ?? '') : (c.model ?? '')).toLowerCase().replace(/^.*\//, '');
	const claude = c.protocol === 'claude' || id.startsWith('claude');
	if (c.protocol === 'arkai' && c.arkai && arkaiEffortKind(c.arkai.api, c.arkai.baseUrl, c.arkai.model) === 'anthropic-budget') return 'off';
	const mediumClaude = /^(?:claude-)?(?:opus|haiku)-5[.-]5(?![.\d])/.test(id);
	const preferred: Effort = claude && !mediumClaude ? 'high' : 'medium';
	return levels.includes(preferred) ? preferred : levels[0]!;
}

/** `kingu.chat.reasoningEffort` read loosely: runtime id → a known level. */
export function effortDefaults(v: unknown): Record<string, Effort> {
	if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
	return Object.fromEntries(Object.entries(v).filter((e): e is [string, Effort] => isEffort(e[1])));
}

/**
 * The effort a run is started with: the chat's pick, else the runtime's default from settings
 * (its id, else `*`), when the model takes it; null: nothing is sent (the model's default).
 */
export function runEffort(chosen: string | null | undefined, defaults: Record<string, Effort>, runtime: string, levels: readonly Effort[]): Effort | null {
	for (const e of [chosen, defaults[runtime], defaults['*']]) if (isEffort(e) && levels.includes(e)) return e;
	return null;
}

/** The picker's rows (old's Effort Level choices): each level with its description, the one in effect checked. */
export function effortRows(levels: readonly Effort[], current: Effort | null): MenuRow[] {
	return levels.map((e) => ({ id: e, label: effortLabel(e), description: effortDescription(e), checked: e === current }));
}
