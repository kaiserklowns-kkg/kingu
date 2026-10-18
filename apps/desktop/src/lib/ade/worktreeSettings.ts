// How new task worktrees are made, from the ADE settings (Orca's worktree settings): the branch
// prefix, the default base branch and what happens to the branch when a task is removed. Pure,
// so `bun test` covers it; Rust checks the prefix again (agent/worktree.rs validate_prefix).

import { t } from '#lib/i18n/index.ts';

export const DEFAULT_BRANCH_PREFIX = 'kingu/';

/** The same rules as Rust's `validate_prefix`: ASCII letters, digits and `._/-`, may be empty. */
export function validBranchPrefix(prefix: string): boolean {
	return (
		prefix.length <= 64 &&
		/^[A-Za-z0-9._/-]*$/.test(prefix) &&
		!/^[-/.]/.test(prefix) &&
		!prefix.includes('..') &&
		!prefix.includes('//') &&
		!prefix.includes('/.')
	);
}

/** `kingu.worktree.branchPrefix` trimmed, or null when it is invalid (creating then refuses). */
export function branchPrefix(setting: string | undefined): string | null {
	const p = (setting ?? DEFAULT_BRANCH_PREFIX).trim();
	return validBranchPrefix(p) ? p : null;
}

/**
 * The base branch a new task starts from when the form has no pick: `kingu.worktree.baseBranch`
 * when that branch exists, else the folder's current branch, else the first local branch.
 */
export function defaultBaseBranch(setting: string | undefined, current: string | null | undefined, branches: readonly string[]): string {
	const wanted = (setting ?? '').trim();
	if (wanted && branches.includes(wanted)) return wanted;
	if (current && branches.includes(current)) return current;
	return branches[0] ?? '';
}

/** What Rust's `worktree_remove` does with the branch: keep it, `git branch -d`, or `-D`. */
export type BranchRemoval = 'keep' | 'safe' | 'force';

/**
 * What removing a task does with its branch (`kingu.worktree.deleteBranchOnRemove`, Orca's
 * default): `deleteMerged` deletes it when git sees it merged (`-d`), or for sure once Kingu knows
 * it was merged (locally, or its PR, which a squash merge leaves unmerged for git); `delete`
 * always; `keep` never.
 */
export function branchRemoval(setting: string | undefined, task: { merged: boolean }): BranchRemoval {
	if (setting === 'keep') return 'keep';
	if (setting === 'delete') return 'force';
	return task.merged ? 'force' : 'safe';
}

export type WorktreeScript = { path: string; content: string; hash: string; trusted: boolean };
/** Rust `scripts::ScriptPlan`: what runs for one kind — the repository's (trusted or not) and / or yours. */
export type ScriptPlan = { shared: WorktreeScript | null; local: string | null };
export type ScriptKind = 'setup' | 'archive' | 'tabs' | 'issue';

/** Rust `kingu_yaml::KinguYaml`: the repository's kingu.yaml, normalised. */
export type DefaultTab = { title: string | null; color: string | null; command: string | null };
export type KinguYaml = {
	scripts: { setup: string | null; archive: string | null };
	setupAgentStartupPolicy: 'start-immediately' | 'wait-for-setup' | null;
	issueCommand: string | null;
	defaultTabs: DefaultTab[];
	sharedDirectories: string[];
	warnings: string[];
};
export type KinguYamlStatus = { found: boolean; config: KinguYaml | null; error: string | null };

/** The default tabs' commands as Rust's `scripts::tabs_text` writes them (what you trust together). */
export function tabsText(tabs: readonly DefaultTab[]): string | null {
	const parts = tabs.filter((t) => t.command).map((t) => `# ${t.title ?? 'Terminal'}\n${t.command}`);
	return parts.length ? `${parts.join('\n\n')}\n` : null;
}

/**
 * The terminal tabs to open in a new worktree from kingu.yaml `defaultTabs`: with their commands
 * only when `trusted` is exactly the text you trusted (else, or under `local-only`, plain tabs).
 */
export function defaultTabsToOpen(tabs: readonly DefaultTab[], trusted: string | null): { title?: string; color?: string; run?: string[] }[] {
	const runCommands = trusted !== null && trusted === tabsText(tabs);
	return tabs.map((t) => ({
		...(t.title ? { title: t.title } : {}),
		...(t.color ? { color: t.color } : {}),
		...(runCommands && t.command ? { run: ['sh', '-c', t.command] } : {})
	}));
}

