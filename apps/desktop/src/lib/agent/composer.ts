// The agent chat composer's behaviour (a Cursor-style input: one rounded box with inline context
// chips, image thumbnails, a bottom bar with the mode pill, the model label and one round
// send / stop button), pure so `bun test` covers it. Composer.svelte and AgentPanel.svelte draw it.
//
//   modeTone / MODE_ICON / cycleMode   the mode pill: its colour and icon, ⌘. / ⇧Tab to the next mode
//   composerPlaceholder                the input's placeholder for the chat's state (one for every mode)
//   enterAction                        what Enter does with its modifiers (⌘Enter-to-send setting)
//   approvalKey                        ⏎ Run / ⇧⏎ Allowlist / Esc Skip while a tool waits
//   primaryAction                      the round button: send, queue, stop or nothing to send
//   browseHistory                      ⌥↑ / ⌥↓ through earlier prompts, the draft kept
//   composerLayout                     which labels the bottom bar keeps at the box's width
//   slashMenu                          the `/` menu's sections, Skills folded to 3 rows
//   chromeKey                          keys typed while focus is on the composer's own buttons
//   shortModelLabel / allowlistLabel   compact labels for the model trigger and the Allow button
//   moveItem                           reordering a queued message

import type { IconName } from '#lib/workbench/Icon.svelte';
import { t } from '#lib/i18n/index.ts';
import type { AgentApproval } from './chatInput.ts';
import type { ModePick } from './customizations.ts';
import type { SlashItem, SlashSource } from './slashCommands.ts';

// ---- modes -----------------------------------------------------------------------------------

/** The mode pill's look: Agent is neutral, Ask green, Plan yellow, a custom agent purple (Cursor's per-mode colours). */
export type ModeTone = 'agent' | 'ask' | 'plan' | 'custom';

export const modeTone = (pick: ModePick): ModeTone => (pick === 'agent' || pick === 'ask' || pick === 'plan' ? pick : 'custom');

export const MODE_ICON: Record<ModeTone, IconName> = { agent: 'infinity', ask: 'chat', plan: 'listChecks', custom: 'robot' };

/** A custom agent's name (`custom:<name>`), else null. */
export const customName = (pick: ModePick): string | null => (pick.startsWith('custom:') ? pick.slice(7) : null);

/** The mode menu's order, which ⌘. / ⇧Tab walk through (Cursor's: Agent, Plan, …, Ask), then the custom agents. */
export function modeOrder(customAgents: readonly string[]): ModePick[] {
	return ['agent', 'plan', 'ask', ...customAgents.map((n) => `custom:${n}` as const)];
}

/** The next (or previous) mode after `current`, wrapping; an unknown current starts from the first. */
export function cycleMode(order: readonly ModePick[], current: ModePick, dir: 1 | -1 = 1): ModePick {
	if (!order.length) return current;
	const i = order.indexOf(current);
	if (i < 0) return order[0];
	return order[(i + dir + order.length) % order.length];
}

// ---- run modes (Cursor's Ask Every Time / Allowlist / Run Everything) -------------------------

/** How each of Kingu's Agent approvals is named in the composer, Cursor's run modes where they match. */
export function runModeLabel(a: AgentApproval): string {
	return a === 'default' ? t('composer.run.ask') : a === 'acceptEdits' ? t('composer.run.edits') : t('composer.run.all');
}

export function runModeHint(a: AgentApproval): string {
	return a === 'default' ? t('composer.run.askHint') : a === 'acceptEdits' ? t('composer.run.editsHint') : t('composer.run.allHint');
}

// ---- placeholder -----------------------------------------------------------------------------

export type PlaceholderState = {
	/** A folder is open (the chat needs one). */
	folder: boolean;
	/** The input holds a queued message being edited. */
	editingQueued?: boolean;
	/** A tool call waits for approval: typed text answers it. */
	pendingApproval?: boolean;
	/** A turn is running: what is sent now is queued. */
	running?: boolean;
	/** The chat already has messages. */
	followUp?: boolean;
};

/**
 * The input's placeholder: the first rule that applies, else Cursor's one line for every mode
 * ("Plan, Build, / for skills, @ for context"; it does not change with the mode).
 */
export function composerPlaceholder(s: PlaceholderState): string {
	if (!s.folder) return t('chat.panel.noFolder');
	if (s.editingQueued) return t('composer.placeholder.editingQueued');
	if (s.pendingApproval) return t('composer.placeholder.pending');
	// While the agent works, and after: "Add a follow-up"; an empty chat gets Cursor's one line.
	return s.running || s.followUp ? t('composer.placeholder.followUp') : t('composer.placeholder.new');
}

// ---- keys ------------------------------------------------------------------------------------

export type KeyLike = { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; repeat?: boolean; isComposing?: boolean };

