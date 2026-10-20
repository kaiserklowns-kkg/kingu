// The Timeline view's model (VS Code's timeline view with the git extension's provider,
// extensions/git/src/timelineProvider.ts): the commits of the active file, newest first and
// following renames (`git log --follow`), `timeline.pageSize` at a time; with
// `git.timeline.showUncommitted` the file's staged and unstaged changes on top. An item opens the
// file as that commit changed it. "Git: View File History" lists the same commits in a picker.
// Local History (localHistory.svelte.ts) is the second source, merged in by time; the view's
// filter hides either source (VS Code's timeline.excludeSources).

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
import { scm } from '#lib/workbench/scm.svelte.ts';
import { diffKey, fileOf, historyDiffKey, indexDiffKey, isDiffKey } from '#lib/workbench/scm.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { fromNow } from './blame';
import { isRepoFile } from './scmViews.svelte';
import { historyFile, installLocalHistory, localHistory } from './localHistory.svelte';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { isExternalKey } from '#lib/workbench/externalFiles.ts';
import { mergeByTime, type HistoryEntry, type TimelineSource } from './localHistory';

/** One commit of a file (Rust `git_editor::FileCommit`). */
export type FileCommit = {
	hash: string;
	short: string;
	author: string;
	email: string;
	author_time: number;
	commit_time: number;
	refs: string[];
	subject: string;
	body: string;
	path: string;
	orig_path: string | null;
	status: string;
};

/** A Timeline row: a commit, or the uncommitted changes (`git.timeline.showUncommitted`). */
export type TimelineItem = { kind: 'commit'; commit: FileCommit } | { kind: 'staged' } | { kind: 'working' } | { kind: 'local'; entry: HistoryEntry };

const EXCLUDED_KEY = 'kingu.timeline.excludeSources';
function readExcluded(): TimelineSource[] {
	try {
		const v = JSON.parse(localStorage.getItem(EXCLUDED_KEY) ?? '[]');
		return Array.isArray(v) ? v.filter((x): x is TimelineSource => x === 'git' || x === 'local') : [];
	} catch {
		return [];
	}
}

/** The file a Timeline follows: the active editor's file (or the file of the active diff). */
export function timelineFile(active: string | null): string | null {
	if (!active) return null;
	const file = isDiffKey(active) ? fileOf(active) : active;
	return isRepoFile(file) ? file : null;
}

/** The time `git.timeline.date` picks (authored or committed). */
export const itemTime = (c: FileCommit, date: string) => (date === 'authored' ? c.author_time : c.commit_time);

const pageSize = () => {
	const n = settings.get<number | null>('timeline.pageSize');
	return typeof n === 'number' && n > 0 ? Math.min(n, 500) : 50;
};

class Timeline {
	/** The file shown (null: no file, or not in a repository). */
	path = $derived(historyFile(editors.active));
	/** The Timeline's filter: sources not shown (VS Code's timeline.excludeSources). */
	excluded = $state<TimelineSource[]>(readExcluded());
	commits = $state<FileCommit[]>([]);
	loading = $state(false);
	/** More commits may follow the loaded ones. */
	more = $state(false);
	#for = '';
	#seq = 0;

	/** The rows: uncommitted changes first (git.timeline.showUncommitted), then the commits. */
	items = $derived.by((): TimelineItem[] => {
		const out: TimelineItem[] = [];
		const p = this.path;
		const git = !this.excluded.includes('git') && scm.repo !== null;
		const e = p && git ? scm.repo?.entries.find((x) => x.path === p) : undefined;
		if (e && settings.get<boolean>('git.timeline.showUncommitted')) {
			if (e.index && !e.conflict) out.push({ kind: 'staged' });
			if (e.worktree && e.worktree !== '?') out.push({ kind: 'working' });
		}
		const commits = git ? this.commits : [];
		const local = p && !this.excluded.includes('local') ? [...(localHistory.entries[p] ?? [])].reverse() : [];
		const date = settings.get<string>('git.timeline.date');
		const merged = mergeByTime(commits, (c) => itemTime(c, date) * 1000, local, (x) => x.timestamp);
		return [...out, ...merged.map((m): TimelineItem => (m.from === 'a' ? { kind: 'commit', commit: m.item } : { kind: 'local', entry: m.item }))];
	});

