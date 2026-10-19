// The unified Issues page (old Kingu's Tasks page): every connected tracker in one list with a
// source filter. GitHub issues of the open folder (gh), a GitHub Project's issues
// (`kingu.github.project`, gh), Linear, GitLab (`kingu.gitlab.host`, the folder's remote or
// `kingu.gitlab.project`) and Jira (`kingu.jira.jql`). Tokens live in the Keychain on the Rust side,
// never here. "Start task" works for every row: GitHub and Linear through their own task makers,
// the others through `startFrom`, all with a branch carrying the issue key. Rows load when the page
// opens or a filter changes, never in the background.

import { invoke } from '@tauri-apps/api/core';
import { untrack } from 'svelte';
import { clientLog } from '#lib/client-log.ts';
import { t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { ask } from '#lib/workbench/messageBox.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick, type PickItem } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import type { RunMode } from './agentCli.ts';
import { issues, defaultBase, defaultRunMode } from './issues.svelte.ts';
import type { Issue, IssueDetail } from './issues.ts';
import { linear } from './linear.svelte.ts';
import { adeTasks } from './tasks.svelte.ts';
import { gitlabHost, openLink } from './trackerApi.ts';
import {
	SOURCE_NAMES,
	fromGithub,
	fromGitlab,
	fromJira,
	fromLinear,
	fromProject,
	gitlabPrompt,
	jiraPrompt,
	projectPrompt,
	sortItems,
	sourceSlug,
	sourceTaskTitle,
	taskForLink,
	tasksByLink,
	type GitlabList,
	type GitlabViewer,
	type JiraFilter,
	type JiraIssue,
	type JiraIssueDetail,
	type JiraViewer,
	type ProjectItems,
	type ProjectSummary,
	type SourceId,
	type SourceItem
} from './taskSources.ts';

export type SourceFilter = { mine: boolean; label: string; search: string };
const LIMIT = 50;

class AdeSources {
	gitlab = $state<GitlabViewer | null>(null);
	jira = $state<JiraViewer | null>(null);
	/** The Connect dialog open for GitLab or Jira. */
	connecting = $state<'gitlab' | 'jira' | null>(null);

	items = $state<SourceItem[]>([]);
	loading = $state(false);
	loaded = $state(false);
	/** Per source: why it could not be listed. */
	errors = $state<Partial<Record<SourceId, string>>>({});
	/** The source filter: one tracker, or all of them. */
	only = $state<SourceId | null>(null);
	filter = $state<SourceFilter>({ mine: true, label: '', search: '' });
	/** The Start task confirm of one row. */
	confirming = $state<SourceItem | null>(null);
	/** The GitHub Project's title once listed. */
	projectTitle = $state('');
	/** Row id → the slug of the task started from it. */
	tasks = $derived(tasksByLink(adeTasks.list));

	#seq = 0;

	project = () => settings.get<string>('kingu.github.project')?.trim() || '';
	gitlabProject = () => settings.get<string>('kingu.gitlab.project')?.trim() || null;
	jql = () => settings.get<string>('kingu.jira.jql')?.trim() || null;

	/** The sources the page lists now: GitHub with a folder open, the others once set up. */
	enabled(): SourceId[] {
		const on: SourceId[] = [];
		if (workspace.root) on.push('github');
		if (this.project()) on.push('project');
		if (linear.viewer) on.push('linear');
		if (this.gitlab && workspace.root) on.push('gitlab');
		if (this.jira) on.push('jira');
		return on;
	}

	/** Asks Rust which trackers have stored credentials (each answers on its own). */
	async refreshConnections() {
		const host = gitlabHost();
		await Promise.all([
			linear.refresh(),
			invoke<GitlabViewer | null>('gitlab_status', { host }).then(
				(v) => (this.gitlab = v),
				(e) => clientLog('info', `gitlab_status: ${e}`)
			),
			invoke<JiraViewer | null>('jira_status').then(
				(v) => (this.jira = v),
				(e) => clientLog('info', `jira_status: ${e}`)
			)
		]);
	}

	/** One source's rows for `f`. */
	async fetch(source: SourceId, f: { mine: boolean; label?: string; search?: string; limit?: number }): Promise<SourceItem[]> {
		const label = f.label?.trim() || null;
		const search = f.search?.trim() || null;
		const limit = f.limit ?? LIMIT;
		switch (source) {
			case 'github':
				return (await issues.fetch(f)).map(fromGithub);
			case 'linear':
				// Linear has no label filter here; its search covers labels.
				return (await linear.fetch(f.mine ? 'assigned' : 'open', { search: search ?? undefined, limit })).map(fromLinear);
			case 'gitlab': {
				const list = await invoke<GitlabList>('gitlab_issues_list', { host: gitlabHost(), project: this.gitlabProject(), mine: f.mine, label, search, limit });
				return list.issues.map((i) => fromGitlab(i, list.project));
			}
			case 'jira': {
				const filter: JiraFilter = f.mine ? 'assigned' : 'open';
				return (await invoke<JiraIssue[]>('jira_issues_list', { filter, jql: this.jql(), label, search, limit })).map(fromJira);
			}
			case 'project': {
				const list = await invoke<ProjectItems>('gh_project_items', { project: this.project(), mine: f.mine, label, search, limit });
				this.projectTitle = list.title;
				return list.items.map(fromProject);
			}
		}
	}

	/** Every enabled source (or just the filtered one), side by side; one failing leaves the others listed. */
	async load() {
		const seq = ++this.#seq;
		this.loading = true;
		if (!this.loaded) await this.refreshConnections();
		if (seq !== this.#seq) return;
		const sources = this.enabled().filter((s) => !this.only || s === this.only);
		const f = $state.snapshot(this.filter);
		const results = await Promise.allSettled(sources.map((s) => this.fetch(s, f)));
		if (seq !== this.#seq) return;
		const errors: Partial<Record<SourceId, string>> = {};
		const items: SourceItem[] = [];
		results.forEach((r, i) => {
			if (r.status === 'fulfilled') items.push(...r.value);
			else {
				errors[sources[i]] = String(r.reason);
				clientLog('info', `issues ${sources[i]}: ${r.reason}`);
			}
		});
		this.items = sortItems(items);
		this.errors = errors;
		this.loading = false;
		this.loaded = true;
	}

	reset() {
		this.#seq++;
		this.items = [];
		this.errors = {};
		this.loaded = false;
		this.loading = false;
		this.confirming = null;
	}

	open(item: SourceItem) {
		return openLink(item.link).catch((e) => notifications.error(t('adeTasks.issues.openFailed', { ref: item.ref, error: String(e) })));
	}

	/** The confirm's Start: creates the task (or offers the existing one). */
	async start(item: SourceItem, base: string, mode: RunMode) {
		const slug = await this.startFrom(item, { base, mode });
		if (slug) this.confirming = null;
		return slug;
	}

	/**
	 * A task for any row: GitHub and Linear through their task makers; GitLab, Jira and GitHub
	 * Project issues with the issue (and its latest comments when the tracker answers) in the
	 * prompt and a branch `kingu/<key>-<words>`. An existing task for the issue is offered instead.
	 */
	async startFrom(item: SourceItem, opts: { base: string; mode?: RunMode }): Promise<string | undefined> {
		const raw = item.raw;
		if (raw.source === 'github') return adeTasks.createFromIssue(raw.issue, opts);
		if (raw.source === 'linear') return adeTasks.createFromLinearIssue(raw.issue, opts);
		const existing = taskForLink(adeTasks.list, item.link);
		if (existing) {
			const open = await ask(t('adeSources.taskExists', { ref: item.ref, title: existing.title, branch: adeTasks.branchOf(existing.slug) }), {
				title: t('adeSources.taskExistsTitle'),
				okLabel: t('adeTasks.tasks.openExisting'),
				cancelLabel: t('common.cancel')
			});
			if (open) adeTasks.openTask(existing.slug);
			return;
		}
		let prompt: string;
		if (raw.source === 'gitlab') {
			const detail = await invoke<IssueDetail>('gitlab_issue_view', { host: gitlabHost(), key: item.link.key }).catch((e): Issue => {
				clientLog('info', `gitlab_issue_view ${item.link.key}: ${e}`);
				return raw.issue;
			});
			prompt = gitlabPrompt(detail, raw.project);
		} else if (raw.source === 'jira') {
			const detail = await invoke<JiraIssueDetail>('jira_issue_view', { key: raw.issue.key }).catch((e): JiraIssue => {
				clientLog('info', `jira_issue_view ${raw.issue.key}: ${e}`);
				return raw.issue;
			});
			prompt = jiraPrompt(detail);
		} else {
			const detail = await invoke<IssueDetail>('gh_project_issue_view', { url: raw.item.url }).catch((e) => {
				clientLog('info', `gh_project_issue_view ${raw.item.url}: ${e}`);
				return undefined;
			});
			prompt = projectPrompt(raw.item, detail);
		}
		return adeTasks.create({ title: sourceTaskTitle(item), prompt, base: opts.base, mode: opts.mode, slug: sourceSlug(item), issue: item.link });
	}

	/** Palette: a row from any connected tracker (mine first), then the base branch and run mode, then the task. */
	async pickAndStart() {
		status.flash(t('adeTasks.issues.loading'), 3000);
		await this.refreshConnections();
		const sources = this.enabled();
		const settled = await Promise.allSettled(sources.flatMap((s) => [this.fetch(s, { mine: true }), this.fetch(s, { mine: false, limit: 100 })]));
		const failed = settled.flatMap((r, i) => (r.status === 'rejected' && i % 2 === 0 ? [`${SOURCE_NAMES[sources[i / 2]]}: ${r.reason}`] : []));
		if (failed.length) notifications.error(t('adeTasks.issues.loadFailed', { error: failed.join('\n') }));
		const seen = new Set<string>();
		const rows: { item: SourceItem; mine: boolean }[] = [];
		settled.forEach((r, i) => {
			if (r.status !== 'fulfilled') return;
			for (const item of r.value) if (!seen.has(item.id)) (seen.add(item.id), rows.push({ item, mine: i % 2 === 0 }));
		});
		rows.sort((a, b) => Number(b.mine) - Number(a.mine));
		if (!rows.length) {
			if (!failed.length) status.flash(t('adeTasks.issues.none'));
			return;
		}
		const firstOther = rows.findIndex((r) => !r.mine);
		const picked = await quick.choose({
			placeholder: t('adeTasks.issues.pickPlaceholder'),
			items: rows.map((r, i) => ({
				id: r.item.id,
				label: `${r.item.ref} ${r.item.title}`,
				description: [SOURCE_NAMES[r.item.source], this.tasks.has(r.item.id) ? t('adeTasks.issues.hasTask') : '', ...r.item.facts, ...r.item.labels.map((l) => l.name)].filter(Boolean).join(' · '),
				separator: i === 0 && r.mine ? t('adeTasks.issues.assignedToMe') : i === firstOther ? t('adeTasks.issues.allOpen') : undefined
			}))
		});
		const item = picked && rows.find((r) => r.item.id === picked.id)?.item;
		if (!item) return;
		if (this.tasks.has(item.id)) {
			// startFrom asks whether to open it.
			await this.startFrom(item, { base: defaultBase() });
			return;
		}
		await adeTasks.refreshBranches();
		const current = defaultBase();
		const branches = adeTasks.branches.length ? [current, ...adeTasks.branches.filter((b) => b !== current)] : [''];
		const base = await quick.choose({
			placeholder: t('adeTasks.issues.basePlaceholder', { ref: item.ref }),
			items: branches.map((b) => ({ id: b, label: b || 'HEAD', description: b === current ? t('adeTasks.issues.currentBranch') : undefined }))
		});
		if (!base) return;
		const preferred = defaultRunMode();
		const modes: { id: RunMode; label: string }[] = [
			{ id: 'terminal', label: `Terminal · ${settings.get<string>('kingu.agent.cli') || 'claude'}` },
			{ id: 'timeline', label: 'Timeline' }
		];
		const mode = await quick.choose({ placeholder: t('adeTasks.issues.runModePlaceholder'), items: [...modes].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred)) });
		if (!mode) return;
		await this.startFrom(item, { base: base.id, mode: mode.id as RunMode });
	}

	/** The dialog's submit: Rust checks the credentials with the tracker before storing them. Throws the reason. */
	async connectGitlab(host: string, token: string) {
		const h = host.trim() || 'gitlab.com';
		this.gitlab = await invoke<GitlabViewer>('gitlab_connect', { host: h, token });
		if (h !== gitlabHost()) await settings.set('kingu.gitlab.host', h, 'user');
		status.flash(t('adeSources.connected', { service: 'GitLab', name: `${this.gitlab.name} (${this.gitlab.host})` }), 6000);
		void this.load();
	}

	async connectJira(site: string, email: string, token: string) {
		this.jira = await invoke<JiraViewer>('jira_connect', { site, email, token });
		status.flash(t('adeSources.connected', { service: 'Jira', name: `${this.jira.name} (${this.jira.site})` }), 6000);
		void this.load();
	}

	async disconnect(source: 'gitlab' | 'jira') {
		const name = SOURCE_NAMES[source];
		if (!(await quick.choose({ placeholder: t('adeSources.disconnectAsk', { service: name }), items: [{ id: 'yes', label: t('adeTasks.linear.disconnect') }] }))) return;
		try {
			if (source === 'gitlab') {
				await invoke('gitlab_disconnect', { host: gitlabHost() });
				this.gitlab = null;
			} else {
				await invoke('jira_disconnect');
				this.jira = null;
			}
			this.items = this.items.filter((i) => i.source !== source);
			status.flash(t('adeSources.disconnected', { service: name }));
		} catch (e) {
			notifications.error(String(e));
		}
	}

	/** Picks `kingu.github.project` from the gh user's and their organisations' projects (or a typed `owner/number`). */
	async chooseProject() {
		status.flash(t('adeSources.project.loading'), 3000);
		let list: ProjectSummary[] = [];
		try {
			list = await invoke<ProjectSummary[]>('gh_projects_list');
		} catch (e) {
			notifications.error(t('adeSources.project.listFailed', { error: String(e) }));
		}
		const current = this.project();
		const items: PickItem[] = [
			...list.map((p) => ({ id: p.id, label: p.title || p.id, description: p.id === current ? `${p.id} · ${t('adeSources.project.current')}` : p.id })),
			...(current ? [{ id: '', label: t('adeSources.project.none') }] : [])
		];
		const picked = await quick.choose({
			placeholder: t('adeSources.project.pickPlaceholder'),
			items,
			// The list filtered by the typed text, plus the typed `owner/number` itself.
			dynamic: (value) => {
				const v = value.trim();
				const shown = v ? items.filter((i) => `${i.label} ${i.description ?? ''}`.toLowerCase().includes(v.toLowerCase())) : items;
				return /^[A-Za-z0-9@][A-Za-z0-9-]*\/\d+$/.test(v) && !shown.some((i) => i.id === v) ? [{ id: v, label: t('adeSources.project.useTyped', { project: v }) }, ...shown] : shown;
			}
		});
		if (!picked) return;
		await settings.set('kingu.github.project', picked.id || undefined, 'user');
		this.only = picked.id ? 'project' : this.only === 'project' ? null : this.only;
		void this.load();
	}
}

export const sources = new AdeSources();

/** Workbench wiring: forgets the rows per folder, registers the palette commands. */
export function installTaskSources(): () => void {
	const stop = $effect.root(() => {
		$effect(() => {
			void workspace.root;
			untrack(() => sources.reset());
		});
	});
	const hasRoot = () => workspace.root !== null;
	const unregister = [
		commands.register({ id: 'kingu.sources.startTask', title: 'Issues: Start Task from Any Tracker…', category: 'Agents', when: hasRoot, run: () => sources.pickAndStart() }),
		commands.register({ id: 'kingu.gitlab.connect', title: 'GitLab: Connect…', category: 'Agents', run: () => void (sources.connecting = 'gitlab') }),
		commands.register({ id: 'kingu.gitlab.disconnect', title: 'GitLab: Disconnect', category: 'Agents', run: () => sources.disconnect('gitlab') }),
		commands.register({ id: 'kingu.jira.connect', title: 'Jira: Connect…', category: 'Agents', run: () => void (sources.connecting = 'jira') }),
		commands.register({ id: 'kingu.jira.disconnect', title: 'Jira: Disconnect', category: 'Agents', run: () => sources.disconnect('jira') }),
		commands.register({ id: 'kingu.githubProjects.choose', title: 'GitHub Projects: Choose Project…', category: 'Agents', run: () => sources.chooseProject() })
	];
	return () => {
		stop();
		unregister.forEach((u) => u());
	};
}
