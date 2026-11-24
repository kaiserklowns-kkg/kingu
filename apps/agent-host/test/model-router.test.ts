// Model routers for Arkai (src/arkai/modelRouter.ts, after VS Code's modelRouter.ts and
// copilotModelRouter.ts): the file format, model references, the routing policy, Kingu's word
// fallback, and a whole run whose first request is the decision. No real model.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHost } from '../src/host.ts';
import {
	decideModelRouterEffort,
	decideModelRouterSwitch,
	keywordPick,
	matchModel,
	modelRouterBriefing,
	parseModelRouter,
	resolveModelRouter,
	routeTurn,
	type ModelRouter,
	type RouteRequest,
	type RouterPick
} from '../src/arkai/modelRouter.ts';
import type { AgentEvent } from '../src/protocol.ts';
import { FakeLlm } from './fixtures/fake-llm.ts';

const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

const DAILY = `# A router
version: 1
display-name: Daily Driver
description: Haiku by default, Opus for planning.
guidance: Prefer the cheapest model that can do the job.
effort: auto
switching: auto
routes:
  - model: claude-haiku-4.5
    when: Lookups, explanations and small edits.
    examples: [where is the config read?, explain this function]
  - name: feature
    model: [claude-opus-9, opus]
    when: Planning, design and multi-file implementation of features.
    examples:
      - build a settings page
    effort: high
    guidance: |
      Plan first. Run the tests before you finish.
`;

const MODELS = ['claude-haiku-4-5', 'claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-6-20260101', 'gpt-5-mini', 'gpt-5'];

describe('router files', () => {
	test('a router as VS Code writes it', () => {
		const r = parseModelRouter(DAILY, 'daily-driver.model-router.yaml');
		expect(r.diagnostics).toEqual([]);
		expect(r.router).toMatchObject({ name: 'daily-driver', displayName: 'Daily Driver', effort: 'auto', switching: 'auto', guidance: 'Prefer the cheapest model that can do the job.' });
		expect(r.router!.routes[0]).toEqual({ models: ['claude-haiku-4.5'], when: 'Lookups, explanations and small edits.', examples: ['where is the config read?', 'explain this function'] });
		expect(r.router!.routes[1]).toMatchObject({ name: 'feature', models: ['claude-opus-9', 'opus'], effort: 'high', mainAgentGuidance: 'Plan first. Run the tests before you finish.' });
	});

	test('what VS Code refuses', () => {
		const errors = (s: string) => parseModelRouter(s, 'x.model-router.yaml').diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
		expect(errors('description: d\nroutes: []')[0]).toContain('version: 1');
		expect(errors('version: 2\ndescription: d\nroutes:\n  - model: a\n    when: x\n  - model: b\n    when: y')[0]).toContain('Unsupported version');
		// One route is enough only with guidance.
		expect(errors('version: 1\ndescription: d\nroutes:\n  - model: a\n    when: x')[0]).toContain('2 to 10 routes');
		expect(errors('version: 1\ndescription: d\nroutes:\n  - model: a\n    guidance: Be brief.')).toEqual([]);
		expect(errors('version: 1\ndescription: d\nroutes:\n  - model: a\n    when: x\n  - model: a\n    when: y')[0]).toContain('already in route 1');
		expect(errors('version: 1\ndescription: d\neffort: huge\nroutes:\n  - model: a\n    when: x\n  - model: b\n    when: y')[0]).toContain('`effort` is');
		expect(errors('version: 1\ndescription: d\nplaybooks: []')[0]).toContain('playbooks');
		expect(parseModelRouter('version: 1\nname: Bad Name\ndescription: d\nroutes: []', 'x.model-router.yaml').name).toBeUndefined();
		// Unknown keys are warnings: the router still loads.
		const warned = parseModelRouter('version: 1\ndescription: d\nmystery: 1\nroutes:\n  - model: a\n    when: x\n  - model: b\n    when: y', 'x.model-router.yaml');
		expect(warned.router).toBeDefined();
		expect(warned.diagnostics).toEqual([{ severity: 'warning', message: 'Unknown key `mystery` is ignored.' }]);
	});
});

