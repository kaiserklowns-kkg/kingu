// Model routers (VS Code 1.147, platform/agentHost/common/modelRouter.ts and
// node/copilot/copilotModelRouter.ts) for Arkai. A router is a `<name>.model-router.yaml` file in
// `~/.agents/model-routers/`; the chat picks it as the model `model-router:<name>`, and each turn
// runs on the route whose `when` fits the request:
//
// ```yaml
// version: 1
// display-name: Daily Driver
// description: Haiku by default, Opus for planning.
// guidance: Prefer the cheapest model that can do the job.
// routes:
//   - model: claude-haiku-4-5
//     when: Lookups, explanations and small edits.
//     examples: [where is the config read?]
//   - name: feature
//     model: [claude-opus-4-6, opus]
//     when: Planning, design and multi-file implementation.
//     effort: high
//     guidance: Plan first, then run the tests before you finish.
// ```
//
// What differs from VS Code, where a Copilot service decides:
// - A route's models are the run's provider's (Arkai runs one provider at a time): `model` is a
//   model id there, `<provider>/<id>`, or a family without a version (`opus`: its newest model).
// - The decision is asked of a model of the user's own provider (the router's first route), not
//   of Copilot's decisions model. When that fails, Kingu picks by the words of each route's `when`
//   and `examples` (keywordPick, Kingu-only) before falling back to the first route as VS Code does.
// - `context-size` is read and checked but changes nothing: an Arkai model has one window.

import type { Effort } from '../effort.ts';
import type { ChatClient } from './messages.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const MODEL_ROUTER_PREFIX = 'model-router:';
export const MODEL_ROUTER_FILE_SUFFIXES = ['.model-router.yaml', '.model-router.yml'] as const;
export const MODEL_ROUTER_FOLDER = 'model-routers';
export const MODEL_ROUTER_VERSION = 1;
export const MODEL_ROUTER_MIN_ROUTES = 2;
export const MODEL_ROUTER_MAX_ROUTES = 10;
export const MODEL_ROUTER_MAX_FILE_BYTES = 32 * 1024;
export const MODEL_ROUTER_MAX_DECISION_TEXT_BYTES = 64 * 1024;
const MAX_DESCRIPTION_CHARS = 1024;
const MAX_DISPLAY_NAME_CHARS = 64;
const MAX_EXAMPLES = 10;
const MAX_ROUTE_GUIDANCE_CHARS = 4000;
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** VS Code's levels (reasoningEffort.ts), low to high. */
export const ROUTER_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type RouterEffortLevel = (typeof ROUTER_EFFORT_LEVELS)[number];
export type RouterEffort = 'auto' | 'off' | RouterEffortLevel;
export type RouterSwitching = 'auto' | 'first-turn';
export type RouterContextSize = 'default' | 'long';

export type RouterRoute = {
	models: string[];
	when: string;
	examples: string[];
	effort?: RouterEffortLevel;
	contextSize?: RouterContextSize;
	name?: string;
	/** For the chat's main agent (modelRouterGuidance.ts); routing never reads it. */
	mainAgentGuidance?: string;
};

export type ModelRouter = {
	name: string;
	displayName?: string;
	description: string;
	effort: RouterEffort;
	contextSize?: RouterContextSize;
	switching: RouterSwitching;
	guidance: string;
	routes: RouterRoute[];
};

export type RouterDiagnostic = { severity: 'error' | 'warning'; message: string };
export type RouterParse = { router: ModelRouter | undefined; diagnostics: RouterDiagnostic[]; name?: string };

const topLevelKeys = new Set(['version', 'name', 'display-name', 'description', 'effort', 'context-size', 'switching', 'guidance', 'routes']);
const reservedTopLevelKeys = new Set(['subagents', 'phases', 'mid-turn']);
const routeKeys = new Set(['name', 'model', 'when', 'examples', 'effort', 'context-size', 'guidance']);
const removedTopLevelKeys = new Map([
	['playbooks', 'Write `playbooks` as `routes`: a list where each route has `model` and `when`, and can have a `name` and `guidance`.'],
	['roles', "`roles` are no longer read. To have a custom agent used, name it in a route's `guidance`."]
]);

export const isModelRouterModel = (id: string | undefined | null): id is string => !!id?.startsWith(MODEL_ROUTER_PREFIX);
export const modelRouterNameOf = (id: string) => id.slice(MODEL_ROUTER_PREFIX.length);

