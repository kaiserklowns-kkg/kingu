// The chat's getting-started tips (VS Code's chatTipCatalog / chatTipService): one tip in a card
// joined to the top of an empty chat's input. Pure so `bun test` covers it; chatTips.svelte.ts keeps
// what was dismissed and used, ChatTipCard.svelte draws it.
//   TIP_CATALOG   Kingu's tips, only for features Kingu has. Foundational ones come first (in
//                 catalog order), then a random quality-of-life one.
//   isEligible    a tip shows while its `when` holds, nothing in `excludeWhenUsed` was used and
//                 none of `excludeWhenSettingsChanged` differs from its default.
//   shownTip      the tip shown now: the one already shown while still eligible, else the next
//                 eligible one after it, else a fresh pick (a tip stays put between renders).
//   stepTip       Previous / Next tip, wrapping over the eligible ones.
//   tipParts      a message's text, `code` and [links](action) (actions are the tip's own).

import type { MessageKey } from '#lib/i18n/index.ts';
import type { ModePick } from './customizations.ts';

export type TipTier = 'foundational' | 'qol';

/** What a link in a tip does. */
export type TipAction =
	| { kind: 'generate' }
	| { kind: 'mode'; mode: ModePick }
	| { kind: 'command'; id: string }
	| { kind: 'insert'; text: string }
	| { kind: 'history' };

/** The chat's state, as far as the tips care. */
export type TipContext = {
	mode: 'agent' | 'ask' | 'plan' | 'custom';
	/** The agent can rewind (Restore Checkpoint, /fork, Ask in Side Chat). */
	rewind: boolean;
	/** The model picker is there (⌘/). */
	models: boolean;
	/** The folder has agent instructions (AGENTS.md, CLAUDE.md, copilot-instructions); null while unknown. */
	hasInstructions: boolean | null;
	hasCustomAgents: boolean;
	/** A setting's current value. */
	setting: (key: string) => unknown;
	/** What the user already did (chatTips.svelte.ts `record`). */
	used: ReadonlySet<string>;
};

export type TipDef = {
	id: string;
	tier: TipTier;
	/** Lower first within a tier; then catalog order. */
	priority?: number;
	/** The message, with `code` and [label](action) links. */
	key: MessageKey;
	/** The message's `{key}` parameter: a shortcut's label. */
	keyLabel?: 'model' | 'mode' | 'find';
	actions?: Record<string, TipAction>;
	when?: (c: TipContext) => boolean;
	/** Things the user did that make the tip pointless (they found the feature). */
	excludeWhenUsed?: readonly string[];
	/** Settings (with their defaults) whose change makes the tip pointless. */
	excludeWhenSettingsChanged?: readonly { key: string; default: unknown }[];
};

export const TIP_CATALOG: readonly TipDef[] = [
	{
		id: 'tip.init',
		tier: 'foundational',
		key: 'chatTips.init',
		actions: { init: { kind: 'generate' } },
		when: (c) => c.hasInstructions === false,
		excludeWhenUsed: ['init']
	},
	{
		id: 'tip.planMode',
		tier: 'foundational',
		key: 'chatTips.planMode',
		actions: { plan: { kind: 'mode', mode: 'plan' } },
		when: (c) => c.mode !== 'plan',
		excludeWhenUsed: ['mode:plan']
	},
	{
		id: 'tip.createAgent',
		tier: 'foundational',
		key: 'chatTips.createAgent',
		actions: { agent: { kind: 'command', id: 'workbench.command.new.agent' } },
		when: (c) => !c.hasCustomAgents,
		excludeWhenUsed: ['newAgent']
	},
	{ id: 'tip.attachFiles', tier: 'qol', key: 'chatTips.attachFiles', excludeWhenUsed: ['attach'] },
	{ id: 'tip.undoChanges', tier: 'qol', key: 'chatTips.undoChanges', when: (c) => c.rewind, excludeWhenUsed: ['restore'] },
	{ id: 'tip.messageQueueing', tier: 'qol', key: 'chatTips.messageQueueing', when: (c) => c.mode === 'agent', excludeWhenUsed: ['queue'] },
	{
		id: 'tip.forkConversation',
		tier: 'qol',
		key: 'chatTips.fork',
		actions: { fork: { kind: 'insert', text: '/fork' } },
		when: (c) => c.rewind,
		excludeWhenUsed: ['fork']
	},
	{ id: 'tip.sideChat', tier: 'qol', key: 'chatTips.sideChat', when: (c) => c.rewind, excludeWhenUsed: ['sideChat'] },
	{
		id: 'tip.mermaid',
		tier: 'qol',
		key: 'chatTips.mermaid',
		when: (c) => c.mode === 'agent',
		excludeWhenSettingsChanged: [{ key: 'chat.math.enabled', default: true }]
	},
	{ id: 'tip.modelPicker', tier: 'qol', key: 'chatTips.modelPicker', keyLabel: 'model', when: (c) => c.models, excludeWhenUsed: ['modelPicker'] },
	{ id: 'tip.modeCycle', tier: 'qol', key: 'chatTips.modeCycle', keyLabel: 'mode', excludeWhenUsed: ['modeCycle'] },
	{ id: 'tip.history', tier: 'qol', key: 'chatTips.history', actions: { history: { kind: 'history' } }, excludeWhenUsed: ['history'] },
	{ id: 'tip.findInChat', tier: 'qol', key: 'chatTips.findInChat', keyLabel: 'find' },
	{
		id: 'tip.permissions',
		tier: 'qol',
		key: 'chatTips.permissions',
		when: (c) => c.mode === 'agent',
		excludeWhenUsed: ['permissions'],
		excludeWhenSettingsChanged: [{ key: 'kingu.agent.permissionMode', default: 'default' }]
	}
];