describe('model references', () => {
	test('exact ids (dots or dashes), the provider prefix, and families', () => {
		expect(matchModel(MODELS, 'claude-haiku-4.5', 'anthropic')).toBe('claude-haiku-4-5');
		expect(matchModel(MODELS, 'anthropic/claude-opus-4-5', 'anthropic')).toBe('claude-opus-4-5');
		// `opus`: the newest opus; the dated snapshot loses to the undated alias of the same version.
		expect(matchModel(MODELS, 'opus', 'anthropic')).toBe('claude-opus-4-6');
		expect(matchModel(MODELS, 'claude-opus-9', 'anthropic')).toBeUndefined();
		// `gpt` is gpt-5 (fewest other words), never gpt-5-mini.
		expect(matchModel(MODELS, 'gpt', 'openai')).toBe('gpt-5');
		expect(matchModel(MODELS, 'gpt-mini', 'openai')).toBe('gpt-5-mini');
		// OpenRouter ids hold a slash; a family matches within its path.
		expect(matchModel(['anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-4.6'], 'anthropic/sonnet', 'openrouter')).toBe('anthropic/claude-sonnet-4.6');
	});

	test('routes resolve to the provider, unavailable ones are skipped', () => {
		const router = parseModelRouter(DAILY, 'daily-driver.model-router.yaml').router!;
		const { routes, skipped } = resolveModelRouter(router, MODELS, 'anthropic', () => ['low', 'medium', 'high']);
		expect(routes.map((r) => [r.model, r.reference])).toEqual([
			['claude-haiku-4-5', 'claude-haiku-4.5'],
			['claude-opus-4-6', 'opus']
		]);
		expect(skipped).toEqual([]);
		expect(resolveModelRouter(router, ['gpt-5'], 'openai', () => []).skipped).toHaveLength(2);
		expect(modelRouterBriefing(router, routes[1]!)).toContain('chose its "feature" route');
		expect(modelRouterBriefing(router, routes[0]!)).toBe('');
	});
});

describe('routing', () => {
	const router = parseModelRouter(DAILY, 'daily-driver.model-router.yaml').router!;
	const { routes } = resolveModelRouter(router, MODELS, 'anthropic', () => ['low', 'medium', 'high', 'xhigh', 'max']);
	const pick = (model: string, p: number, effortScore?: number): RouterPick => ({ model, confidence: p, probabilities: { 'claude-haiku-4-5': model === 'feature' ? 1 - p : p, feature: model === 'feature' ? p : 1 - p }, effortScore });
	const req = (o: Partial<RouteRequest> = {}): RouteRequest => ({
		router,
		routes,
		text: 'build a settings page',
		hasImages: false,
		previous: null,
		recentTurns: [],
		turns: 0,
		picker: async () => pick('feature', 0.9),
		signal: new AbortController().signal,
		log: () => {},
		...o
	});

	test('a first turn takes the confident pick, else the first route', async () => {
		expect(await routeTurn(req())).toMatchObject({ how: 'picked', route: { model: 'claude-opus-4-6' }, effort: 'high', by: 'model' });
		expect(await routeTurn(req({ picker: async () => pick('feature', 0.3) }))).toMatchObject({ how: 'defaulted', route: { model: 'claude-haiku-4-5' } });
		expect(await routeTurn(req({ text: '  ' }))).toMatchObject({ how: 'defaulted' });
	});

	test('Kingu-only: a failed decision falls back to the words of each route', async () => {
		const failing = async () => {
			throw new Error('offline');
		};
		expect(await routeTurn(req({ picker: failing, text: 'please build a new settings page' }))).toMatchObject({ how: 'picked', route: { model: 'claude-opus-4-6' }, by: 'keywords' });
		const none = await routeTurn(req({ picker: failing, text: 'zzz qqq' }));
		expect(none).toMatchObject({ how: 'defaulted', route: { model: 'claude-haiku-4-5' } });
		expect(none.notices[0]).toContain('because routing was unavailable');
		expect(keywordPick({ text: 'explain this function', candidates: [{ id: 'a', name: 'a', when: 'Explanations', examples: ['explain this function'] }, { id: 'b', name: 'b', when: 'Build features', examples: [] }], guidance: '', askEffort: false }).model).toBe('a');
	});

	test('follow-ups: continuation, first-turn routers, the switch policy', async () => {
		const previous = { router: 'daily-driver', route: 'claude-haiku-4-5', model: 'claude-haiku-4-5', effort: 'low' as const, turnsSinceSwitch: 3 };
		expect(await routeTurn(req({ previous, text: 'ok' }))).toMatchObject({ how: 'kept' });
		const firstTurn: ModelRouter = { ...router, switching: 'first-turn' };
		expect(await routeTurn(req({ router: firstTurn, previous }))).toMatchObject({ how: 'kept' });
		expect(await routeTurn(req({ previous }))).toMatchObject({ how: 'switched', route: { model: 'claude-opus-4-6' } });
		// A near tie, or a fresh switch, stays.
		expect(await routeTurn(req({ previous, picker: async () => pick('feature', 0.55) }))).toMatchObject({ how: 'kept' });
		expect(await routeTurn(req({ previous: { ...previous, turnsSinceSwitch: 1 } }))).toMatchObject({ how: 'kept' });
		expect(decideModelRouterSwitch('a', { model: 'b', confidence: 0.7, probabilities: { a: 0.3, b: 0.7 } }, undefined)).toBe('switch');
	});

	test('effort holds unless the request clearly differs', () => {
		expect(decideModelRouterEffort('medium', 1.5, ['low', 'medium', 'high'])).toBe('medium');
		expect(decideModelRouterEffort('medium', 2, ['low', 'medium', 'high'])).toBe('high');
		expect(decideModelRouterEffort(undefined, 0.2, ['low', 'medium', 'high'])).toBe('low');
		expect(decideModelRouterEffort(undefined, 2, [])).toBeUndefined();
	});
});