/** `daily-driver.model-router.yaml` → `daily-driver`. */
export function modelRouterNameFromFileName(fileName: string): string | undefined {
	const lower = fileName.toLowerCase();
	const suffix = MODEL_ROUTER_FILE_SUFFIXES.find((s) => lower.endsWith(s));
	return suffix ? fileName.slice(0, -suffix.length) : undefined;
}

export const modelRouterLabel = (r: Pick<ModelRouter, 'name' | 'displayName'>) => r.displayName ?? r.name;

/** A YAML scalar as text (numbers and booleans as written); undefined for a list or map. */
function scalar(v: unknown): string | undefined {
	if (typeof v === 'string') return v;
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	return undefined;
}

function scalarList(v: unknown): string[] | undefined {
	if (Array.isArray(v)) {
		const out = v.map(scalar);
		return out.every((x) => x !== undefined) ? (out as string[]) : undefined;
	}
	const one = scalar(v);
	return one === undefined ? undefined : [one];
}

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

/** A model reference: an id, or `<provider>/<id>`. */
const isModelReference = (r: string) => r.length > 0 && r.trim() === r && !/[\0\n\r]/.test(r);

/** Versions are written with dots or dashes, so `claude-opus-4.8` matches `claude-opus-4-8`. */
const normalizeModelId = (id: string) => id.toLowerCase().replace(/\./g, '-');

/** Parses and checks a router file, as VS Code's parseModelRouter does. */
export function parseModelRouter(content: string, fileName: string): RouterParse {
	const diagnostics: RouterDiagnostic[] = [];
	const error = (message: string) => diagnostics.push({ severity: 'error', message });
	const warning = (message: string) => diagnostics.push({ severity: 'warning', message });
	let validName: string | undefined;
	const fail = (): RouterParse => ({ router: undefined, diagnostics, ...(validName ? { name: validName } : {}) });
	if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
	if (bytes(content) > MODEL_ROUTER_MAX_FILE_BYTES) {
		error(`A model router file is at most ${MODEL_ROUTER_MAX_FILE_BYTES / 1024} KiB.`);
		return fail();
	}
	let root: unknown;
	try {
		root = Bun.YAML.parse(content);
	} catch (e) {
		error(`YAML: ${e instanceof Error ? e.message : String(e)}`);
		return fail();
	}
	if (!isObj(root)) {
		error('A model router is a YAML map with `version`, `description` and `routes`.');
		return fail();
	}
	for (const key of Object.keys(root)) {
		const removed = removedTopLevelKeys.get(key);
		if (removed) (key === 'playbooks' ? error : warning)(removed);
		else if (reservedTopLevelKeys.has(key)) warning(`\`${key}\` is reserved for a later version and is ignored.`);
		else if (!topLevelKeys.has(key)) warning(`Unknown key \`${key}\` is ignored.`);
	}

	if (root.version === undefined) error(`Add \`version: ${MODEL_ROUTER_VERSION}\`.`);
	else if (scalar(root.version) !== String(MODEL_ROUTER_VERSION)) error(`Unsupported version \`${scalar(root.version) ?? '?'}\`. Kingu reads version ${MODEL_ROUTER_VERSION}.`);

	const name = root.name !== undefined ? scalar(root.name) : modelRouterNameFromFileName(fileName);
	if (!name || !NAME_PATTERN.test(name)) error('The name must be lowercase letters, digits and single hyphens, like `daily-driver`.');
	else validName = name;

	const description = root.description !== undefined ? scalar(root.description)?.trim() : undefined;
	if (!description) error('Add a `description`; it is shown in the model picker.');
	else if (description.length > MAX_DESCRIPTION_CHARS) error(`The description is longer than ${MAX_DESCRIPTION_CHARS} characters.`);

	const displayName = root['display-name'] !== undefined ? scalar(root['display-name'])?.trim().replace(/\s+/g, ' ') : undefined;
	if (root['display-name'] !== undefined && !displayName) error('`display-name` is the name the model picker shows.');
	else if (displayName && displayName.length > MAX_DISPLAY_NAME_CHARS) error(`The display name is longer than ${MAX_DISPLAY_NAME_CHARS} characters.`);

	const effort = parseEffort(root.effort, ['auto', 'off'], 'auto', '`effort`', error) as RouterEffort;
	const contextSize = parseContextSize(root['context-size'], '`context-size`', error);

	let switching: RouterSwitching = 'first-turn';
	if (root.switching !== undefined) {
		const v = scalar(root.switching);
		if (v === 'auto' || v === 'first-turn') switching = v;
		else if (v === 'mid-turn') warning('`switching: mid-turn` is reserved for a later version; this router routes on the first turn only.');
		else error('`switching` is `auto` or `first-turn`.');
	}

	const guidance = root.guidance !== undefined && root.guidance !== null ? scalar(root.guidance)?.trim() : '';
	if (guidance === undefined) error('`guidance` is text.');

	const routes: RouterRoute[] = [];
	if (!Array.isArray(root.routes)) {
		if (root.playbooks === undefined) error('Add `routes`: a list of models, each with `model` and `when`.');
	} else {
		const items: unknown[] = root.routes;
		const seenModels = new Map<string, number>();
		const seenNames = new Map<string, number>();
		items.forEach((item, index) => {
			const route = parseRoute(item, index, items.length === 1, error, warning);
			if (!route) return;
			const label = routeLabel(route, index);
			if (effort === 'off' && route.effort) warning(`${label}'s \`effort\` is ignored because the router's \`effort\` is \`off\`.`);
			if (route.name) {
				const previous = seenNames.get(route.name);
				if (previous !== undefined) error(`The name \`${route.name}\` is already route ${previous + 1}'s; each name belongs to one route.`);
				seenNames.set(route.name, index);
			} else {
				for (const model of route.models) {
					const key = normalizeModelId(model);
					const previous = seenModels.get(key);
					if (previous !== undefined) error(`\`${model}\` is already in route ${previous + 1}; each model belongs to one route, unless the routes have a \`name\`.`);
					seenModels.set(key, index);
				}
			}
			routes.push(route);
		});
		const guided = routes.some((r) => r.mainAgentGuidance);
		if (items.length > MODEL_ROUTER_MAX_ROUTES || items.length < (guided ? 1 : MODEL_ROUTER_MIN_ROUTES))
			error(`A router has ${MODEL_ROUTER_MIN_ROUTES} to ${MODEL_ROUTER_MAX_ROUTES} routes; this one has ${items.length}.`);
	}
	if (bytes(JSON.stringify([guidance ?? '', routes.map((r) => [r.when, r.examples])])) > MODEL_ROUTER_MAX_DECISION_TEXT_BYTES)
		error(`The guidance, \`when\` and examples together are too long: at most ${MODEL_ROUTER_MAX_DECISION_TEXT_BYTES / 1024} KiB is sent with each decision.`);

	if (diagnostics.some((d) => d.severity === 'error') || !name || !description || guidance === undefined) return fail();
	return {
		router: { name, description, effort, switching, guidance, routes, ...(displayName ? { displayName } : {}), ...(contextSize ? { contextSize } : {}) },
		diagnostics,
		name
	};
}