const BY_ID = new Map(TIP_CATALOG.map((d) => [d.id, d]));
export const tipById = (id: string): TipDef | undefined => BY_ID.get(id);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function isEligible(tip: TipDef, c: TipContext): boolean {
	if (tip.excludeWhenSettingsChanged?.some((s) => c.setting(s.key) !== undefined && !same(c.setting(s.key), s.default))) return false;
	if (tip.excludeWhenUsed?.some((u) => c.used.has(u))) return false;
	return tip.when ? tip.when(c) : true;
}

function byPriority(list: readonly TipDef[], catalog: readonly TipDef[]): TipDef[] {
	const at = (d: TipDef) => catalog.indexOf(d);
	return [...list].sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity) || at(a) - at(b));
}

/** The tips that may show: foundational first, then the others, each by priority and catalog order. */
export function orderedTips(c: TipContext, dismissed: ReadonlySet<string>, catalog: readonly TipDef[] = TIP_CATALOG): TipDef[] {
	const ok = catalog.filter((d) => !dismissed.has(d.id) && isEligible(d, c));
	return [...byPriority(ok.filter((d) => d.tier === 'foundational'), catalog), ...byPriority(ok.filter((d) => d.tier === 'qol'), catalog)];
}

/** A fresh tip: the first foundational one, else a random other one. */
export function pickTip(c: TipContext, dismissed: ReadonlySet<string>, rng: () => number = Math.random, catalog: readonly TipDef[] = TIP_CATALOG): TipDef | undefined {
	const ok = orderedTips(c, dismissed, catalog);
	const first = ok.find((d) => d.tier === 'foundational');
	if (first) return first;
	return ok.length ? ok[Math.min(ok.length - 1, Math.floor(rng() * ok.length))] : undefined;
}

/** The tip to show: `shownId` while it may still show, else the next one after it, else a fresh pick. */
export function shownTip(
	shownId: string | null,
	c: TipContext,
	dismissed: ReadonlySet<string>,
	rng: () => number = Math.random,
	catalog: readonly TipDef[] = TIP_CATALOG
): TipDef | undefined {
	const at = shownId ? catalog.findIndex((d) => d.id === shownId) : -1;
	if (at < 0) return pickTip(c, dismissed, rng, catalog);
	const cur = catalog[at];
	if (!dismissed.has(cur.id) && isEligible(cur, c)) return cur;
	for (let i = 1; i < catalog.length; i++) {
		const d = catalog[(at + i) % catalog.length];
		if (!dismissed.has(d.id) && isEligible(d, c)) return d;
	}
	return undefined;
}

/** Previous / Next tip over the tips that may show (the current one kept in its place), wrapping. */
export function stepTip(currentId: string | null, dir: 1 | -1, c: TipContext, dismissed: ReadonlySet<string>, catalog: readonly TipDef[] = TIP_CATALOG): TipDef | undefined {
	const list = orderedTips(c, dismissed, catalog);
	if (!list.length) return undefined;
	const at = list.findIndex((d) => d.id === currentId);
	if (at < 0) return list[dir === 1 ? 0 : list.length - 1];
	return list[(at + dir + list.length) % list.length];
}

/**
 * Whether the card shows at all: tips on, not hidden for this session, an empty chat. No folder is
 * needed (VS Code's getWelcomeTip): the tips that need one say so in their own `when`.
 */
export function showTips(s: { enabled: boolean; hiddenForSession: boolean; empty: boolean }): boolean {
	return s.enabled && !s.hiddenForSession && s.empty;
}

export type TipPart = { kind: 'text'; text: string } | { kind: 'code'; text: string } | { kind: 'link'; text: string; action: string };

/** A tip message's pieces: plain text, `code` and [label](action) links. */
export function tipParts(message: string): TipPart[] {
	const out: TipPart[] = [];
	const re = /\[([^\]]+)\]\(([\w:-]+)\)|`([^`]+)`/g;
	let last = 0;
	for (let m = re.exec(message); m; m = re.exec(message)) {
		if (m.index > last) out.push({ kind: 'text', text: message.slice(last, m.index) });
		out.push(m[3] !== undefined ? { kind: 'code', text: m[3] } : { kind: 'link', text: m[1], action: m[2] });
		last = m.index + m[0].length;
	}
	if (last < message.length) out.push({ kind: 'text', text: message.slice(last) });
	return out;
}

/** Whether the folder's rules include agent instructions (what Generate Agent Instructions writes). */
export function hasAgentInstructions(rules: readonly { kind: string }[]): boolean {
	return rules.some((r) => r.kind === 'agents' || r.kind === 'copilot');
}

/**
 * Generate Agent Instructions (VS Code runs `/init` in Agent mode): Claude Code's own `/init`;
 * other agents get the same request written out.
 */
export function generateRequest(runtime: string, prompt: string): string {
	return runtime === 'claude' ? '/init' : prompt;
}