	/** Reads the first page again when the file or HEAD changed (or `force`). */
	async refresh(force = false) {
		const p = this.path;
		const key = `${p}|${scm.repo?.head ?? ''}`;
		if (!force && key === this.#for) return;
		this.#for = key;
		const my = ++this.#seq;
		if (!p) {
			this.commits = [];
			this.more = false;
			return;
		}
		void localHistory.load(p);
		// A file outside the folder has local history only.
		if (!scm.repo || isExternalKey(p)) {
			this.commits = [];
			this.more = false;
			return;
		}
		this.loading = true;
		try {
			const list = await invoke<FileCommit[]>('scm_file_log', { rel: p, limit: pageSize(), skip: 0 });
			if (my !== this.#seq) return;
			this.commits = list;
			this.more = list.length >= pageSize();
		} catch (e) {
			clientLog('info', `timeline ${p}: ${e}`);
			if (my === this.#seq) this.commits = [];
		} finally {
			if (my === this.#seq) this.loading = false;
		}
	}

	/** The next `timeline.pageSize` commits. */
	async loadMore() {
		const p = this.path;
		if (!p || this.loading || !this.more) return;
		const my = this.#seq;
		this.loading = true;
		try {
			const list = await invoke<FileCommit[]>('scm_file_log', { rel: p, limit: pageSize(), skip: this.commits.length });
			if (my !== this.#seq) return;
			this.commits = [...this.commits, ...list];
			this.more = list.length >= pageSize();
		} catch (e) {
			clientLog('info', `timeline ${p}: ${e}`);
		} finally {
			if (my === this.#seq) this.loading = false;
		}
	}

	/** Shows or hides a source (the view's filter menu). */
	toggleSource(source: TimelineSource) {
		this.excluded = this.excluded.includes(source) ? this.excluded.filter((s) => s !== source) : [...this.excluded, source];
		try {
			localStorage.setItem(EXCLUDED_KEY, JSON.stringify(this.excluded));
		} catch {
			// Storage unavailable: the filter lasts until the window reloads.
		}
	}

	/** git.timeline.openDiff: the commit's parent ↔ the commit (under the file's earlier name).
	 * A local history entry opens Compare with File (VS Code's default timeline command). */
	open(item: TimelineItem, preview = true) {
		const p = this.path;
		if (!p) return;
		if (item.kind === 'local') return localHistory.compareWithFile(p, item.entry, preview);
		if (item.kind === 'staged') return editors.open(indexDiffKey(p), { preview });
		if (item.kind === 'working') return editors.open(diffKey(p), { preview });
		const c = item.commit;
		editors.open(historyDiffKey(c.hash, c.path, c.orig_path ?? c.path), { preview });
	}

	label(item: TimelineItem): string {
		if (item.kind === 'staged') return t('scmEditor.timeline.staged');
		if (item.kind === 'working') return t('scmEditor.timeline.uncommitted');
		if (item.kind === 'local') return localHistory.label(item.entry);
		return item.commit.subject;
	}

	description(item: TimelineItem): string {
		if (item.kind !== 'commit') return '';
		return settings.get<boolean>('git.timeline.showAuthor') ? item.commit.author : '';
	}

	ago(item: TimelineItem): string {
		if (item.kind === 'local') return localHistory.ago(item.entry);
		if (item.kind !== 'commit') return '';
		return fromNow(itemTime(item.commit, settings.get<string>('git.timeline.date')), Date.now(), locale());
	}

	tooltip(item: TimelineItem): string {
		if (item.kind === 'local') return localHistory.tooltip(this.path ?? '', item.entry);
		if (item.kind !== 'commit') return this.label(item);
		const c = item.commit;
		const when = new Date(itemTime(c, settings.get<string>('git.timeline.date')) * 1000).toLocaleString(locale());
		const renamed = c.orig_path && c.orig_path !== c.path ? `\n${c.orig_path} → ${c.path}` : '';
		return `${c.author} <${c.email}>, ${when}\n\n${c.subject}${c.body ? `\n\n${c.body}` : ''}${renamed}\n\n${c.short}`;
	}
}

export const timeline = new Timeline();

async function copy(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		status.flash(t('scmEditor.copied'));
	} catch (e) {
		notifications.error(e);
	}
}

export const copyCommitId = (c: FileCommit) => copy(c.hash);
export const copyCommitMessage = (c: FileCommit) => copy(c.body ? `${c.subject}\n\n${c.body}` : c.subject);

/** Git: View File History: the active file's commits in a picker; the pick opens its changes. */
async function viewFileHistory() {
	const p = timelineFile(editors.active);
	if (!p) return status.flash(t('scmEditor.timeline.noFile'));
	let list: FileCommit[];
	try {
		list = await invoke<FileCommit[]>('scm_file_log', { rel: p, limit: 200, skip: 0 });
	} catch (e) {
		return notifications.error(e);
	}
	if (!list.length) return status.flash(t('scmEditor.timeline.empty'));
	const date = settings.get<string>('git.timeline.date');
	const pick = await quick.choose({
		placeholder: t('scmEditor.timeline.pick', { file: p }),
		items: list.map((c) => ({ id: c.hash, label: c.subject, description: `${c.short} · ${c.author} · ${fromNow(itemTime(c, date), Date.now(), locale())}` }))
	});
	const c = pick && list.find((x) => x.hash === pick.id);
	if (c) editors.open(historyDiffKey(c.hash, c.path, c.orig_path ?? c.path), { preview: false });
}

/** The Timeline section's open state (per window, like a view's collapsed state). */
export const timelineView = $state({ open: false });

export function installTimeline(): () => void {
	try {
		timelineView.open = localStorage.getItem('kingu.timeline.open') === '1';
	} catch {
		// Storage unavailable: the section starts closed.
	}
	const uninstallLocalHistory = installLocalHistory();
	const stop = $effect.root(() => {
		// Entries are cached by workspace-relative path: another folder starts empty.
		$effect(() => {
			void workspace.root;
			untrack(() => {
				localHistory.entries = {};
				localHistory.selected = null;
			});
		});
		$effect(() => {
			void timeline.path;
			void scm.repo?.head;
			if (timelineView.open) void timeline.refresh();
		});
		$effect(() => {
			const open = timelineView.open;
			try {
				localStorage.setItem('kingu.timeline.open', open ? '1' : '0');
			} catch {
				// Storage unavailable.
			}
		});
	});
	const off = [
		commands.register({ id: 'git.viewFileHistory', title: 'Git: View File History', when: () => scm.repo !== null && timelineFile(editors.active) !== null, run: viewFileHistory }),
		commands.register({ id: 'timeline.refresh', title: 'Timeline: Refresh', run: () => timeline.refresh(true) }),
		commands.register({
			id: 'timeline.focus',
			title: 'Explorer: Focus on Timeline View',
			run: () => {
				appMode.setMode('workbench');
				layout.sideView = 'explorer';
				layout.sidebarVisible = true;
				timelineView.open = true;
			}
		})
	];
	return () => {
		uninstallLocalHistory();
		stop();
		off.forEach((u) => u());
	};
}