/**
 * Enter in the input:
 *   submit      send (while a turn runs: the default queue action)
 *   submitAlt   ⌥: the other of queue / steer while a turn runs
 *   submitStop  ⌘ (Ctrl elsewhere): stop the running turn and send (Cursor's primary-modifier override)
 *   ignore      a held-down Enter: neither sends again nor adds lines
 *   null        not ours (⇧Enter's new line; Enter itself when ⌘Enter sends)
 * With `cmdEnter` (Submit with ⌘Enter) ⌘Enter sends, ⌘⌥Enter stops and sends, Enter adds a line.
 */
export function enterAction(e: KeyLike, opts: { cmdEnter: boolean; mac: boolean }): 'submit' | 'submitAlt' | 'submitStop' | 'ignore' | null {
	if (e.key !== 'Enter' || e.isComposing || e.shiftKey) return null;
	const primary = opts.mac ? e.metaKey : e.ctrlKey;
	const other = opts.mac ? e.ctrlKey : e.metaKey;
	if (other) return null;
	if (e.repeat) return 'ignore';
	if (opts.cmdEnter) {
		if (!primary) return null;
		return e.altKey ? 'submitStop' : 'submit';
	}
	if (primary) return 'submitStop';
	return e.altKey ? 'submitAlt' : 'submit';
}

/** While a tool call waits and the input is empty: ⏎ Run, ⇧⏎ add to the allowlist and run, Esc Skip. */
export function approvalKey(e: KeyLike, empty: boolean): 'allow' | 'allowlist' | 'skip' | null {
	if (!empty || e.isComposing || e.altKey || e.metaKey || e.ctrlKey) return null;
	if (e.key === 'Escape' && !e.shiftKey) return 'skip';
	if (e.key === 'Enter') return e.shiftKey ? 'allowlist' : 'allow';
	return null;
}

/** ⌘. (Ctrl+. elsewhere) or ⇧Tab: the next mode; ⌘⇧. / ⇧⌥Tab are not ours. */
export function modeCycleKey(e: KeyLike, mac: boolean): boolean {
	if (e.isComposing) return false;
	const primary = mac ? e.metaKey : e.ctrlKey;
	if (e.key === 'Tab') return e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
	return e.key === '.' && primary && !e.shiftKey && !e.altKey;
}

/** ⌘⇧⌫ (Ctrl+Shift+Backspace elsewhere), or ⌃C on macOS with nothing selected: stop the agent. */
export function stopKey(e: KeyLike, mac: boolean, hasSelection: boolean): boolean {
	if (e.isComposing) return false;
	const primary = mac ? e.metaKey : e.ctrlKey;
	if (e.key === 'Backspace' && primary && e.shiftKey && !e.altKey) return true;
	return mac && !hasSelection && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c';
}

// ---- the round button ------------------------------------------------------------------------

/** The round button: send (↑), queue (↑ while a turn runs), stop (■ while a turn runs and the input is empty), or none (↑ disabled). */
export type PrimaryAction = 'send' | 'queue' | 'stop' | 'none';

export function primaryAction(s: { running: boolean; hasText: boolean; canStop: boolean }): PrimaryAction {
	if (s.running) return s.hasText ? 'queue' : s.canStop ? 'stop' : 'none';
	return s.hasText ? 'send' : 'none';
}

// ---- ⌥↑ / ⌥↓ history -------------------------------------------------------------------------

/** Where history browsing is: `index` into the prompts (null: the user's own text), `draft` what was typed before. */
export type HistoryNav = { index: number | null; draft: string };
export const NO_HISTORY: HistoryNav = { index: null, draft: '' };

/**
 * ⌥↑ steps back through `history` (oldest first) from the newest, keeping what was typed; ⌥↓ steps
 * forward and past the newest gives the draft back. null: nothing to do.
 */
export function browseHistory(history: readonly string[], nav: HistoryNav, dir: 'up' | 'down', value: string): { nav: HistoryNav; text: string } | null {
	if (!history.length) return null;
	const browsing = nav.index !== null && nav.index < history.length && history[nav.index] === value;
	if (!browsing) {
		if (dir === 'down') return null;
		const index = history.length - 1;
		return { nav: { index, draft: value }, text: history[index] };
	}
	const i = nav.index as number;
	if (dir === 'up') return i > 0 ? { nav: { index: i - 1, draft: nav.draft }, text: history[i - 1] } : null;
	if (i < history.length - 1) return { nav: { index: i + 1, draft: nav.draft }, text: history[i + 1] };
	return { nav: NO_HISTORY, text: nav.draft };
}

/** Plain ↑ / ↓ browse too, only from an empty input or while browsing, and only from the first / last line. */
export function plainArrowBrowses(value: string, nav: HistoryNav, history: readonly string[], dir: 'up' | 'down', before: string, after: string): boolean {
	if (dir === 'up' ? before.includes('\n') : after.includes('\n')) return false;
	const browsing = nav.index !== null && history[nav.index] === value;
	return browsing || (dir === 'up' && !value.trim());
}

// ---- responsive bottom bar -------------------------------------------------------------------

