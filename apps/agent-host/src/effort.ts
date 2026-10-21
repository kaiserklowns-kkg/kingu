// The chat's reasoning effort (old Kingu's "Effort Level", platform/agentHost/common/
// reasoningEffort.ts): one scale for every runtime, mapped here to the knob each one really has.
//
// - Claude Agent SDK: `Options.effort` (low … max; `minimal` is `low`), `off` is
//   `maxThinkingTokens: 0` (thinking disabled; the same knob the live session takes, so a later
//   level can clear it). Live: `setMaxThinkingTokens(null)` + `applyFlagSettings({effortLevel})`,
//   or `setMaxThinkingTokens(0)` (host.ts).
// - Codex app server: `turn/start {effort, summary: 'auto'}` (`off` is `none`, `max` is `xhigh`).
// - Arkai: the provider's own field (arkaiReasoning): Anthropic's thinking (adaptive + effort, or
//   a token budget on older models), OpenAI's `reasoning_effort` (OpenRouter's `reasoning`),
//   Gemini's `thinking_budget`; other models get nothing.
// - ACP: only an agent that advertises a `thought_level` session config option (acpThoughtLevels).
//
// Absent (null) everywhere means "the model's default": nothing is sent.

export const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v);

/** A request's `effort`: undefined when absent or null; throws a message on anything else. */
export function checkEffort(v: unknown): Effort | undefined {
	if (v === undefined || v === null) return undefined;
	if (!isEffort(v)) throw new Error(`unsupported reasoning effort ${String(v)}`);
	return v;
}

// ---- Claude Agent SDK ----------------------------------------------------------------------

export type ClaudeEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The SDK's level for `effort` (it has no `minimal`); null for `off`. */
export function claudeEffortLevel(effort: Effort): ClaudeEffortLevel | null {
	if (effort === 'off') return null;
	return effort === 'minimal' ? 'low' : effort;
}

/** The SDK `Options` a run starts with: `effort`, or thinking turned off. */
export function claudeStartOptions(effort: Effort | undefined): { effort?: ClaudeEffortLevel; maxThinkingTokens?: number } {
	if (!effort) return {};
	const level = claudeEffortLevel(effort);
	return level ? { effort: level } : { maxThinkingTokens: 0 };
}

// ---- Codex app server -----------------------------------------------------------------------

/** `turn/start`'s reasoning fields: Codex's `ReasoningEffort` and a reasoning summary. */
export function codexEffort(effort: Effort | undefined): { effort: string; summary: 'auto' | 'none' } | null {
	if (!effort) return null;
	if (effort === 'off') return { effort: 'none', summary: 'none' };
	return { effort: effort === 'max' ? 'xhigh' : effort, summary: 'auto' };
}

/** The efforts Codex lists for a model (`model/list`'s `supportedReasoningEfforts`), on Kingu's scale. */
export function codexLevels(supported: unknown): Effort[] {
	if (!Array.isArray(supported)) return [];
	const out = new Set<Effort>();
	for (const s of supported) {
		const v = typeof s === 'string' ? s : s && typeof s === 'object' ? (s as { reasoningEffort?: unknown }).reasoningEffort : null;
		const e = typeof v === 'string' ? normalizeLevel(v) : null;
		if (e) out.add(e);
	}
	return EFFORTS.filter((e) => out.has(e));
}

// ---- ACP ------------------------------------------------------------------------------------

/** An agent's own level name on Kingu's scale (`none` → off, `extra_high` → xhigh); null if unknown. */
export function normalizeLevel(raw: string): Effort | null {
	const v = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');
	if (v === 'none' || v === 'off' || v === 'disabled') return 'off';
	if (v === 'xhigh' || v === 'extrahigh' || v === 'veryhigh') return 'xhigh';
	if (v === 'maximum') return 'max';
	return isEffort(v) ? v : null;
}

/**
 * The agent's thought level setting (ACP session config options, category `thought_level`): its id
 * and Kingu's level → the agent's value. Null when the agent advertises none.
 */
export function acpThoughtLevels(configOptions: unknown): { configId: string; values: Map<Effort, string>; current: Effort | null } | null {
	if (!Array.isArray(configOptions)) return null;
	for (const o of configOptions) {
		if (!o || typeof o !== 'object') continue;
		const opt = o as Record<string, unknown>;
		if (opt.category !== 'thought_level' || typeof opt.id !== 'string' || !Array.isArray(opt.options)) continue;
		const values = new Map<Effort, string>();
		// Options may come flat or in groups (`{group, options}`).
		const flat = opt.options.flatMap((x) => (x && typeof x === 'object' && Array.isArray((x as { options?: unknown }).options) ? (x as { options: unknown[] }).options : [x]));
		for (const x of flat) {
			if (!x || typeof x !== 'object') continue;
			const value = (x as { value?: unknown }).value;
			const name = (x as { name?: unknown }).name;
			if (typeof value !== 'string') continue;
			const e = normalizeLevel(value) ?? (typeof name === 'string' ? normalizeLevel(name) : null);
			if (e && !values.has(e)) values.set(e, value);
		}
		if (!values.size) continue;
		const cur = typeof opt.currentValue === 'string' ? ([...values].find(([, v]) => v === opt.currentValue)?.[0] ?? null) : null;
		return { configId: opt.id, values, current: cur };
	}
	return null;
}