const routeLabel = (r: Pick<RouterRoute, 'name'>, index: number) => (r.name ? `Route \`${r.name}\`` : `Route ${index + 1}`);

function parseRoute(item: unknown, index: number, only: boolean, error: (m: string) => void, warning: (m: string) => void): RouterRoute | undefined {
	const position = `Route ${index + 1}`;
	if (!isObj(item)) {
		error(`${position} needs \`model\` and \`when\`.`);
		return undefined;
	}
	for (const key of Object.keys(item)) if (!routeKeys.has(key)) warning(`Unknown key \`${key}\` in ${position.toLowerCase()} is ignored.`);
	const name = item.name !== undefined ? scalar(item.name) : undefined;
	if (item.name !== undefined && (!name || !NAME_PATTERN.test(name))) {
		error(`${position}'s \`name\` is lowercase letters, digits and single hyphens, like \`bug-fix\`.`);
		return undefined;
	}
	const label = routeLabel({ name }, index);
	const models = item.model !== undefined ? scalarList(item.model) : undefined;
	if (!models?.length || models.some((m) => !isModelReference(m))) {
		error(`${label} needs \`model\`: a model id like \`claude-haiku-4-5\` or \`openrouter/anthropic/claude-haiku-4.5\`, or a list of them in preference order.`);
		return undefined;
	}
	const when = item.when !== undefined && item.when !== null ? (scalar(item.when)?.trim() ?? '') : '';
	if (!when && (item.when !== undefined || !only)) {
		error(`${label} needs \`when\`: when to use this model.`);
		return undefined;
	}
	let examples: string[] = [];
	if (item.examples !== undefined) {
		const list = scalarList(item.examples);
		if (!list) {
			error(`${label}'s \`examples\` is a list of requests.`);
			return undefined;
		}
		if (list.length > MAX_EXAMPLES) warning(`${label} has more than ${MAX_EXAMPLES} examples; only the first ${MAX_EXAMPLES} are used.`);
		examples = list.slice(0, MAX_EXAMPLES).filter(Boolean);
	}
	const effort = parseEffort(item.effort, [], undefined, `${label}'s \`effort\``, error) as RouterEffortLevel | undefined;
	const contextSize = parseContextSize(item['context-size'], `${label}'s \`context-size\``, error);
	const mainAgentGuidance = item.guidance !== undefined && item.guidance !== null ? scalar(item.guidance)?.trim() : '';
	if (mainAgentGuidance === undefined) {
		error(`${label}'s \`guidance\` is text.`);
		return undefined;
	}
	if (mainAgentGuidance.length > MAX_ROUTE_GUIDANCE_CHARS) error(`${label}'s \`guidance\` is too long: at most ${MAX_ROUTE_GUIDANCE_CHARS} characters.`);
	return { models, when, examples, ...(effort ? { effort } : {}), ...(contextSize ? { contextSize } : {}), ...(name ? { name } : {}), ...(mainAgentGuidance ? { mainAgentGuidance } : {}) };
}

