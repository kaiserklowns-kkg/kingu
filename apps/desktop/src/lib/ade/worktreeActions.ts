// Actions of a worktree card in the Agents side bar (Orca's worktree context menu) and the rows
// of the Worktree Jump palette. Pure: the menu is data; Svelte code runs the chosen id.

import { matchPaletteTokens, paletteQueryTokens } from './paletteMatch';
import type { TaskStatus } from './model';
import { t } from '#lib/i18n/index.ts';
import { emojiToShortcodes } from './emojiShortcodes.ts';

export type WorktreeAction =
	| 'open'
	| 'openInEditor'
	| 'openInChat'
	| 'continueInChat'
	| 'newTerminal'
	| 'quickOpen'
	| 'reveal'
	| 'copyBranch'
	| 'rename'
	| 'copyPath'
	| 'editDetails'
	| 'markDone'
	| 'reopen'
	| 'moveStatus'
	| 'continueSession'
	| 'handOff'
	| 'newFromTask'
	| 'compareAttempts'
	| 'remove'
	| `openIn:${string}`;

export type ActionRow = { id: WorktreeAction; label: string; enabled?: boolean } | 'separator';

/** At most this many `kingu.worktree.openIn` apps (Orca's Open In rows). */
export const MAX_OPEN_IN = 8;

/** The `kingu.worktree.openIn` labels with a non-empty command, in order, at most MAX_OPEN_IN. */
export function openInLabels(setting: Readonly<Record<string, unknown>> | undefined): string[] {
	return Object.entries(setting ?? {})
		.filter(([label, cmd]) => label.trim() && typeof cmd === 'string' && cmd.trim())
		.map(([label]) => label)
		.slice(0, MAX_OPEN_IN);
}

/**
 * The folder itself (`slug` null) or a task worktree; `running`: its agent is mid-turn. `openIn`:
 * Open In app labels. `sessions`: how many agent sessions the task has saved (Continue Session…).
 * `attempts`: the task is one of a best-of-N group (Compare Attempts…).
 */
export function worktreeActions(w: { slug: string | null; status?: TaskStatus; running?: boolean; hasWorktree?: boolean; openIn?: readonly string[]; sessions?: number; chatSessions?: number; attempts?: boolean }): ActionRow[] {
	const task = w.slug !== null;
	const rows: ActionRow[] = [
		{ id: 'open', label: t('adeTasks.worktree.open') },
		{ id: 'openInEditor', label: t('adeTasks.worktree.openInEditor') },
		{ id: 'newTerminal', label: t('adeTasks.worktree.newTerminal') },
		{ id: 'quickOpen', label: t('adeTasks.worktree.quickOpen'), enabled: !task || w.hasWorktree !== false },
		'separator',
		{ id: 'reveal', label: t('adeTasks.worktree.reveal'), enabled: !task || w.hasWorktree !== false },
		...(w.openIn ?? []).map((label): ActionRow => ({ id: `openIn:${label}`, label: t('adeTasks.worktree.openIn', { app: label }), enabled: !task || w.hasWorktree !== false })),
		{ id: 'copyPath', label: t('adeTasks.worktree.copyPath') }
	];
	if (!task) return rows;
	// docs/AI-SURFACES.md §9: a new IDE agent chat in the task's worktree, and one that continues a
	// claude session of the task there (sessionHandoff.ts) while its agent is stopped.
	rows.push(
		{ id: 'openInChat', label: t('adeTasks.worktree.openInChat'), enabled: w.hasWorktree !== false },
		{ id: 'continueInChat', label: t('adeTasks.worktree.continueInChat'), enabled: (w.chatSessions ?? 0) > 0 && !w.running && w.hasWorktree !== false }
	);
	rows.push({ id: 'copyBranch', label: t('adeTasks.worktree.copyBranch') }, { id: 'rename', label: t('adeTasks.worktree.rename') }, { id: 'editDetails', label: t('adeTasks.details.menu') }, 'separator');
	rows.push(w.status === 'done' ? { id: 'reopen', label: t('adeTasks.worktree.reopen') } : { id: 'markDone', label: t('adeTasks.worktree.markDone'), enabled: !w.running });
	// Orca's Move to Status and agent session continuation.
	const sessions = (w.sessions ?? 0) > 0 && !w.running && w.hasWorktree !== false;
	rows.push(
		{ id: 'moveStatus', label: t('adeWorkflow.action.moveStatus') },
		{ id: 'continueSession', label: t('adeWorkflow.action.continueSession'), enabled: sessions },
		{ id: 'handOff', label: t('adeWorkflow.action.handOff'), enabled: sessions },
		'separator'
	);
	// Stacked worktrees (Orca's lineage) and best-of-N attempts (attempts.svelte.ts).
	rows.push({ id: 'newFromTask', label: t('adeAttempts.action.newFromTask'), enabled: w.hasWorktree !== false });
	if (w.attempts) rows.push({ id: 'compareAttempts', label: t('adeAttempts.action.compare') });
	rows.push('separator');
	rows.push({ id: 'remove', label: t('adeTasks.worktree.remove'), enabled: !w.running });
	return rows;
}

