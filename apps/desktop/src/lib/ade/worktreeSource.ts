// Where a new task's worktree branch comes from (Orca's new-workspace composer): a new branch
// from the base, an existing branch (Orca's "Reuse branch"), or a GitHub pull request; and the
// first-work branch name (Orca's branch-name-from-work.ts). Pure, so `bun test` covers it; Rust
// agent/worktree_from.rs does the git side.

import type { BranchRef } from '#lib/workbench/scmRemote.ts';

export type TaskSource = { kind: 'new' } | { kind: 'branch'; branch: string } | { kind: 'pr'; pr: string };

/** Mirrors Rust `worktree_from::PrHead`. */
export type PrHead = {
	number: number;
	title: string;
	url: string;
	state: string;
	draft: boolean;
	head_ref: string;
	base_ref: string;
	cross_repo: boolean;
	head_owner: string;
	head_repo: string;
	maintainer_can_modify: boolean;
	author: string;
	updated_at: string;
};

/** A branch to start from: local ones first, then remote ones without a local branch of their name. */
export type BranchChoice = { name: string; remote: boolean; /** Checked out in another worktree (git refuses it). */ busy: string | null };

export function branchChoices(refs: BranchRef[]): BranchChoice[] {
	const local = refs.filter((r) => !r.remote && !r.tag);
	const names = new Set(local.map((r) => r.name));
	const remote = refs.filter((r) => r.remote && !names.has(r.name.slice(r.name.indexOf('/') + 1)));
	return [
		...local.map((r) => ({ name: r.name, remote: false, busy: r.current ? '.' : (r.worktree ?? null) })),
		...remote.map((r) => ({ name: r.name, remote: true, busy: null }))
	];
}

/** The task title for a branch: its last segment in words (`kingu/fix-login` → `fix login`). */
export function branchTitle(branch: string): string {
	const leaf = branch.slice(branch.lastIndexOf('/') + 1);
	return leaf.replace(/[-_]+/g, ' ').trim() || branch;
}

/** What the user typed is a PR: `123`, `#123` or a GitHub pull request link (Rust checks it again). */
export function looksLikePr(input: string): boolean {
	const s = input.trim();
	if (/^#?\d+$/.test(s)) return Number(s.replace('#', '')) > 0;
	return /^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+/.test(s);
}

/** The task title for a PR (`#12 Fix login`), within tasks.json's limit. */
export const prTitle = (pr: Pick<PrHead, 'number' | 'title'>) => `#${pr.number} ${pr.title}`.trim().slice(0, 200);

// ---------------------------------------------------------------------------------------------
// The branch name from the first work (Orca's autoRenameBranchFromWork)

/** Orca's MAX_BRANCH_NAME_WORDS: a long model answer still makes a short branch. */
export const MAX_BRANCH_WORDS = 4;
const MAX_INSTRUCTIONS = 4000;
const MAX_PROMPT = 8000;

/** Orca's buildBranchNamePrompt: the user's naming guidance first, then the task. */
export function branchNamePrompt(firstPrompt: string, instructions?: string): string {
	const custom = (instructions ?? '').trim().slice(0, MAX_INSTRUCTIONS);
	return [
		...(custom ? [custom, ''] : []),
		custom ? 'Generate a git branch name that summarizes the coding task described below.' : 'Generate a short git branch name that summarizes the coding task described below.',
		'Output ONLY the branch name on a single line, nothing else.',
		'',
		'User request:',
		firstPrompt.trim().slice(0, MAX_PROMPT)
	].join('\n');
}

/**
 * Orca's sanitizeBranchSlug + stripConfiguredBranchPrefix: the answer's first line as at most
 * four kebab-case words of a-z and 0-9, without the configured prefix the model sometimes echoes
 * (`kingu/fix-login` → `fix-login`). Empty when nothing usable remains (the rename is skipped).
 */
export function branchSlug(answer: string, prefix: string): string {
	const line = answer.replace(/```[a-z]*/gi, '').trim().split('\n')[0] ?? '';
	const words = line
		.toLowerCase()
		.replace(/^(?:branch(?: name)?)\s*:\s*/, '')
		.replace(/[^a-z0-9]+/g, '-')
		.split('-')
		.filter(Boolean);
	const slug = words.slice(0, MAX_BRANCH_WORDS + 3).join('-');
	const p = prefix
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	const stripped = !p ? slug : slug === p ? '' : slug.startsWith(`${p}-`) ? slug.slice(p.length + 1) : slug;
	return stripped.split('-').filter(Boolean).slice(0, MAX_BRANCH_WORDS).join('-').slice(0, 48).replace(/-+$/, '');
}