function parseEffort(v: unknown, keywords: readonly string[], fallback: string | undefined, label: string, error: (m: string) => void): string | undefined {
	if (v === undefined) return fallback;
	const s = scalar(v);
	if (s !== undefined && (keywords.includes(s) || (ROUTER_EFFORT_LEVELS as readonly string[]).includes(s))) return s;
	error(`${label} is ${[...keywords, ...ROUTER_EFFORT_LEVELS].map((l) => `\`${l}\``).join(', ')}.`);
	return fallback;
}

function parseContextSize(v: unknown, label: string, error: (m: string) => void): RouterContextSize | undefined {
	if (v === undefined) return undefined;
	const s = scalar(v);
	if (s === 'default' || s === 'long') return s;
	error(`${label} is \`default\` or \`long\`.`);
	return undefined;
}

// ---- Model references -----------------------------------------------------------------------

type IdParts = { words: string[]; version: number[]; date: number[] };

/** A model id's words, version and snapshot date: `gpt-5.1-mini` is `gpt`, `mini` and 5, 1. */
function idParts(id: string): IdParts {
	const words: string[] = [];
	const version: number[] = [];
	const date: number[] = [];
	for (const token of id.toLowerCase().split(/[-_.:\s]+/).filter(Boolean)) {
		const m = /^([a-z]*)(\d*)([a-z]?)$/.exec(token);
		if (!m) {
			words.push(token);
			continue;
		}
		if (m[1]) words.push(m[1]);
		if (m[2]) {
			const n = Number(m[2]);
			// A year or a whole date says when a snapshot was made, not which version it is.
			if (date.length || n >= 1000) date.push(...(m[2].length === 8 ? [Number(m[2].slice(0, 4)), Number(m[2].slice(4, 6)), Number(m[2].slice(6))] : [n]));
			else version.push(n);
		}
		if (m[3]) words.push(m[3]);
	}
	return { words, version, date };
}

function compareNumbers(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? -1) - (b[i] ?? -1);
		if (d) return d;
	}
	return 0;
}

const compareNewness = (a: IdParts, b: IdParts) => compareNumbers(a.version, b.version) || Number(a.date.length === 0) - Number(b.date.length === 0) || compareNumbers(a.date, b.date);

/**
 * The model of `models` that `reference` names: an exact id (dots and dashes alike), the same
 * with `<provider>/` in front, or a family without a version (`opus`: the newest model whose id
 * has that word and the fewest others). Undefined when none, or the family is ambiguous.
 */