describe('An Arkai run on a model router', () => {
	test('the decision runs first, then the turn on the picked model with its guidance', async () => {
		const home = realpathSync(mkdtempSync(join(tmpdir(), 'kingu-router-home-')));
		cleanups.push(() => rmSync(home, { recursive: true, force: true }));
		mkdirSync(join(home, '.agents', 'model-routers'), { recursive: true });
		writeFileSync(join(home, '.agents', 'model-routers', 'daily-driver.model-router.yaml'), DAILY);
		const llm = new FakeLlm();
		cleanups.push(() => llm.stop());
		const out: any[] = [];
		let n = 0;
		const host = new AgentHost({
			query: () => {
				throw new Error('the Claude SDK must not run');
			},
			write: (m) => void out.push(JSON.parse(JSON.stringify(m))),
			newId: () => `req-${++n}`,
			log: () => {}
		});
		cleanups.push(() => host.dispatch('shutdown', null));
		const events = () => out.filter((o) => o.method === 'event').map((o) => o.params.event as AgentEvent);
		const until = async (pred: () => boolean) => {
			for (let i = 0; i < 400 && !pred(); i++) await Bun.sleep(10);
			expect(pred()).toBe(true);
		};
		llm.reply({ text: ['```json\n{"probabilities": {"claude-haiku-4-5": 0.1, "feature": 0.9}, "effort": 2}\n```'] }, { text: ['Planned.'] });
		await host.handleLine(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'start',
				params: {
					runId: 1,
					cwd: home,
					prompt: 'build a settings page',
					env: { HOME: home },
					runtime: { kind: 'arkai', provider: { id: 'local', name: 'Local', api: 'openai', baseUrl: `${llm.url}/v1`, models: MODELS.map((id) => ({ id, contextWindow: 64_000 })) }, model: 'model-router:daily-driver' }
				}
			})
		);
		await until(() => events().some((e) => e.kind === 'result'));
		expect(llm.requests).toHaveLength(2);
		const [decision, turn] = llm.requests.map((r) => r.body);
		// The decision runs on the router's first model, without tools, and never streams to the chat.
		expect(decision.model).toBe('claude-haiku-4-5');
		expect(decision.tools ?? []).toEqual([]);
		expect(decision.messages[0].content).toContain('id "feature"');
		expect(turn.model).toBe('claude-opus-4-6');
		expect(turn.messages[0].content).toContain('<model_router_guidance>');
		expect(turn.messages[0].content).toContain('Plan first.');
		// The chat keeps the router as its model.
		expect(events().find((e) => e.kind === 'system')).toMatchObject({ model: 'local/model-router:daily-driver' });
		expect(events().filter((e) => e.kind === 'message' && (e as any).role === 'assistant').map((e) => (e as any).text)).toEqual(['Planned.']);
	});

	test('a router that is not there fails the turn with a reason', async () => {
		const home = realpathSync(mkdtempSync(join(tmpdir(), 'kingu-router-home-')));
		cleanups.push(() => rmSync(home, { recursive: true, force: true }));
		const llm = new FakeLlm();
		cleanups.push(() => llm.stop());
		const out: any[] = [];
		const host = new AgentHost({ query: () => ({}) as never, write: (m) => void out.push(JSON.parse(JSON.stringify(m))), newId: () => 'r', log: () => {} });
		cleanups.push(() => host.dispatch('shutdown', null));
		await host.handleLine(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'start',
				params: { runId: 1, cwd: home, prompt: 'hi', env: { HOME: home }, runtime: { kind: 'arkai', provider: { id: 'local', name: 'Local', api: 'openai', baseUrl: `${llm.url}/v1`, models: [{ id: 'm' }] }, model: 'model-router:gone' } }
			})
		);
		const events = () => out.filter((o) => o.method === 'event').map((o) => o.params.event as any);
		for (let i = 0; i < 300 && !events().some((e) => e.kind === 'result'); i++) await Bun.sleep(10);
		expect(JSON.stringify(events())).toContain('The model router gone was not found');
		expect(llm.requests).toHaveLength(0);
	});
});
