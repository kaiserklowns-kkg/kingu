/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { en } from '#lib/i18n/en.ts';
import { generateRequest, hasAgentInstructions, isEligible, orderedTips, pickTip, shownTip, showTips, stepTip, tipById, tipParts, TIP_CATALOG, type TipContext, type TipDef } from './chatTips.ts';

const ctx = (over: Partial<TipContext> = {}): TipContext => ({
	mode: 'agent',
	rewind: true,
	models: true,
	hasInstructions: true,
	hasCustomAgents: true,
	setting: () => undefined,
	used: new Set(),
	...over
});
const none = new Set<string>();
const ids = (list: (TipDef | undefined)[]) => list.map((d) => d?.id);

describe('catalog', () => {
	test('every tip has a message, and every link names one of its actions', () => {
		for (const d of TIP_CATALOG) {
			const msg = en[d.key];
			expect(msg).toBeTruthy();
			for (const p of tipParts(msg)) if (p.kind === 'link') expect(d.actions?.[p.action]).toBeDefined();
			if (d.keyLabel) expect(msg).toContain('{key}');
		}
		expect(new Set(TIP_CATALOG.map((d) => d.id)).size).toBe(TIP_CATALOG.length);
	});
});

describe('eligibility', () => {
	test('when, things used and changed settings rule a tip out', () => {
		const plan = tipById('tip.planMode')!;
		expect(isEligible(plan, ctx())).toBe(true);
		expect(isEligible(plan, ctx({ mode: 'plan' }))).toBe(false);
		expect(isEligible(plan, ctx({ used: new Set(['mode:plan']) }))).toBe(false);
		const mermaid = tipById('tip.mermaid')!;
		expect(isEligible(mermaid, ctx({ setting: (k) => (k === 'chat.math.enabled' ? true : undefined) }))).toBe(true);
		expect(isEligible(mermaid, ctx({ setting: (k) => (k === 'chat.math.enabled' ? false : undefined) }))).toBe(false);
		// Rewind-only tips need an agent that can rewind.
		expect(isEligible(tipById('tip.forkConversation')!, ctx({ rewind: false }))).toBe(false);
	});

	test('Generate Agent Instructions only while the folder has none (not while unknown)', () => {
		const init = tipById('tip.init')!;
		expect(isEligible(init, ctx({ hasInstructions: false }))).toBe(true);
		expect(isEligible(init, ctx({ hasInstructions: null }))).toBe(false);
		expect(isEligible(init, ctx({ hasInstructions: true }))).toBe(false);
		expect(hasAgentInstructions([{ kind: 'cursor' }])).toBe(false);
		expect(hasAgentInstructions([{ kind: 'cursor' }, { kind: 'agents' }])).toBe(true);
		expect(hasAgentInstructions([{ kind: 'copilot' }])).toBe(true);
	});

	test('the card shows only on an empty chat, with tips on, folder or not', () => {
		expect(showTips({ enabled: true, hiddenForSession: false, empty: true })).toBe(true);
		expect(showTips({ enabled: false, hiddenForSession: false, empty: true })).toBe(false);
		expect(showTips({ enabled: true, hiddenForSession: true, empty: true })).toBe(false);
		// No folder needed (VS Code's getWelcomeTip shows a tip on an empty window's chat too).
		expect(showTips({ enabled: true, hiddenForSession: false, empty: false })).toBe(false);
	});
});

describe('selection', () => {
	const cat: TipDef[] = [
		{ id: 'q1', tier: 'qol', key: 'chatTips.attachFiles' },
		{ id: 'f2', tier: 'foundational', key: 'chatTips.planMode' },
		{ id: 'f1', tier: 'foundational', key: 'chatTips.init', priority: 1 },
		{ id: 'q2', tier: 'qol', key: 'chatTips.history', when: (c) => c.mode === 'agent' }
	];

	test('foundational first (priority, then catalog order), then the rest', () => {
		expect(ids(orderedTips(ctx(), none, cat))).toEqual(['f1', 'f2', 'q1', 'q2']);
		expect(pickTip(ctx(), none, () => 0, cat)?.id).toBe('f1');
		expect(pickTip(ctx(), new Set(['f1']), () => 0, cat)?.id).toBe('f2');
	});

	test('with no foundational tip left, a random one of the rest', () => {
		const gone = new Set(['f1', 'f2']);
		expect(pickTip(ctx(), gone, () => 0, cat)?.id).toBe('q1');
		expect(pickTip(ctx(), gone, () => 0.99, cat)?.id).toBe('q2');
		expect(pickTip(ctx(), new Set(['f1', 'f2', 'q1', 'q2']), () => 0, cat)).toBeUndefined();
	});

	test('the shown tip stays while eligible, else the next eligible one after it', () => {
		expect(shownTip('q1', ctx(), none, () => 0, cat)?.id).toBe('q1');
		// q2 no longer applies (Ask mode): the next one after it in catalog order, wrapping.
		expect(shownTip('q2', ctx({ mode: 'ask' }), none, () => 0, cat)?.id).toBe('q1');
		expect(shownTip('q1', ctx(), new Set(['q1']), () => 0, cat)?.id).toBe('f2');
		expect(shownTip(null, ctx(), none, () => 0, cat)?.id).toBe('f1');
		expect(shownTip('gone', ctx(), none, () => 0, cat)?.id).toBe('f1');
	});

	test('previous / next wrap over the eligible tips', () => {
		expect(stepTip('f1', 1, ctx(), none, cat)?.id).toBe('f2');
		expect(stepTip('q2', 1, ctx(), none, cat)?.id).toBe('f1');
		expect(stepTip('f1', -1, ctx(), none, cat)?.id).toBe('q2');
		expect(stepTip(null, -1, ctx(), none, cat)?.id).toBe('q2');
		expect(stepTip('f1', 1, ctx(), new Set(['f1', 'f2', 'q1', 'q2']), cat)).toBeUndefined();
	});
});

describe('messages', () => {
	test('text, code and links', () => {
		expect(tipParts('Use [/fork](fork) to branch, or `#` for files.')).toEqual([
			{ kind: 'text', text: 'Use ' },
			{ kind: 'link', text: '/fork', action: 'fork' },
			{ kind: 'text', text: ' to branch, or ' },
			{ kind: 'code', text: '#' },
			{ kind: 'text', text: ' for files.' }
		]);
		expect(tipParts('plain')).toEqual([{ kind: 'text', text: 'plain' }]);
		expect(tipParts('[a](x)')).toEqual([{ kind: 'link', text: 'a', action: 'x' }]);
	});

	test('Generate Agent Instructions: /init for Claude Code, the written request for other agents', () => {
		expect(generateRequest('claude', 'write AGENTS.md')).toBe('/init');
		expect(generateRequest('arkai', 'write AGENTS.md')).toBe('write AGENTS.md');
	});
});
