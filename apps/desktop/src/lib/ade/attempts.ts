// Best-of-N attempts and stacked worktrees (Cursor's best-of-N "Agent in Worktree", Orca's
// worktree lineage): one prompt run as up to four attempts in worktrees `<slug>-a`, `<slug>-b`…
// sharing a group id in tasks.json, each with its own model; and tasks forked from another task's
// branch (`parent`), listed under it. Pure, so `bun test` covers it.

import { slugify } from '#lib/agent/events.ts';
import { aggregateStats, type StatTotals, type TaskMeta, type TaskStatus, type TaskView } from './model';

export const MAX_ATTEMPTS = 4;
const LETTERS = 'abcd';
const MAX_SLUG = 48;
const MAX_MODEL = 128;

/** Mirrors Rust `tasks::valid_model`: one CLI argument word, never a flag. */
export function validModel(m: string): boolean {
	return m.length > 0 && m.length <= MAX_MODEL && !m.startsWith('-') && /^[A-Za-z0-9._\-/:@]+$/.test(m);
}

/**
 * The group id and the attempt slugs (`<group>-a`, `<group>-b`…) for `count` attempts of `title`:
 * the first base (`fix-login`, `fix-login-2`…) none of whose attempt slugs is taken.
 */
export function attemptSlugs(title: string, count: number, taken: ReadonlySet<string>): { group: string; slugs: string[] } {
	const n = Math.max(1, Math.min(MAX_ATTEMPTS, Math.floor(count)));
	const root = slugify(title).slice(0, MAX_SLUG - 2).replace(/-+$/, '');
	for (let k = 1; ; k++) {
		const suffix = k === 1 ? '' : `-${k}`;
		const group = root.slice(0, MAX_SLUG - 2 - suffix.length).replace(/-+$/, '') + suffix;
		const slugs = [...LETTERS.slice(0, n)].map((l) => `${group}-${l}`);
		if (!taken.has(group) && slugs.every((s) => !taken.has(s))) return { group, slugs };
	}
}

/** "A", "B"… of an attempt (its slug's last letter), or null for a task in no group. */
export function attemptLetter(meta: Pick<TaskMeta, 'slug' | 'group'>): string | null {
	if (!meta.group) return null;
	const m = /-([a-z])$/.exec(meta.slug);
	return m && meta.slug === `${meta.group}-${m[1]}` ? m[1].toUpperCase() : null;
}

/**
 * `argv` started with `model`: an existing `--model x`, `--model=x` or `-m x` is replaced, else
 * `--model <model>` is added (claude, codex, gemini, opencode, cursor-agent, copilot, aider all take it).
 */
export function withModel(argv: readonly string[], model: string | null | undefined): string[] {
	if (!model) return [...argv];
	const out: string[] = [];
	let replaced = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if ((a === '--model' || a === '-m') && i + 1 < argv.length) {
			out.push(a, model);
			i++;
			replaced = true;
		} else if (a.startsWith('--model=')) {
			out.push(`--model=${model}`);
			replaced = true;
		} else out.push(a);
	}
	return replaced ? out : [...out, '--model', model];
}

/** Claude's model aliases, offered in the attempt rows (any model name the agent takes works). */
export const MODEL_SUGGESTIONS = ['opus', 'sonnet', 'haiku'];

/** The attempt rows of the form: `count` models, keeping what was typed for the rows that stay. */
export function resizeModels(models: readonly string[], count: number): string[] {
	return Array.from({ length: Math.max(1, Math.min(MAX_ATTEMPTS, count)) }, (_, i) => models[i] ?? '');
}

// ---------------------------------------------------------------------------------------------
// Compare

export type AttemptColumn = {
	slug: string;
	letter: string;
	title: string;
	model: string | null;
	status: TaskStatus;
	totals: StatTotals | null;
	/** Changed files, most lines changed first. */
	files: { path: string; added: number | null; deleted: number | null; status: string }[];
	/** Files only this attempt changed. */
	only: number;
	cost: number | null;
	turns: number | null;
	error: string | null;
};