// ---- Arkai ------------------------------------------------------------------------------------

/**
 * What kind of reasoning knob a model has at its provider. Mirrors the desktop's
 * `arkaiEffortKind` (apps/desktop/src/lib/agent/effort.ts), which picks the levels shown.
 */
export type ArkaiEffortKind = 'anthropic-adaptive' | 'anthropic-budget' | 'openai' | 'openrouter' | 'gemini' | null;

export function arkaiEffortKind(api: 'openai' | 'anthropic', baseUrl: string, model: string): ArkaiEffortKind {
	const m = model.toLowerCase().replace(/^.*\//, '');
	if (/^claude-/.test(m)) {
		// Adaptive thinking with effort: Opus / Sonnet 4.6 and later, every 5.x model.
		if (/^claude-(?:opus|sonnet|haiku)-(?:[5-9]|4-[6-9])/.test(m)) return api === 'anthropic' ? 'anthropic-adaptive' : /openrouter\.ai/i.test(baseUrl) ? 'openrouter' : null;
		if (/^claude-(?:3-7-sonnet|(?:opus|sonnet|haiku)-4)/.test(m)) return api === 'anthropic' ? 'anthropic-budget' : /openrouter\.ai/i.test(baseUrl) ? 'openrouter' : null;
		return null;
	}
	if (api !== 'openai') return null;
	if (/generativelanguage\.googleapis\.com/i.test(baseUrl) && /^gemini-(?:2\.5|[3-9])/.test(m)) return 'gemini';
	if (/^(?:o[1-9](?:-|$)|gpt-5)/.test(m)) return /openrouter\.ai/i.test(baseUrl) ? 'openrouter' : 'openai';
	return null;
}

/** Anthropic thinking budgets (older models): below the answer's own `max_tokens`, which grows by it. */
export const ANTHROPIC_BUDGETS: Partial<Record<Effort, number>> = { minimal: 1024, low: 2048, medium: 8192, high: 16_384, xhigh: 24_576, max: 32_000 };
/** Gemini `thinking_budget` per level (`off`: 0; `max`: -1, the model decides). */
export const GEMINI_BUDGETS: Partial<Record<Effort, number>> = { off: 0, minimal: 512, low: 1024, medium: 8192, high: 24_576, xhigh: 32_768, max: -1 };

/**
 * The request body fields for `effort` on this model, and the answer's `max_tokens` (Anthropic's
 * budget comes out of it). Null: the model has no knob, or no effort was picked.
 */
export function arkaiReasoning(kind: ArkaiEffortKind, effort: Effort | null | undefined, maxTokens: number): { body: Record<string, unknown>; maxTokens: number; thinking: boolean } | null {
	if (!kind || !effort) return null;
	switch (kind) {
		case 'anthropic-adaptive': {
			if (effort === 'off') return { body: { thinking: { type: 'disabled' } }, maxTokens, thinking: false };
			const level = claudeEffortLevel(effort)!;
			return { body: { thinking: { type: 'adaptive' }, output_config: { effort: level } }, maxTokens, thinking: true };
		}
		case 'anthropic-budget': {
			if (effort === 'off') return null;
			const budget = ANTHROPIC_BUDGETS[effort]!;
			return { body: { thinking: { type: 'enabled', budget_tokens: budget } }, maxTokens: maxTokens + budget, thinking: true };
		}
		case 'openai':
			return { body: { reasoning_effort: effort === 'off' ? 'none' : effort === 'max' ? 'xhigh' : effort }, maxTokens, thinking: false };
		case 'openrouter':
			return { body: { reasoning: effort === 'off' ? { enabled: false } : { effort: effort === 'minimal' ? 'minimal' : effort === 'xhigh' || effort === 'max' ? 'high' : effort } }, maxTokens, thinking: false };
		case 'gemini':
			return { body: { extra_body: { google: { thinking_config: { thinking_budget: GEMINI_BUDGETS[effort]!, include_thoughts: effort !== 'off' } } } }, maxTokens, thinking: false };
	}
}
