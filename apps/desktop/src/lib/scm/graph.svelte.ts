// The Source Control Graph view's model (VS Code's SCMHistoryViewPane): the commits of one
// repository (the active one, or the one picked in the view's title), `scm.graph.pageSize` at a
// time, laid out by graph.ts. It reads again when the repository's HEAD, upstream or
// ahead/behind counts change, when a git operation ends, and when its settings change. A row
// expands to the files its commit changed; the context menu's actions live here too.

import { invoke } from '@tauri-apps/api/core';
import { untrack } from 'svelte';
import { clientLog } from '#lib/client-log.ts';
import { locale, t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { scm, type Repository } from '#lib/workbench/scm.svelte.ts';
import { refDiffKey } from '#lib/workbench/scm.ts';
import { entryKey } from '#lib/workbench/scmRepos.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { fromNow } from './blame';
import { appendPage, commitHover, commitMessage, INCOMING_ID, layoutGraph, OUTGOING_ID, pageSize, rowBadges, type GraphCommit, type GraphPage, type GraphRow } from './graph';
import { checkoutDetached, cherryPick, createTag } from './gitCommands.svelte';
import { refItems } from './gitPicks';
import { rangeChangesKey } from './rangeChanges';

/** A changed file of a commit (Rust `git_graph::ChangedFile`). */
export type ChangedFile = { status: string; path: string; old_path: string | null };

const get = <T>(id: string) => settings.get<T>(id);
const OPEN_KEY = 'kingu.scmGraph.open';

class Graph {
	/** The section is expanded (per window, like a view's collapsed state). */
	open = $state(true);
	/** The repository the user picked in the title (null: follow the active one). */
	picked = $state<string | null>(null);
	/** Every branch and tag instead of HEAD and its upstream (the title's filter). */
	all = $state(false);
	page = $state.raw<Omit<GraphPage, 'commits'> | null>(null);
	commits = $state.raw<GraphCommit[]>([]);
	loading = $state(false);
	more = $state(false);
	error = $state('');
	/** Expanded rows: their files, or null while they load. */
	expanded = $state<Record<string, ChangedFile[] | null>>({});
	#seq = 0;
	#for = '';

	repository: Repository | null = $derived(scm.repositories.find((r) => r.dir === this.picked) ?? scm.active);

	rows: GraphRow[] = $derived.by(() => {
		const p = this.page;
		return layoutGraph(this.commits, {
			head: p?.head,
			upstream: p?.upstream,
			mergeBase: p?.merge_base,
			outgoingRow: get<boolean>('scm.graph.showOutgoingChanges') && !this.all,
			incomingRow: get<boolean>('scm.graph.showIncomingChanges') && !this.all,
			labels: { outgoing: t('scmGraph.outgoingChanges'), incoming: t('scmGraph.incomingChanges') }
		});
	});

	/** What the graph depends on besides its settings: re-read when it changes. */
	#stamp(r: Repository | null) {
		const st = r?.repo;
		return st ? [r.dir, st.head, st.branch, st.upstream, st.ahead, st.behind, this.all, get('scm.graph.pageSize'), get('scm.graph.showIncomingChanges')].join('|') : '';
	}

	/** Reads the first page again when the repository moved (or `force`). */
	async refresh(force = false) {
		const r = this.repository;
		const stamp = this.#stamp(r);
		if (!force && stamp === this.#for) return;
		this.#for = stamp;
		const my = ++this.#seq;
		this.expanded = {};
		if (!r?.repo) {
			this.commits = [];
			this.page = null;
			this.more = false;
			return;
		}
		this.loading = true;
		try {
			const page = await invoke<GraphPage>('scm_graph_log', r.args({ options: this.#options(0) }));
			if (my !== this.#seq) return;
			if (!page) {
				this.commits = [];
				this.page = null;
				this.more = false;
				this.error = '';
				return;
			}
			const { commits, ...rest } = page;
			this.page = rest;
			this.commits = commits;
			this.more = commits.length >= pageSize(get('scm.graph.pageSize'));
			this.error = '';
		} catch (e) {
			clientLog('info', `scm graph ${r.dir}: ${e}`);
			if (my === this.#seq) ((this.commits = []), (this.error = String(e)));
		} finally {
			if (my === this.#seq) this.loading = false;
		}
	}

	#options(skip: number) {
		return { limit: pageSize(get('scm.graph.pageSize')), skip, incoming: get<boolean>('scm.graph.showIncomingChanges'), all: this.all };
	}

	/** The next `scm.graph.pageSize` commits. */
	async loadMore() {
		const r = this.repository;
		if (!r || this.loading || !this.more) return;
		const my = this.#seq;
		this.loading = true;
		try {
			const page = await invoke<GraphPage>('scm_graph_log', r.args({ options: this.#options(this.commits.length) }));
			if (my !== this.#seq) return;
			this.commits = appendPage(this.commits, page.commits);
			this.more = page.commits.length >= pageSize(get('scm.graph.pageSize'));
		} catch (e) {
			clientLog('info', `scm graph ${r.dir}: ${e}`);
		} finally {
			if (my === this.#seq) this.loading = false;
		}
	}

	// -------------------------------------------------------------------------------------------
	// Rows

	/** Expands or collapses a commit's files (loaded the first time). */
	async toggle(row: GraphRow) {
		const r = this.repository;
		const hash = row.commit.hash;
		if (!r) return;
		if (hash in this.expanded) {
			const next = { ...this.expanded };
			delete next[hash];
			this.expanded = next;
			return;
		}
		this.expanded = { ...this.expanded, [hash]: null };
		const range = this.#range(row);
		try {
			const files = await invoke<ChangedFile[]>('scm_changed_files', r.args({ from: range.from, to: range.to }));
			if (hash in this.expanded) this.expanded = { ...this.expanded, [hash]: files };
		} catch (e) {
			notifications.error(e);
			const next = { ...this.expanded };
			delete next[hash];
			this.expanded = next;
		}
	}

	/** The revisions a row's changes are between: a commit against its first parent; the virtual
	 * rows the merge base against HEAD or the upstream. */
	#range(row: GraphRow): { from: string | null; to: string } {
		const p = this.page;
		if (row.kind === 'outgoing-changes') return { from: p?.merge_base ?? null, to: p?.head ?? 'HEAD' };
		if (row.kind === 'incoming-changes') return { from: p?.merge_base ?? null, to: p?.upstream?.hash ?? 'HEAD' };
		return { from: null, to: row.commit.hash };
	}

	/** A changed file of `row` as the diff of its two revisions. */
	openFile(row: GraphRow, f: ChangedFile, preview = true) {
		const r = this.repository;
		if (!r) return;
		const { from, to } = this.#range(row);
		const key = (rel: string) => entryKey(r.dir, rel, workspace.folders);
		appMode.setMode('workbench');
		editors.open(refDiffKey(from ?? `${to}^`, to, key(f.path), f.old_path ? key(f.old_path) : null), { preview });
	}

	/** Open Changes: every file of the row on one page. */
	openChanges(row: GraphRow) {
		const r = this.repository;
		if (!r) return;
		const { from, to } = this.#range(row);
		const title = row.kind === 'commit' ? `${row.commit.hash.slice(0, this.#hashLength())} - ${row.commit.subject}` : row.commit.subject;
		appMode.setMode('workbench');
		editors.open(rangeChangesKey(r.dir, from, to, title), { preview: false });
	}

	#hashLength() {
		const n = get<number>('git.commitShortHashLength');
		return typeof n === 'number' && n >= 4 && n <= 40 ? n : 7;
	}

	/** Compare with…: a branch or tag the user picks (left) ↔ the commit (right). */
	async compareWith(row: GraphRow) {
		const r = this.repository;
		if (!r) return;
		const refs = await r.refs({ tags: true });
		if (!refs) return;
		const short = row.commit.hash.slice(0, this.#hashLength());
		const pick = await quick.choose({
			placeholder: t('scmGraph.pickCompare', { commit: short }),
			items: refItems(refs, { branches: t('scmGit.branches'), remotes: t('scmGit.remoteBranches'), tags: t('scmGit.tags') }, { skipCurrent: false })
		});
		if (pick) this.#compare(r, pick.id, row);
	}

	/** Compare with Remote: the upstream ↔ the commit. */
	compareWithRemote(row: GraphRow) {
		const r = this.repository;
		const up = this.page?.upstream;
		if (r && up) this.#compare(r, up.name, row);
	}

	/** Compare with Merge Base: HEAD's merge base with its upstream ↔ the commit. */
	compareWithMergeBase(row: GraphRow) {
		const r = this.repository;
		const base = this.page?.merge_base;
		if (r && base) this.#compare(r, base, row, t('scmGraph.mergeBase'));
	}

	#compare(r: Repository, ref: string, row: GraphRow, label = ref) {
		const short = row.commit.hash.slice(0, this.#hashLength());
		appMode.setMode('workbench');
		editors.open(rangeChangesKey(r.dir, ref, row.commit.hash, `${label} ↔ ${short}`), { preview: false });
	}

	checkout(row: GraphRow) {
		const r = this.repository;
		if (r) void checkoutDetached(r, row.commit.hash);
	}

	createBranch(row: GraphRow) {
		void this.repository?.createBranch(row.commit.hash);
	}

	createTag(row: GraphRow) {
		const r = this.repository;
		if (r) void createTag(r, row.commit.hash);
	}

	cherryPick(row: GraphRow) {
		const r = this.repository;
		if (r) void cherryPick(r, row.commit.hash);
	}

	// -------------------------------------------------------------------------------------------
	// Labels

	badges(row: GraphRow) {
		return rowBadges(row.commit.refs, get<string>('scm.graph.badges'), { branch: this.page?.branch ?? null, upstream: this.page?.upstream?.name ?? null, allRefs: this.all });
	}

	when(c: GraphCommit) {
		const time = get<string>('git.timeline.date') === 'authored' ? c.author_time : c.commit_time;
		return fromNow(time, Date.now(), locale());
	}

	hover(row: GraphRow): string {
		if (row.kind !== 'commit') return row.commit.subject;
		const c = row.commit;
		const time = get<string>('git.timeline.date') === 'authored' ? c.author_time : c.commit_time;
		return commitHover(c, new Date(time * 1000).toLocaleString(locale()), this.#hashLength());
	}

	short(c: GraphCommit) {
		return c.hash.slice(0, this.#hashLength());
	}
}

export const graph = new Graph();

async function copy(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		status.flash(t('scmEditor.copied'));
	} catch (e) {
		notifications.error(e);
	}
}

export const copyCommitId = (c: GraphCommit) => copy(c.hash);
export const copyCommitMessage = (c: GraphCommit) => copy(commitMessage(c));

/** Whether a row is one of the virtual ones. */
export const isVirtual = (row: GraphRow) => row.commit.hash === OUTGOING_ID || row.commit.hash === INCOMING_ID;

export function installGraph(): () => void {
	try {
		graph.open = localStorage.getItem(OPEN_KEY) !== '0';
	} catch {
		// Storage unavailable: the section starts open.
	}
	let wasBusy = false;
	const stop = $effect.root(() => {
		$effect(() => {
			const open = graph.open;
			try {
				localStorage.setItem(OPEN_KEY, open ? '1' : '0');
			} catch {
				// Storage unavailable.
			}
		});
		// A picked repository that went away: follow the active one again.
		$effect(() => {
			if (graph.picked && !scm.repositories.some((r) => r.dir === graph.picked)) graph.picked = null;
		});
		// The repository moved (HEAD, upstream, ahead/behind) or its settings changed.
		$effect(() => {
			const r = graph.repository;
			void r?.repo?.head;
			void r?.repo?.branch;
			void r?.repo?.upstream;
			void r?.repo?.ahead;
			void r?.repo?.behind;
			void graph.all;
			for (const id of ['scm.graph.pageSize', 'scm.graph.showIncomingChanges']) void get(id);
			if (graph.open && layout.sideView === 'scm') untrack(() => void graph.refresh());
		});
		// A git operation ended (a tag, a fetch …): refs may have moved without HEAD moving.
		$effect(() => {
			const busy = !!scm.op;
			if (wasBusy && !busy && graph.open) untrack(() => void graph.refresh(true));
			wasBusy = busy;
		});
	});
	const off = [
		commands.register({ id: 'scm.graph.refresh', title: 'Source Control Graph: Refresh', run: () => graph.refresh(true) }),
		commands.register({
			id: 'workbench.scm.history.focus',
			title: 'Source Control: Focus on Graph View',
			run: () => {
				appMode.setMode('workbench');
				layout.sideView = 'scm';
				layout.sidebarVisible = true;
				graph.open = true;
				void graph.refresh(true);
			}
		})
	];
	return () => {
		stop();
		off.forEach((u) => u());
	};
}
