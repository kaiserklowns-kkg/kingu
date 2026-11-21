// The task board's pop-out (Orca's Agent Dashboard "Open as Pop-out", dashboard-popout/ and
// shared/dashboard-snapshot.ts): the window that opened it builds this snapshot of the agent
// columns and sends it through Rust (windows.rs); the pop-out only draws it. Plain data, so it
// crosses windows as JSON; the pop-out's own search and Project filter work on it. Pure.

import { nestTasks } from './attempts';
import { splitIdle } from './boardSearch';
import { groupTasks, statusLabel, type TaskView } from './model';
import { projectName } from './projects';
import { statusDot } from './ui';
import type { Locale } from '#lib/i18n/index.ts';

export type PopoutCard = {
	/** Project and slug: unique across projects. */
	key: string;
	root: string;
	slug: string;
	title: string;
	summary: string;
	agent: string | null;
	branch: string | null;
	project: string;
	/** Status dot class (ui.ts) and its label. */
	dot: string;
	status: string;
	/** Last activity (ms), for "time ago". */
	when: number;
	/** Attempt / stacked-task nesting (attempts.ts). */
	depth: number;
};

export type PopoutLane = { id: string; label: string; hint: string; cards: PopoutCard[] };

/**
 * The terminal preview of the card the pop-out opened (Orca's AgentTerminalDialog, which shows
 * the agent's terminal: its screen and `PREVIEW_SCROLLBACK_ROWS` rows above it). `lines` is null
 * when that card has no agent terminal this window shows (Orca's "No preview available").
 * Terminal output can hold secrets: it is only kept in memory and sent between Kingu's windows.
 */
export type PopoutPreview = { key: string; lines: string[] | null };

export type PopoutSnapshot = {
	lanes: PopoutLane[];
	/** The feeding window's open folder, then the other added projects (the Project filter). */
	projects: { id: string; label: string }[];
	here: string;
	/** kingu.board.columnWidth and kingu.board.opacity (0–100). */
	width: number;
	opacity: number;
	locale: Locale;
	/** The theme's CSS variables on <html>, and whether it is dark. */
	theme: { vars: Record<string, string>; dark: boolean };
	/** Only while the pop-out shows a card's terminal preview. */
	preview?: PopoutPreview | null;
};

/** Orca's AgentTerminalPreview: PREVIEW_SCROLLBACK_ROWS, and the PTY grid it clamps to (2–500 × 2–200). */
export const PREVIEW_SCROLLBACK_ROWS = 24;
const PREVIEW_MAX_SCREEN_ROWS = 200;
const PREVIEW_MAX_COLS = 500;

/**
 * The rows a preview sends: the terminal's last rows (its screen and the scrollback above it, as
 * xterm laid them out, so already without escape sequences), with the empty rows under the
 * cursor dropped (Orca bottom-aligns the frame at its cursor end), at most `screenRows` (2–200)
 * plus PREVIEW_SCROLLBACK_ROWS rows of at most 500 characters, without control characters.
 */
export function previewLines(rows: readonly string[], screenRows: number): string[] {
	let end = rows.length;
	while (end > 0 && !rows[end - 1].trim()) end--;
	const keep = Math.min(Math.max(Math.floor(screenRows) || 0, 2), PREVIEW_MAX_SCREEN_ROWS) + PREVIEW_SCROLLBACK_ROWS;
	return rows.slice(Math.max(0, end - keep), end).map((row) => stripControls(row).slice(0, PREVIEW_MAX_COLS).trimEnd());
}

/** Escape sequences and control characters (but tabs) a row may still carry. */
export function stripControls(text: string): string {
	return text
		.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g, '')
		.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, '');
}

export type PopoutEntry = { root: string; view: TaskView; branch?: string | null };

/**
 * The agent columns (needs you / working / done, and Idle with kingu.board.showIdle) of every
 * project's tasks, as Board.svelte lays them out: done splits into Done (unread) and Idle (seen);
 * attempts and stacked tasks nest under their parent within a project.
 */
export function popoutLanes(entries: readonly PopoutEntry[], unread: ReadonlySet<string>, showIdle: boolean, columns: readonly { id: 'attention' | 'active' | 'done'; label: string; hint: string }[], idle: { label: string; hint: string }): PopoutLane[] {
	const keyOf = (e: PopoutEntry) => `${e.root}\u0000${e.view.meta.slug}`;
	const byView = new Map(entries.map((e) => [e.view, e]));
	const groups = groupTasks(entries.map((e) => e.view));
	const finished = splitIdle(
		groups.done.map((v) => ({ meta: { slug: keyOf(byView.get(v)!) }, v })),
		unread
	);
	const lane = (id: string, label: string, hint: string, views: TaskView[]): PopoutLane => ({
		id,
		label,
		hint,
		cards: nestTasks(
			views.map((v) => {
				const e = byView.get(v)!;
				const p = `${e.root}\u0000`;
				return { slug: p + v.meta.slug, parent: v.meta.parent ? p + v.meta.parent : v.meta.parent, group: v.meta.group ? p + v.meta.group : v.meta.group, entry: e };
			})
		).map(({ item, depth }) => card(item.entry, depth))
	});
	return [
		...columns.map((c) => lane(c.id, c.label, c.hint, c.id === 'done' ? finished.done.map((x) => x.v) : groups[c.id])),
		...(showIdle ? [lane('idle', idle.label, idle.hint, finished.idle.map((x) => x.v))] : [])
	];
}

function card({ root, view, branch }: PopoutEntry, depth: number): PopoutCard {
	const meta = view.meta;
	return {
		key: `${root}\u0000${meta.slug}`,
		root,
		slug: meta.slug,
		title: meta.title,
		summary: view.runtime?.lastEvent ?? meta.last_run?.summary ?? (meta.prompt.split('\n', 1)[0] || ''),
		agent: meta.agent ?? null,
		branch: branch ?? null,
		project: projectName(root),
		dot: statusDot(view),
		status: statusLabel(view),
		when: Math.max(meta.updated_at, view.runtime?.updatedAt ?? 0),
		depth
	};
}

/** The theme's custom properties set on an element (theme.svelte.ts writes them on <html>). */
export function cssVariables(style: Pick<CSSStyleDeclaration, 'length' | 'getPropertyValue'> & { [i: number]: string }): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < style.length; i++) {
		const name = style[i];
		if (name.startsWith('--')) out[name] = style.getPropertyValue(name);
	}
	return out;
}