export function matchModel(models: readonly string[], reference: string, provider: string): string | undefined {
	const wanted = normalizeModelId(reference);
	const exact = models.find((m) => normalizeModelId(m) === wanted);
	if (exact) return exact;
	const prefix = `${provider.toLowerCase()}/`;
	const local = wanted.startsWith(prefix) ? wanted.slice(prefix.length) : null;
	if (local !== null) {
		const m = models.find((x) => normalizeModelId(x) === local);
		if (m) return m;
	}
	const family = (local ?? wanted).replace(/^.*\//, '');
	const path = (local ?? wanted).includes('/') ? (local ?? wanted).slice(0, (local ?? wanted).lastIndexOf('/')) : null;
	if (/\d/.test(family)) return undefined;
	const want = idParts(family);
	if (!want.words.length) return undefined;
	const candidates = models.flatMap((m) => {
		const n = normalizeModelId(m);
		const slash = n.lastIndexOf('/');
		if (path !== null && (slash < 0 || n.slice(0, slash) !== path)) return [];
		const parts = idParts(n.slice(slash + 1));
		return want.words.every((w) => parts.words.includes(w)) ? [{ m, prefix: slash < 0 ? '' : n.slice(0, slash), ...parts }] : [];
	});
	if (!candidates.length) return undefined;
	const fewest = Math.min(...candidates.map((c) => c.words.length));
	const closest = candidates.filter((c) => c.words.length === fewest);
	if (new Set(closest.map((c) => `${c.prefix}/${c.words.join('-')}`)).size > 1) return undefined;
	const newest = closest.reduce((best, c) => (compareNewness(c, best) > 0 ? c : best));
	const ties = closest.filter((c) => compareNewness(c, newest) === 0);
	return ties.length === 1 ? newest.m : undefined;
}

export type ResolvedRoute = {
	route: RouterRoute;
	/** The model id at the provider. */
	model: string;
	/** The entry of `model` that matched. */
	reference: string;
	/** The efforts the model takes, low to high on Kingu's scale; empty: none. */
	efforts: Effort[];
};

export type RouterResolution = { routes: ResolvedRoute[]; skipped: string[] };

/** Each route matched to a model the provider has; a route with none is skipped, not fatal. */
export function resolveModelRouter(router: ModelRouter, models: readonly string[], provider: string, effortsOf: (model: string) => Effort[]): RouterResolution {
	const routes: ResolvedRoute[] = [];
	const skipped: string[] = [];
	router.routes.forEach((route, index) => {
		let found: { model: string; reference: string } | undefined;
		for (const reference of route.models) {
			const model = matchModel(models, reference, provider);
			if (model) {
				found = { model, reference };
				break;
			}
		}
		if (!found) {
			skipped.push(`${routeLabel(route, index)} (${route.models.join(', ')})`);
			return;
		}
		// A route without a name is its model: a second one on the same model has nothing to add.
		if (!route.name && routes.some((r) => !r.route.name && r.model === found.model)) return;
		routes.push({ route, ...found, efforts: effortsOf(found.model) });
	});
	return { routes, skipped };
}

export const routeKey = (r: ResolvedRoute) => r.route.name ?? r.model;

// ---- Guidance -------------------------------------------------------------------------------

/** The note that tells the chat's main agent how the user wants the work done (modelRouterGuidance.ts). */
export function modelRouterBriefing(router: ModelRouter, route: ResolvedRoute): string {
	if (!route.route.mainAgentGuidance) return '';
	return [
		'<model_router_guidance>',
		'This note is for the main agent of this chat only. If you were started as a subagent, ignore it.',
		route.route.name ? `The user's model router "${modelRouterLabel(router)}" chose its "${route.route.name}" route for this chat.` : `The user's model router "${modelRouterLabel(router)}" chose a route for this chat.`,
		'',
		'How the user wants the work done:',
		route.route.mainAgentGuidance,
		'</model_router_guidance>'
	].join('\n');
}

// ---- The decision ---------------------------------------------------------------------------

export type RouterCandidate = { id: string; name: string; when: string; examples: string[] };
export type RouterFollowUp = { currentModel: string; recentTurns: { prompt: string; response: string }[]; turns: number };
export type RouterPickRequest = { text: string; candidates: RouterCandidate[]; guidance: string; askEffort: boolean; followUp?: RouterFollowUp };
export type RouterPick = { model: string | undefined; confidence: number; probabilities: Record<string, number>; effortScore?: number };
export type RouterPicker = (request: RouterPickRequest, signal: AbortSignal) => Promise<RouterPick>;

const MIN_PICK_CONFIDENCE = 0.4;
const CONTINUATION = /^\s*(ok(ay)?|yes|yep|sure|continue|proceed|next|go ahead|do it|go on|thanks?( you)?)[.!]?\s*$/i;
const RECENT_TURNS = 4;
export const modelRouterSwitchPolicy = { minPickProbability: 0.6, minLead: 0.25, cooldownTurns: 2 } as const;
const EFFORT_CHANGE_MARGIN = 0.75;
/** How long a turn waits for the decision (a local model is slower than Copilot's 5 s service). */
export const DECISION_TIMEOUT_MS = 15_000;
/** The picker's scale: low 0 … max 4 (VS Code's reasoningEffortRank). */
const RANK: Partial<Record<Effort, number>> = { minimal: -1, low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

/** VS Code's level on Kingu's scale (`none` is off, `ultra` is max). */
export function kinguEffort(level: RouterEffortLevel): Effort {
	return level === 'none' ? 'off' : level === 'ultra' ? 'max' : level;
}

function closestEffort(supported: readonly Effort[], rank: number | undefined): Effort | undefined {
	const ranked = supported.filter((e) => RANK[e] !== undefined);
	if (rank === undefined || !ranked.length) return undefined;
	return ranked.reduce((best, e) => (Math.abs(RANK[e]! - rank) < Math.abs(RANK[best]! - rank) ? e : best));
}

/** A follow-up's effort on the same model: it holds unless the request clearly differs. */
export function decideModelRouterEffort(current: Effort | undefined, score: number | undefined, supported: readonly Effort[]): Effort | undefined {
	if (current === undefined || !supported.includes(current) || RANK[current] === undefined) return closestEffort(supported, score);
	if (score === undefined || Math.abs(score - RANK[current]!) < EFFORT_CHANGE_MARGIN) return current;
	return closestEffort(supported, score);
}

/** Whether a follow-up moves the chat: only when its message clearly fits another route. */
export function decideModelRouterSwitch(currentModel: string, pick: RouterPick, turnsSinceSwitch: number | undefined): 'stay' | 'switch' {
	const p = modelRouterSwitchPolicy;
	if (!pick.model || pick.model === currentModel) return 'stay';
	const prob = pick.probabilities[pick.model] ?? pick.confidence;
	if (prob < p.minPickProbability || prob - (pick.probabilities[currentModel] ?? 0) < p.minLead) return 'stay';
	if (turnsSinceSwitch !== undefined && turnsSinceSwitch < p.cooldownTurns) return 'stay';
	return 'switch';
}

/** Normalised probabilities, the most likely route and how sure. */
function toPick(raw: Record<string, number>, ids: readonly string[], effortScore?: number): RouterPick {
	const probabilities: Record<string, number> = {};
	let sum = 0;
	for (const id of ids) {
		const v = raw[id];
		const n = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
		probabilities[id] = n;
		sum += n;
	}
	if (sum <= 0) return { model: undefined, confidence: 0, probabilities, ...(effortScore !== undefined ? { effortScore } : {}) };
	let model: string | undefined;
	for (const id of ids) {
		probabilities[id] = Math.round((probabilities[id]! / sum) * 1000) / 1000;
		if (model === undefined || probabilities[id]! > probabilities[model]!) model = id;
	}
	return { model, confidence: probabilities[model!]!, probabilities, ...(effortScore !== undefined ? { effortScore } : {}) };
}

const STOP = new Set('a an and are as at be by do for from how i in is it its me my of on or so that the this to was we what when where which who why will with you your'.split(' '));
const wordsOf = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, '')));

