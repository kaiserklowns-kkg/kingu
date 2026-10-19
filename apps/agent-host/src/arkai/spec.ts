// What Rust sends for an Arkai run (`start {runtime: {kind: 'arkai', …}}`, agent/arkai.rs): the
// provider the user set up in `kingu.arkai.providers` (its API key from the macOS Keychain, never
// from a settings file), the model, the provider's other models (a mid-session switch), and the
// chat's earlier events from its transcript when it continues. Checked here before a run starts.

export type ArkaiApi = 'openai' | 'anthropic';

export type ArkaiModel = {
	id: string;
	/** Tokens the model can take in; unknown: `DEFAULT_CONTEXT_WINDOW`. */
	contextWindow?: number;
	/** Most tokens one answer may have; unknown: `DEFAULT_MAX_TOKENS`. */
	maxTokens?: number;
	/** Light mode (a short prompt, six tools) for a small model; unset: on for a small context window. */
	light?: boolean;
};

export type ArkaiProvider = {
	/** The provider's id in the user's settings (`ollama`, `openrouter`, …). */
	id: string;
	name: string;
	/** `openai`: OpenAI-compatible chat completions; `anthropic`: the Messages API. */
	api: ArkaiApi;
	/** e.g. `https://openrouter.ai/api/v1`, `http://127.0.0.1:11434/v1`. */
	baseUrl: string;
	/** From the Keychain. Never logged, never in an event. */
	apiKey?: string | null;
	/** Extra request headers the user set (not secrets: they live in settings.json). */
	headers?: Record<string, string>;
	models?: ArkaiModel[];
};

export type ArkaiSpec = {
	kind: 'arkai';
	provider: ArkaiProvider;
	/** The model id at the provider (without the `provider/` prefix the chat stores). */
	model: string;
	/** The chat's events so far (message, tool_use, tool_result), oldest first, for a continued chat. */
	history?: unknown[];
};

export const DEFAULT_CONTEXT_WINDOW = 32_768;
export const DEFAULT_MAX_TOKENS = 8192;
/** At or below this context window a model runs in light mode unless its settings say otherwise. */
export const LIGHT_CONTEXT_WINDOW = 16_384;

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_MODEL = 200;
const MAX_HEADERS = 32;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
/** Events of a continued chat: more than this is cut from the oldest end. */
export const MAX_HISTORY = 20_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const posInt = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 10_000_000);
const validModelId = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_MODEL && !/[\0\n\r]/.test(v);

function model(v: unknown): ArkaiModel {
	if (!isObj(v) || !validModelId(v.id)) throw new Error('arkai model needs an id');
	if (!posInt(v.contextWindow) || !posInt(v.maxTokens)) throw new Error('arkai model limits must be positive integers');
	if (v.light !== undefined && v.light !== null && typeof v.light !== 'boolean') throw new Error('arkai model light must be a boolean');
	return {
		id: v.id,
		...(typeof v.contextWindow === 'number' ? { contextWindow: v.contextWindow } : {}),
		...(typeof v.maxTokens === 'number' ? { maxTokens: v.maxTokens } : {}),
		...(typeof v.light === 'boolean' ? { light: v.light } : {})
	};
}

/** The checked provider; throws a message on a bad one. */
export function arkaiProvider(v: unknown): ArkaiProvider {
	if (!isObj(v)) throw new Error('arkai provider must be an object');
	if (typeof v.id !== 'string' || !ID.test(v.id)) throw new Error('arkai provider id must be lowercase letters, digits and -');
	if (v.api !== 'openai' && v.api !== 'anthropic') throw new Error('arkai provider api must be openai or anthropic');
	let url: URL;
	try {
		url = new URL(String(v.baseUrl));
	} catch {
		throw new Error('arkai provider baseUrl must be a URL');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('arkai provider baseUrl must be http or https');
	if (v.apiKey !== undefined && v.apiKey !== null && (typeof v.apiKey !== 'string' || /[\0\n\r]/.test(v.apiKey))) throw new Error('arkai provider apiKey must be a string');
	const headers = v.headers ?? {};
	if (!isObj(headers) || Object.keys(headers).length > MAX_HEADERS || !Object.entries(headers).every(([k, h]) => HEADER_NAME.test(k) && typeof h === 'string' && !/[\0\n\r]/.test(h)))
		throw new Error('arkai provider headers must map header names to strings');
	const models = v.models ?? [];
	if (!Array.isArray(models) || models.length > 500) throw new Error('arkai provider models must be a list');
	return {
		id: v.id,
		name: typeof v.name === 'string' && v.name.trim() ? v.name.slice(0, 80) : v.id,
		api: v.api,
		baseUrl: String(v.baseUrl).replace(/\/+$/, ''),
		...(typeof v.apiKey === 'string' && v.apiKey ? { apiKey: v.apiKey } : {}),
		headers: headers as Record<string, string>,
		models: models.map(model)
	};
}

/** The checked spec of an Arkai run; throws a message on a bad one. */
export function arkaiSpec(v: unknown): ArkaiSpec {
	if (!isObj(v) || v.kind !== 'arkai') throw new Error('not an arkai runtime');
	const provider = arkaiProvider(v.provider);
	if (!validModelId(v.model)) throw new Error('arkai runtime needs a model');
	const history = v.history ?? [];
	if (!Array.isArray(history)) throw new Error('arkai history must be a list of events');
	return { kind: 'arkai', provider, model: v.model, history: history.slice(-MAX_HISTORY) };
}

/** The model's settings at its provider (defaults for one the provider does not list). */
export function modelOf(provider: ArkaiProvider, id: string): Required<Pick<ArkaiModel, 'id' | 'contextWindow' | 'maxTokens'>> & { light: boolean } {
	const m = provider.models?.find((x) => x.id === id);
	const contextWindow = m?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	// An answer never gets more than a quarter of a small window.
	const maxTokens = Math.min(m?.maxTokens ?? DEFAULT_MAX_TOKENS, Math.max(1024, Math.floor(contextWindow / 4)));
	return { id, contextWindow, maxTokens, light: m?.light ?? contextWindow <= LIGHT_CONTEXT_WINDOW };
}