/** `kingu.worktree.setupAgentStartup`; when you never set it, kingu.yaml's setupAgentStartupPolicy. */
export function agentStartup(setting: string | undefined, setByYou: boolean, yaml: string | null | undefined): 'start-immediately' | 'wait-for-setup' {
	const v = setByYou ? setting : (yaml ?? setting);
	return v === 'wait-for-setup' ? 'wait-for-setup' : 'start-immediately';
}

/**
 * Orca's issue command in a terminal: `{{issue}}` and `{{artifact_url}}` become the shell
 * variables KINGU_ISSUE / KINGU_ARTIFACT_URL (set with `env`), so an issue's URL is never pasted
 * into the command text.
 */
export function issueCommandArgv(command: string, issue: number, url: string): string[] {
	const text = command.replaceAll('{{issue}}', '"$KINGU_ISSUE"').replaceAll('{{artifact_url}}', '"$KINGU_ARTIFACT_URL"');
	return ['env', `KINGU_ISSUE=${issue}`, `KINGU_ARTIFACT_URL=${url}`, 'sh', '-c', text];
}
export type ScriptRun = { code: number | null; timed_out: boolean; output: string };

/**
 * The setup terminal's command: the trusted copy of `.kingu/setup.sh`, told where the folder and
 * worktree are (Orca's ORCA_ROOT_PATH / ORCA_WORKTREE_PATH / ORCA_WORKSPACE_NAME).
 */
export function setupCommand(file: string, root: string, worktree: string, slug: string, marker?: string): string[] {
	const env = ['env', `KINGU_ROOT_PATH=${root}`, `KINGU_WORKTREE_PATH=${worktree}`, `KINGU_WORKSPACE_NAME=${slug}`];
	// wait-for-setup: the exit status goes to `marker`, which the agent's start waits for.
	if (marker) return [...env, 'sh', '-c', 'sh "$1"; s=$?; printf %s "$s" > "$2"; exit "$s"', 'kingu-setup', file, marker];
	return [...env, 'sh', file];
}

/** `kingu.worktree.setupScript`: run a trusted script without asking, ask every time, or never. */
export type SetupPolicy = 'auto' | 'ask' | 'off';
export const setupPolicy = (setting: string | undefined): SetupPolicy => (setting === 'ask' || setting === 'off' ? setting : 'auto');

/** The archive script's result in one line for the status bar or the dialog. */
export function scriptRunSummary(r: ScriptRun): string {
	if (r.timed_out) return t('adeTasks.worktreeSettings.timedOut');
	if (r.code === 0) return t('adeTasks.worktreeSettings.succeeded');
	return r.code === null ? t('adeTasks.worktreeSettings.interrupted') : t('adeTasks.worktreeSettings.exited', { code: r.code });
}

/** What the trust dialog shows of a script: its first lines, so a long one stays readable. */
export function scriptPreview(content: string, maxLines = 20): string {
	const lines = content.replace(/\s+$/, '').split('\n');
	return lines.length > maxLines ? [...lines.slice(0, maxLines), t('adeTasks.worktreeSettings.moreLines', { count: lines.length - maxLines })].join('\n') : lines.join('\n');
}

/** The remove dialog's branch choice (defaults from `branchRemoval`); `label` is read in the current UI language. */
export const BRANCH_CHOICES: { readonly id: BranchRemoval; readonly label: string }[] = (['keep', 'safe', 'force'] as const).map((id) => ({
	id,
	get label() {
		return t(`adeTasks.worktreeSettings.branch.${id}`);
	}
}));

/** Orca's DeleteWorktreeTargetPreview limit: changed paths listed in the remove dialog. */
export const DIRTY_PREVIEW = 10;

/**
 * Orca's dirty-change hint: one count for every status entry (modified and untracked together),
 * the first `DIRTY_PREVIEW` paths with their letter, and how many more.
 */
export function dirtyPreview(entries: { path: string; index: string | null; worktree: string | null; conflict?: boolean }[]) {
	const files = entries.slice(0, DIRTY_PREVIEW).map((e) => ({ path: e.path, letter: e.conflict ? '!' : e.worktree === '?' ? 'U' : (e.worktree ?? e.index ?? 'M'), conflict: !!e.conflict }));
	return { count: entries.length, files, more: Math.max(0, entries.length - files.length) };
}

export const dirtyLabel = (n: number) => (n === 0 ? t('adeTasks.worktreeSettings.dirtyNone') : t('adeTasks.worktreeSettings.dirtyCount', { count: n }));