/**
 * Kingu-only: a pick from the words of the request against each route's `when` and `examples`,
 * for when the decision model cannot be asked (offline, a provider error, a timeout). Not as good
 * as a model's judgement, but better than always the first route.
 */
export function keywordPick(request: RouterPickRequest): RouterPick {
	const asked = wordsOf(request.text);
	const raw: Record<string, number> = {};
	for (const c of request.candidates) {
		const route = wordsOf([c.when, ...c.examples].join(' '));
		let hits = 0;
		for (const w of asked) if (route.has(w)) hits++;
		raw[c.id] = hits;
	}
	return toPick(raw, request.candidates.map((c) => c.id));
}

const agentFraming =
	"The request goes to an AI coding agent that works in the user's repositories with tools: it can read files, run commands and edit code. Judge the work the request needs to be done well, not how short the message is: a short message can start a long investigation.";
const followUpModelNote =
	'This is a follow-up in an ongoing chat: recentTurns are the earlier messages and replies, and currentModel is the route the chat is on. A message that asks about the last reply or about the work just done, or asks to adjust it, is part of the work the chat is already doing, so pick currentModel for it, however short or simple the message is. Pick another route only when the message starts a different kind of work.';
const effortCriteria = [
	'0 (low): a trivial lookup, mechanical edit, or simple explanation.',
	'1 (medium): a well-specified, multi-step task in a familiar area.',
	'2 (high): complex reasoning or difficult coding; ambiguous, multi-file, or earlier attempts failed.',
	'3 (extra high): only when a route asks for extra high effort on this kind of request.',
	'4 (max): only when a route asks for max effort on this kind of request.'
];