/** The attempts of `group`, A first, as compare columns (diffstat side by side). */
export function compareColumns(views: readonly TaskView[], group: string): AttemptColumn[] {
	const members = views.filter((v) => v.meta.group === group).sort((a, b) => a.meta.slug.localeCompare(b.meta.slug));
	const counts = new Map<string, number>();
	for (const v of members) for (const f of v.stat?.files ?? []) counts.set(f.path, (counts.get(f.path) ?? 0) + 1);
	const size = (f: { added: number | null; deleted: number | null }) => (f.added ?? 0) + (f.deleted ?? 0);
	return members.map((v) => {
		const files = [...(v.stat?.files ?? [])].sort((a, b) => size(b) - size(a) || a.path.localeCompare(b.path));
		return {
			slug: v.meta.slug,
			letter: attemptLetter(v.meta) ?? '?',
			title: v.meta.title,
			model: v.meta.attempt_model ?? v.runtime?.model ?? v.meta.model ?? null,
			status: v.status,
			totals: v.stat ? aggregateStats(v.stat.files) : null,
			files: files.map((f) => ({ path: f.path, added: f.added, deleted: f.deleted, status: f.status })),
			only: files.filter((f) => counts.get(f.path) === 1).length,
			cost: v.meta.last_run?.cost_usd ?? null,
			turns: v.meta.last_run?.num_turns ?? null,
			error: v.statError ?? null
		};
	});
}

/** The other attempts of the winner's group: what Pick winner offers to clean up. */
export function losersOf(list: readonly Pick<TaskMeta, 'slug' | 'group'>[], winner: string): string[] {
	const group = list.find((t) => t.slug === winner)?.group;
	return group ? list.filter((t) => t.group === group && t.slug !== winner).map((t) => t.slug) : [];
}

// ---------------------------------------------------------------------------------------------
// Side bar and board order

export type Nested<T> = { item: T; depth: number };

/**
 * A sorted task list with each task's stacked children right after it (one level deeper) and the
 * attempts of a group together where the first of them sorted, A first. A task whose parent is not
 * in the list (removed, or filtered out) stays where it sorted.
 */
export function nestTasks<T extends { slug: string; parent?: string | null; group?: string | null }>(list: readonly T[]): Nested<T>[] {
	const present = new Set(list.map((t) => t.slug));
	const children = new Map<string, T[]>();
	const roots: T[] = [];
	for (const t of list) {
		if (t.parent && t.parent !== t.slug && present.has(t.parent)) children.set(t.parent, [...(children.get(t.parent) ?? []), t]);
		else roots.push(t);
	}
	const clump = (items: T[]): T[] => {
		const out: T[] = [];
		const placed = new Set<string>();
		for (const t of items) {
			if (placed.has(t.slug)) continue;
			const members = t.group ? items.filter((x) => x.group === t.group).sort((a, b) => a.slug.localeCompare(b.slug)) : [t];
			for (const m of members) {
				out.push(m);
				placed.add(m.slug);
			}
		}
		return out;
	};
	const out: Nested<T>[] = [];
	const seen = new Set<string>();
	const visit = (t: T, depth: number) => {
		if (seen.has(t.slug)) return;
		seen.add(t.slug);
		out.push({ item: t, depth });
		for (const c of clump(children.get(t.slug) ?? [])) visit(c, depth + 1);
	};
	for (const t of clump(roots)) visit(t, 0);
	// A parent cycle (hand-edited tasks.json) has no root: its tasks still show, at the top level.
	for (const t of list) visit(t, 0);
	return out;
}

/** A stacked task's PR goes into its parent's branch (its base, or the parent's branch now): Rust pushes that branch first. */
export function isStackedBase(meta: Pick<TaskMeta, 'parent' | 'base'>, base: string, branchOf: (slug: string) => string | null): boolean {
	return !!meta.parent && (base === meta.base || base === branchOf(meta.parent));
}
