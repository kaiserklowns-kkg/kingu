// Issues page state (Orca's Tasks from GitHub): the open folder's GitHub issues through `gh`
// (Rust `agent/issues.rs`), the filters, the "Start task" confirm and the palette's
// "Issues: Start Task from Issue…". Issues load when the page opens or a filter changes, never on
// their own in the background.

import { invoke } from '@tauri-apps/api/core';
import { untrack } from 'svelte';
import { clientLog } from '#lib/client-log.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { adeLayout } from './adeLayout.svelte.ts';
import type { RunMode } from './agentCli.ts';
import { isFolderGithub, issueRef, mergeIssueLists, tasksByIssue, type Issue } from './issues.ts';
import { openLink } from './trackerApi.ts';
import type { IssueLink } from './model.ts';
import { adeTasks } from './tasks.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';

export type IssueFilter = { mine: boolean; label: string; search: string };
const LIMIT = 50;

export const defaultBase = () => adeTasks.defaultBase();

class AdeIssues {
	list = $state<Issue[]>([]);
	loading = $state(false);
	error = $state<string | null>(null);
	/** The filters the current list was loaded with ran at least once. */
	loaded = $state(false);
	filter = $state<IssueFilter>({ mine: true, label: '', search: '' });
	/** The Start task confirm of one row. */
	confirming = $state<Issue | null>(null);
	/** Issue number → the slug of the task started from it. */
	tasks = $derived(tasksByIssue(adeTasks.list));

	#seq = 0;

	fetch(f: { mine: boolean; label?: string; search?: string; limit?: number }): Promise<Issue[]> {
		return invoke<Issue[]>('gh_issues_list', {
			state: 'open',
			assignee: f.mine ? '@me' : null,
			label: f.label?.trim() || null,
			search: f.search?.trim() || null,
			limit: f.limit ?? LIMIT
		});
	}

	async load() {
		if (!workspace.root) return;
		const seq = ++this.#seq;
		this.loading = true;
		this.error = null;
		try {
			const list = await this.fetch($state.snapshot(this.filter));
			if (seq !== this.#seq) return;
			this.list = list;
		} catch (e) {
			if (seq !== this.#seq) return;
			this.list = [];
			this.error = String(e);
			clientLog('info', `gh_issues_list: ${e}`);
		} finally {
			if (seq === this.#seq) {
				this.loading = false;
				this.loaded = true;
			}
		}
	}

	reset() {
		this.#seq++;
		this.list = [];
		this.error = null;
		this.loaded = false;
		this.loading = false;
		this.confirming = null;
	}

	/** The confirm's Start: creates the task (or offers the existing one). */
	async start(issue: Issue, base: string, mode: RunMode) {
		const slug = await adeTasks.createFromIssue(issue, { base, mode });
		if (slug) this.confirming = null;
		return slug;
	}

	/** A GitHub issue through gh; a task's link to another tracker in the browser. */
	open(issue: Pick<Issue, 'number'> | IssueLink) {
		if ('url' in issue && !isFolderGithub(issue)) {
			return openLink(issue).catch((e) => notifications.error(t('adeTasks.issues.openFailed', { ref: issueRef(issue), error: String(e) })));
		}
		return invoke('gh_issue_open', { number: issue.number }).catch((e) => notifications.error(t('adeTasks.issues.openFailed', { ref: `#${issue.number}`, error: String(e) })));
	}

	openPage() {
		if (!appMode.isAgents) appMode.setMode('agents');
		appMode.sessionsVisible = true;
		adeLayout.page = 'issues';
	}

	/** Palette: an open issue (assigned to me first), then the base branch and run mode, then the task. */
	async pickAndStart() {
		status.flash(t('adeTasks.issues.loading'), 3000);
		let mine: Issue[];
		let all: Issue[];
		try {
			[mine, all] = await Promise.all([this.fetch({ mine: true }), this.fetch({ mine: false, limit: 100 })]);
		} catch (e) {
			notifications.error(t('adeTasks.issues.loadFailed', { error: String(e) }));
			return;
		}
		const rows = mergeIssueLists(mine, all);
		if (!rows.length) {
			status.flash(t('adeTasks.issues.none'));
			return;
		}
		const firstOther = rows.findIndex((r) => !r.mine);
		const picked = await quick.choose({
			placeholder: t('adeTasks.issues.pickPlaceholder'),
			items: rows.map((r, i) => ({
				id: String(r.issue.number),
				label: `#${r.issue.number} ${r.issue.title}`,
				description: [this.tasks.has(r.issue.number) ? t('adeTasks.issues.hasTask') : '', ...r.issue.labels.map((l) => l.name)].filter(Boolean).join(' · ') || undefined,
				separator: i === 0 && r.mine ? t('adeTasks.issues.assignedToMe') : i === firstOther ? t('adeTasks.issues.allOpen') : undefined
			}))
		});
		const issue = picked && rows.find((r) => String(r.issue.number) === picked.id)?.issue;
		if (!issue) return;
		const existing = this.tasks.get(issue.number);
		if (existing) {
			// createFromIssue asks whether to open it.
			await adeTasks.createFromIssue(issue, { base: defaultBase() });
			return;
		}
		await adeTasks.refreshBranches();
		const current = defaultBase();
		const branches = adeTasks.branches.length ? [current, ...adeTasks.branches.filter((b) => b !== current)] : [''];
		const base = await quick.choose({
			placeholder: t('adeTasks.issues.basePlaceholder', { ref: `#${issue.number}` }),
			items: branches.map((b) => ({ id: b, label: b || 'HEAD', description: b === current ? t('adeTasks.issues.currentBranch') : undefined }))
		});
		if (!base) return;
		await adeTasks.createFromIssue(issue, { base: base.id, mode: 'terminal' });
	}
}

export const issues = new AdeIssues();

/** Workbench wiring: forgets the list per folder, registers the palette command. */
export function installIssues(): () => void {
	const stop = $effect.root(() => {
		$effect(() => {
			void workspace.root;
			untrack(() => issues.reset());
		});
	});
	const hasRoot = () => workspace.root !== null;
	const unregister = [
		commands.register({ id: 'kingu.issues.startTask', title: 'Issues: Start Task from Issue…', category: 'Agents', when: hasRoot, run: () => issues.pickAndStart() }),
		commands.register({ id: 'kingu.issues.show', title: 'Issues: Show', category: 'Agents', when: hasRoot, run: () => issues.openPage() })
	];
	return () => {
		stop();
		unregister.forEach((u) => u());
	};
}