/** The decision request as a system and a user message for a chat model. */
export function decisionPrompt(r: RouterPickRequest): { system: string; user: string } {
	const system = [
		'You route requests for a coding agent to one of several routes. Answer with JSON only, no other text.',
		agentFraming,
		r.guidance ? `The user's guidance for routing: ${r.guidance}` : '',
		r.followUp ? followUpModelNote : '',
		'Routes:',
		...r.candidates.map((c) => `- id "${c.id}" (${c.name}): ${c.when}${c.examples.length ? ` Examples: ${c.examples.map((e) => JSON.stringify(e)).join('; ')}` : ''}`),
		r.askEffort ? `Also rate the reasoning effort the request needs, from 0 to 4:\n${effortCriteria.join('\n')}` : '',
		`Answer as {"probabilities": {${r.candidates.map((c) => `"${c.id}": <0..1>`).join(', ')}}${r.askEffort ? ', "effort": <0..4>' : ''}}.`
	]
		.filter(Boolean)
		.join('\n');
	const user = r.followUp
		? JSON.stringify({ currentModel: r.followUp.currentModel, turns: r.followUp.turns, recentTurns: r.followUp.recentTurns, message: r.text })
		: `A user sent this message to an AI coding agent:\n\n${r.text}`;
	return { system, user };
}

/** The JSON object in a model's answer (fenced or bare). */
function jsonIn(text: string): Obj | null {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) return null;
	try {
		const v = JSON.parse(text.slice(start, end + 1));
		return isObj(v) ? v : null;
	} catch {
		return null;
	}
}

/** A picker that asks `model` at the run's provider. */
export function chatModelPicker(client: ChatClient, model: string, maxTokens = 400): RouterPicker {
	return async (request, signal) => {
		const { system, user } = decisionPrompt(request);
		const res = await client.complete({ model, system, messages: [{ role: 'user', text: user }], tools: [], maxTokens, signal, onText: () => {}, onThinking: () => {} });
		const json = jsonIn(res.text);
		if (!json || !isObj(json.probabilities)) throw new Error('the decision model gave no probabilities');
		const effort = typeof json.effort === 'number' && Number.isFinite(json.effort) ? Math.max(0, Math.min(4, json.effort)) : undefined;
		return toPick(json.probabilities as Record<string, number>, request.candidates.map((c) => c.id), request.askEffort ? effort : undefined);
	};
}

/** What the chat is on: the router's last pick. */
export type RouterState = { router: string; route: string; model: string; effort?: Effort; turnsSinceSwitch?: number };

export type RouteDecision = {
	route: ResolvedRoute;
	effort?: Effort;
	/** Why: `picked`, `kept`, `switched`, `defaulted` (the first route), `only` (one route). */
	how: 'picked' | 'kept' | 'switched' | 'defaulted' | 'only';
	pick?: RouterPick;
	/** Said to the user (a failed decision, skipped routes). */
	notices: string[];
	/** Which picker answered: `model`, `keywords` (Kingu-only fallback), or none. */
	by?: 'model' | 'keywords';
};

export type RouteRequest = {
	router: ModelRouter;
	routes: ResolvedRoute[];
	text: string;
	hasImages: boolean;
	previous: RouterState | null;
	/** The chat's earlier prompts and answers, oldest first. */
	recentTurns: { prompt: string; response: string }[];
	turns: number;
	picker: RouterPicker | null;
	signal: AbortSignal;
	log: (line: string) => void;
};

function effortFor(router: ModelRouter, route: ResolvedRoute, score: number | undefined): Effort | undefined {
	if (router.effort === 'off') return undefined;
	if (route.route.effort) return kinguEffort(route.route.effort);
	if (router.effort === 'auto') return closestEffort(route.efforts, score);
	return kinguEffort(router.effort);
}

async function ask(r: RouteRequest, req: RouterPickRequest): Promise<{ pick: RouterPick; by: 'model' | 'keywords' } | { error: string }> {
	if (r.picker) {
		const timeout = AbortSignal.timeout(DECISION_TIMEOUT_MS);
		try {
			return { pick: await r.picker(req, AbortSignal.any([r.signal, timeout])), by: 'model' };
		} catch (e) {
			if (r.signal.aborted) throw e;
			r.log(`model router: decision failed (${timeout.aborted ? 'timed out' : e instanceof Error ? e.message.slice(0, 120) : 'error'})`);
		}
	}
	const pick = keywordPick(req);
	return pick.model && pick.confidence > 0 ? { pick, by: 'keywords' } : { error: 'routing was unavailable' };
}