/** What the bottom bar shows at the composer's width (Cursor hides labels below ~300px, the ring at 260px). */
export function composerLayout(width: number): { modeLabel: boolean; modelLabel: boolean; ring: boolean; optionsLabel: boolean } {
	if (width <= 0) return { modeLabel: true, modelLabel: true, ring: true, optionsLabel: true };
	return { modeLabel: width >= 300, modelLabel: width > 260, ring: width > 260, optionsLabel: width >= 420 };
}

// ---- labels ----------------------------------------------------------------------------------

/** The model trigger's short name: no `claude-` prefix, release date, `-thinking` or "(…)" note. */
export function shortModelLabel(label: string): string {
	let s = label.trim();
	s = s.replace(/\s*\([^)]*\)\s*$/, '');
	s = s.replace(/^claude-/i, '');
	s = s.replace(/-\d{8}$/, '');
	s = s.replace(/[-\s]thinking$/i, '');
	return s || label;
}

/**
 * The Allow button's label: the command prefix an "always" answer saves (`Bash(npm test:*)` →
 * `npm test *`), the tool for a single whole-tool rule, else "Always Allow".
 */
export function allowlistLabel(rules: readonly string[] | undefined, tool: string): string {
	if (rules?.length === 1) {
		const m = /^([\w.-]+)\((.*)\)$/.exec(rules[0]);
		if (m) return m[2].replace(/:\*$/, ' *');
		return rules[0];
	}
	if (rules && rules.length > 1) return t('composer.approve.allowlistMany', { count: rules.length });
	return t('composer.approve.allowlistTool', { tool });
}

// ---- menus -----------------------------------------------------------------------------------

/** The `/` menu's sections, in Cursor's order: Skills, Commands, Modes, Actions. */
export type SlashSection = 'skills' | 'commands' | 'modes' | 'actions';
const SLASH_ORDER: SlashSection[] = ['skills', 'commands', 'modes', 'actions'];

export function slashSection(source: SlashSource): SlashSection {
	if (source === 'project-skill' || source === 'user-skill') return 'skills';
	if (source === 'mode') return 'modes';
	if (source === 'kingu') return 'actions';
	return 'commands';
}

/** The filtered `/` items grouped by section (in list order within one), each section's first item marked. */
export function slashSections<T extends SlashItem>(items: readonly T[]): (T & { section: SlashSection; first: boolean })[] {
	const out: (T & { section: SlashSection; first: boolean })[] = [];
	for (const section of SLASH_ORDER) {
		const rows = items.filter((i) => slashSection(i.source) === section);
		rows.forEach((r, i) => out.push({ ...r, section, first: i === 0 }));
	}
	return out;
}

/** Skills the `/` menu shows before "Show N more" (Cursor's). */
export const SKILLS_SHOWN = 3;

export type SlashEntry<T> = { kind: 'item'; item: T & { section: SlashSection; first: boolean } } | { kind: 'more'; count: number };

/**
 * The `/` menu's rows: the sections, with Skills folded to `SKILLS_SHOWN` rows and a "Show N
 * more" row while nothing is typed and the list was not unfolded (`expanded`).
 */
export function slashMenu<T extends SlashItem>(items: readonly T[], opts: { query: string; expanded: boolean }): SlashEntry<T>[] {
	const rows = slashSections(items);
	const skills = rows.filter((r) => r.section === 'skills');
	const fold = !opts.query && !opts.expanded && skills.length > SKILLS_SHOWN + 1;
	const out: SlashEntry<T>[] = [];
	let shown = 0;
	for (const r of rows) {
		if (fold && r.section === 'skills') {
			if (shown < SKILLS_SHOWN) out.push({ kind: 'item', item: r });
			else if (shown === SKILLS_SHOWN) out.push({ kind: 'more', count: skills.length - SKILLS_SHOWN });
			shown++;
			continue;
		}
		out.push({ kind: 'item', item: r });
	}
	return out;
}

/** Moves the item at `from` to `to` (both clamped); the same list when nothing moves. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
	if (from < 0 || from >= list.length) return [...list];
	const target = Math.max(0, Math.min(list.length - 1, to));
	if (target === from) return [...list];
	const out = [...list];
	const [item] = out.splice(from, 1);
	out.splice(target, 0, item);
	return out;
}

/**
 * A key pressed while focus is on one of the composer's own controls (the mode pill, the model
 * label, the paperclip), not its text: ⇧Tab still switches the mode, and a character goes into
 * the input (so `@` opens the context menu there instead of acting on the focused button).
 */
export function chromeKey(e: KeyLike): 'cycle' | 'type' | null {
	if (e.isComposing) return null;
	if (e.key === 'Tab' && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) return 'cycle';
	if (e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey) return 'type';
	return null;
}

/** Whether a runtime can take a message while a turn runs (steer); the others stop and send. */
export const canSteer = (protocol: string | null | undefined): boolean => !protocol || protocol === 'claude';