/** A task as the jump palette ranks it. `seen`: when the user last opened it (appMode.viewedAt). */
export type JumpTask = { slug: string; title: string; status: TaskStatus; statusLabel: string; branch: string; pr?: number; updated: number; seen?: number };
export type JumpItem = { id: string; label: string; description: string; separator?: string; positions?: number[] };
/** Orca's jump palette shows this many recent rows before any typing (`worktree-jump` recents). */
export const JUMP_RECENT = 9;
export const JUMP_CREATE = 'create:';
export const JUMP_FOLDER = '__folder';

const NEEDS_YOU: readonly TaskStatus[] = ['waiting'];

/** Token matches (paletteMatch.ts) rank under every in-order fuzzy match, whose scores are far above this. */
const TOKEN_MATCH_BELOW = 1_000_000;

/**
 * Orca's Worktree Jump (⌘J, `components/worktree-jump`, docs model/quick-open.mdx). With nothing
 * typed: the worktrees that need you, then the most recently used (opened or active), then the
 * folder's own checkout. Typed text: `#123` / `123` finds the worktree of that PR, else a fuzzy
 * match on the title, then the branch; a last row creates a worktree named after the text.
 */
export function jumpItems(
	query: string,
	folder: { name: string; branch: string },
	tasks: JumpTask[],
	match: (q: string, target: string) => { score: number; positions: number[] } | null,
	labels: { needsYou: string; recent: string; folder: string; matches: string; create: (q: string) => string; createHint: string }
): JumpItem[] {
	const q = query.trim();
	const describe = (x: JumpTask) => [x.statusLabel, x.branch, x.pr ? `#${x.pr}` : ''].filter(Boolean).join(' · ');
	const folderItem: JumpItem = { id: JUMP_FOLDER, label: folder.name, description: `primary · ${folder.branch || 'HEAD'}` };
	if (!q) {
		const recency = (x: JumpTask) => Math.max(x.seen ?? 0, x.updated);
		const needs = tasks.filter((x) => NEEDS_YOU.includes(x.status)).sort((a, b) => recency(b) - recency(a));
		const rest = tasks.filter((x) => !NEEDS_YOU.includes(x.status)).sort((a, b) => recency(b) - recency(a)).slice(0, Math.max(0, JUMP_RECENT - needs.length));
		return [
			...needs.map((x, i) => ({ id: x.slug, label: x.title, description: describe(x), separator: i === 0 ? labels.needsYou : undefined })),
			...rest.map((x, i) => ({ id: x.slug, label: x.title, description: describe(x), separator: i === 0 ? labels.recent : undefined })),
			{ ...folderItem, separator: labels.folder }
		];
	}
	const pr = /^#?(\d+)$/.exec(q)?.[1];
	const tokens = paletteQueryTokens(q);
	const scored: { item: JumpItem; score: number }[] = [];
	for (const x of tasks) {
		if (pr && x.pr === Number(pr)) {
			scored.push({ item: { id: x.slug, label: x.title, description: describe(x) }, score: Infinity });
			continue;
		}
		const m = match(q, x.title);
		const b = m ? null : match(q, x.branch);
		// Orca: an emoji-named workspace matches by its shortcode (🚀 fix → "rocket").
		const e = m || b || !/[^\x00-\x7f]/.test(x.title) ? null : match(q, emojiToShortcodes(x.title).replace(/\s+/g, ' ').trim());
		if (m) scored.push({ item: { id: x.slug, label: x.title, description: describe(x), positions: m.positions }, score: m.score + 1000 });
		else if (b) scored.push({ item: { id: x.slug, label: x.title, description: describe(x) }, score: b.score });
		else if (e) scored.push({ item: { id: x.slug, label: x.title, description: describe(x) }, score: e.score + 500 });
		else {
			// Orca's palette matcher: words in another order, spread over title and branch, or one typo away.
			// Below every in-order match, so what was found before keeps its place.
			const w = tokens && matchPaletteTokens(tokens, [x.title, x.branch]);
			if (w) scored.push({ item: { id: x.slug, label: x.title, description: describe(x), positions: w.positions }, score: w.score - TOKEN_MATCH_BELOW });
		}
	}
	const f = match(q, folder.name);
	if (f) scored.push({ item: { ...folderItem, positions: f.positions }, score: f.score });
	const found = scored.sort((a, b) => b.score - a.score).map((s, i) => ({ ...s.item, separator: i === 0 ? labels.matches : undefined }));
	return [...found, { id: JUMP_CREATE + q, label: labels.create(q), description: labels.createHint }];
}