/** The route (and effort) for a turn, as VS Code's CopilotModelRouter.resolve decides it. */
export async function routeTurn(r: RouteRequest): Promise<RouteDecision> {
	const { router, routes } = r;
	const candidates: RouterCandidate[] = routes.map((x) => ({ id: routeKey(x), name: x.model, when: x.route.when, examples: x.route.examples }));
	const askEffort = router.effort === 'auto' && routes.some((x) => !x.route.effort);
	const hasRequest = !!r.text.trim() || r.hasImages;
	const fallback = routes[0]!;
	const current = r.previous?.router === router.name ? routes.find((x) => routeKey(x) === r.previous!.route) : undefined;
	if (!current) {
		if (routes.length === 1) return { route: fallback, effort: effortFor(router, fallback, undefined), how: 'only', notices: [] };
		if (!hasRequest) return { route: fallback, effort: effortFor(router, fallback, undefined), how: 'defaulted', notices: [] };
		const got = await ask(r, { text: r.text, candidates, guidance: router.guidance, askEffort });
		if ('error' in got)
			return { route: fallback, effort: effortFor(router, fallback, undefined), how: 'defaulted', notices: [`The model router ${modelRouterLabel(router)} used ${fallback.model}, its first model, because ${got.error}.`] };
		const picked = routes.find((x) => routeKey(x) === got.pick.model);
		if (!picked || got.pick.confidence < MIN_PICK_CONFIDENCE) return { route: fallback, effort: effortFor(router, fallback, got.pick.effortScore), how: 'defaulted', pick: got.pick, notices: [], by: got.by };
		return { route: picked, effort: effortFor(router, picked, got.pick.effortScore), how: 'picked', pick: got.pick, notices: [], by: got.by };
	}
	const keptEffort = router.effort === 'off' ? undefined : current.route.effort ? kinguEffort(current.route.effort) : r.previous?.effort;
	const stay: RouteDecision = { route: current, effort: keptEffort, how: 'kept', notices: [] };
	const continues = CONTINUATION.test(r.text) && !r.hasImages;
	if (router.switching === 'first-turn' || routes.length === 1 || !hasRequest || continues) return stay;
	let got: Awaited<ReturnType<typeof ask>>;
	try {
		got = await ask(r, {
			text: r.text,
			candidates,
			guidance: router.guidance,
			askEffort,
			followUp: { currentModel: routeKey(current), recentTurns: r.recentTurns.slice(-RECENT_TURNS), turns: r.turns }
		});
	} catch (e) {
		if (r.signal.aborted) throw e;
		return stay;
	}
	// A follow-up already has a good model: a routing outage is not worth interrupting it for.
	if ('error' in got) return stay;
	const outcome = decideModelRouterSwitch(routeKey(current), got.pick, r.previous?.turnsSinceSwitch);
	const target = routes.find((x) => routeKey(x) === got.pick.model);
	if (outcome === 'stay' || !target) {
		const effort = router.effort === 'auto' && !current.route.effort ? decideModelRouterEffort(r.previous?.effort, got.pick.effortScore, current.efforts) : keptEffort;
		return { route: current, effort, how: 'kept', pick: got.pick, notices: [], by: got.by };
	}
	return { route: target, effort: effortFor(router, target, got.pick.effortScore), how: 'switched', pick: got.pick, notices: [], by: got.by };
}

// ---- Files ----------------------------------------------------------------------------------

export type RouterFs = { readdir: (dir: string) => string[]; readFile: (path: string) => string };

/** The router `name` from `dir` (`~/.agents/model-routers`), parsed; undefined when no file has that name. */
export function loadModelRouter(dir: string, name: string, fs: RouterFs): RouterParse | undefined {
	let files: string[];
	try {
		files = fs.readdir(dir);
	} catch {
		return undefined;
	}
	for (const file of files.sort()) {
		const fromFile = modelRouterNameFromFileName(file);
		if (!fromFile) continue;
		let content: string;
		try {
			content = fs.readFile(`${dir}/${file}`);
		} catch {
			continue;
		}
		const parsed = parseModelRouter(content, file);
		if ((parsed.name ?? fromFile) === name) return parsed;
	}
	return undefined;
}
