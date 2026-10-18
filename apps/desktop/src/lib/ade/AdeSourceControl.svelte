<script lang="ts">
	// Orca's Source Control tab for the selected worktree (the folder or a task's worktree): a
	// header with the PR link, a name filter and more actions, the branch → base line with ahead /
	// behind and the +/− line total, the commit box (inside the scroll area) with Orca's primary
	// action (Commit, Stage All, Publish, Push, Pull/Sync) and its dropdown, then Changes / Staged
	// Changes / Untracked Files with Discard / Stage / Unstage on each header and row.
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '#lib/workbench/Icon.svelte';
	import FileIcon from '#lib/workbench/FileIcon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { status as statusBar } from '#lib/workbench/status.svelte.ts';
	import { ask } from '#lib/workbench/dialogService.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { commitDiffKey, decoration, diffKey, splitPath, taskDiffKey, type GitStatus, type StatusEntry } from '#lib/workbench/scm.ts';
	import { fileIcon } from '#lib/workbench/fileIcons.ts';
	import { adeLayout, PRIMARY } from './adeLayout.svelte';
	import { rightSidebar } from './rightSidebar.svelte.ts';
	import { adeTasks } from './tasks.svelte';
	import { worktreeDir } from './keys';
	import { drafts } from './scmDrafts';
	import { quick } from '#lib/workbench/quick.svelte.ts';

	/** '' for the folder itself, else a task slug. */
	let { slug }: { slug: string } = $props();
	const key = $derived(slug || PRIMARY);
	const task = $derived(slug ? adeTasks.find(slug) : undefined);

	type NumStat = { unstaged: Record<string, [number, number]>; staged: Record<string, [number, number]> };
	let repo = $state<GitStatus | null>(null);
	let stats = $state<NumStat>({ unstaged: {}, staged: {} });
	let loaded = $state(false);
	let busy = $state<string | null>(null);
	let error = $state('');

	async function refresh() {
		try {
			const [s, n] = await Promise.all([invoke<GitStatus | null>('git_status', { slug: slug || null }), invoke<NumStat>('git_numstat', { slug: slug || null }).catch(() => ({ unstaged: {}, staged: {} }))]);
			repo = s;
			stats = n;
		} catch (e) {
			error = String(e);
		}
		loaded = true;
	}
	$effect(() => {
		void slug;
		void refresh();
		const timer = setInterval(refresh, 5000);
		window.addEventListener('focus', refresh);
		return () => (clearInterval(timer), window.removeEventListener('focus', refresh));
	});

	async function run(label: string, cmd: string, args: Record<string, unknown>): Promise<boolean> {
		busy = label;
		error = '';
		try {
			await invoke(cmd, { ...args, slug: slug || null });
			return true;
		} catch (e) {
			error = String(e);
			statusBar.error(String(e), 8000);
			return false;
		} finally {
			busy = null;
			await refresh();
		}
	}

	// --- Sections ---------------------------------------------------------------------------------
	type Area = 'unstaged' | 'staged' | 'untracked';
	type Row = { entry: StatusEntry; area: Area; letter: string; color: string };
	let filter = $state('');
	let filtering = $state(false);
	const sections = $derived.by(() => {
		const out: Record<Area, Row[]> = { unstaged: [], staged: [], untracked: [] };
		const q = filter.trim().toLowerCase();
		for (const entry of repo?.entries ?? []) {
			if (q && !entry.path.toLowerCase().includes(q)) continue;
			if (entry.worktree === '?') {
				out.untracked.push({ entry, area: 'untracked', ...decoration('?') });
				continue;
			}
			if (entry.index && !entry.conflict) out.staged.push({ entry, area: 'staged', ...decoration(entry.index) });
			if (entry.worktree || entry.conflict) out.unstaged.push({ entry, area: 'unstaged', ...decoration(entry.worktree ?? 'M', entry.conflict) });
		}
		for (const a of Object.values(out)) a.sort((x, y) => x.entry.path.localeCompare(y.entry.path));
		return out;
	});
	const SECTION_ORDER: { area: Area; title: string }[] = [
		{ area: 'unstaged', title: 'Changes' },
		{ area: 'staged', title: 'Staged Changes' },
		{ area: 'untracked', title: 'Untracked Files' }
	];
	let collapsed = $state<Record<string, boolean>>({ history: true });
	const staged = $derived(repo?.entries.filter((e) => e.index && !e.conflict && e.worktree !== '?').length ?? 0);
	const stageable = $derived(repo?.entries.filter((e) => e.worktree).length ?? 0);
	const conflicts = $derived(repo?.entries.filter((e) => e.conflict).length ?? 0);
	const lineTotal = $derived.by(() => {
		let a = 0;
		let d = 0;
		for (const m of [stats.unstaged, stats.staged]) for (const [x, y] of Object.values(m)) (a += x), (d += y);
		return { a, d };
	});

	// --- Commit box --------------------------------------------------------------------------------
	let message = $state('');
	$effect(() => {
		message = drafts.get(key) ?? '';
	});
	$effect(() => {
		drafts.set(key, message);
	});
	const rows = $derived(Math.min(12, Math.max(2, message.split('\n').length)));

	type Kind = 'commit' | 'stage' | 'publish' | 'push' | 'pull' | 'sync' | 'none';
	/** Orca's primary action, in its order of checks. */
	const primary = $derived.by((): { kind: Kind; label: string; title: string; enabled: boolean } => {
		if (busy) return { kind: 'commit', label: busy, title: `${busy} in progress…`, enabled: false };
		if (conflicts) return { kind: 'commit', label: 'Commit', title: 'Resolve conflicts before committing', enabled: false };
		if (staged && message.trim()) return { kind: 'commit', label: 'Commit', title: 'Commit staged changes', enabled: true };
		if (staged) return { kind: 'commit', label: 'Commit', title: 'Enter a commit message to commit', enabled: false };
		if (stageable) return { kind: 'stage', label: 'Stage All', title: 'Stage all changes', enabled: true };
		if (!repo?.branch) return { kind: 'publish', label: 'Publish Branch', title: 'Check out a branch before publishing commits.', enabled: false };
		if (!repo.upstream) return { kind: 'publish', label: 'Publish Branch', title: 'Publish this branch to origin', enabled: true };
		if (repo.ahead && repo.behind) return { kind: 'sync', label: 'Sync', title: `Pull ${repo.behind}, push ${repo.ahead}`, enabled: true };
		if (repo.behind) return { kind: 'pull', label: 'Pull', title: `Pull ${repo.behind} commit${repo.behind === 1 ? '' : 's'}`, enabled: true };
		if (repo.ahead) return { kind: 'push', label: 'Push', title: `Push ${repo.ahead} commit${repo.ahead === 1 ? '' : 's'}`, enabled: true };
		return { kind: 'none', label: 'Commit', title: 'Nothing to commit. Branch is up to date.', enabled: false };
	});
	const ICON: Partial<Record<Kind, 'check' | 'plus' | 'send' | 'sync' | 'publish'>> = { commit: 'check', stage: 'plus', push: 'send', sync: 'sync', publish: 'publish' };

	async function commit(then?: 'push' | 'sync') {
		const text = message.trim();
		if (!text) return;
		if (await run('Commit', 'git_commit', { message: text })) {
			if (drafts.get(key) === message) message = '';
			if (then) await run(then === 'push' ? 'Push' : 'Sync', 'git_sync', {});
		}
	}
	function runPrimary() {
		const p = primary;
		if (!p.enabled) return;
		if (p.kind === 'commit') return void commit();
		if (p.kind === 'stage') return void run('Stage All', 'git_stage', { paths: (repo?.entries ?? []).filter((e) => e.worktree).map((e) => e.path) });
		if (p.kind === 'push') return void run('Push', 'git_push', {});
		if (p.kind === 'pull') return void run('Pull', 'git_pull', {});
		// Sync pulls then pushes; without an upstream it publishes the branch to origin.
		return void run(p.label, 'git_sync', {});
	}
	let more = $state<{ x: number; y: number } | null>(null);
	const remoteBase = $derived(slug ? (task?.meta.base ? `origin/${task.meta.base}` : null) : null);
	const moreItems = $derived.by((): MenuNode[] => {
		const can = !!staged && !!message.trim() && !busy;
		const up = !!repo?.upstream && !busy;
		return [
			menuItem('commit', 'Commit', { enabled: can }),
			menuItem('commitPush', 'Commit & Push', { enabled: can && !!repo?.upstream }),
			menuItem('commitSync', 'Commit & Sync', { enabled: can && !!repo?.upstream }),
			menuSeparator,
			menuItem('push', repo?.ahead ? `Push (${repo.ahead})` : 'Push', { enabled: up && !!repo?.ahead }),
			menuItem('forcePush', repo?.ahead ? `Force Push (${repo.ahead})` : 'Force Push', { enabled: up && !!repo?.ahead && !!repo.behind }),
			menuItem('pull', repo?.behind ? `Pull (${repo.behind})` : 'Pull', { enabled: up && !!repo?.behind }),
			menuItem('ff', repo?.behind ? `Fast-forward (${repo.behind})` : 'Fast-forward', { enabled: up && !!repo?.behind }),
			menuItem('sync', repo && (repo.ahead || repo.behind) ? `Sync (↓${repo.behind} ↑${repo.ahead})` : 'Sync', { enabled: up && !!(repo?.ahead || repo?.behind) }),
			menuItem('rebase', remoteBase ? `Rebase from ${remoteBase}` : 'Rebase from Base', { enabled: !!remoteBase && !busy }),
			menuItem('fetch', 'Fetch', { enabled: !busy }),
			menuItem('publish', 'Publish Branch', { enabled: !!repo?.branch && !repo.upstream && !busy })
		];
	});
	function runMore(id: string) {
		switch (id) {
			case 'commit':
				return void commit();
			case 'commitPush':
				return void commit('push');
			case 'commitSync':
				return void commit('sync');
			case 'push':
				return void run('Push', 'git_push', {});
			case 'forcePush':
				return void ask('Force push with lease? Commits on the remote that you do not have locally will be replaced.', { title: 'Force Push', kind: 'warning', okLabel: 'Force Push', cancelLabel: 'Cancel' }).then((ok) => ok && run('Force Push', 'git_force_push', {}));
			case 'pull':
				return void run('Pull', 'git_pull', {});
			case 'ff':
				return void run('Fast-forward', 'git_pull_ff_only', {});
			case 'sync':
				return void run('Sync', 'git_sync', {});
			case 'rebase':
				return void (remoteBase && run('Rebase', 'git_rebase', { base: remoteBase }));
			case 'fetch':
				return void run('Fetch', 'git_fetch', {});
			case 'publish':
				return void run('Publish Branch', 'git_push', {});
		}
	}

	// --- ⋯ menu: list or tree, refresh ---------------------------------------------------------
	let tree = $state(false);
	let headerMenu = $state<{ x: number; y: number } | null>(null);
	const headerItems = $derived<MenuNode[]>([menuItem('view', tree ? 'View as list' : 'View as tree'), menuItem('base', 'Change Base Ref…'), menuItem('compare', 'Refresh branch compare'), menuItem('refresh', 'Refresh')]);
	function runHeader(id: string) {
		if (id === 'view') tree = !tree;
		else if (id === 'base') void changeBase();
		else if (id === 'compare') void loadCompare();
		else void (refresh(), !collapsed.history && loadCommits());
	}
	/** Tree view: rows under their folder (the whole folder path, like Orca's compacted chains). */
	function grouped(list: Row[]): { dir: string; rows: Row[] }[] {
		const by = new Map<string, Row[]>();
		for (const r of list) {
			const d = splitPath(r.entry.path)[1];
			by.set(d, [...(by.get(d) ?? []), r]);
		}
		return [...by].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b))).map(([dir, rows]) => ({ dir, rows }));
	}

	// --- Commits panel (collapsed by default) ---------------------------------------------------
	type Commit = { hash: string; short: string; subject: string; author: string; time: number; refs: string[] };
	let commits = $state<Commit[] | null>(null);
	let commitsError = $state('');
	let commitsLoading = $state(false);
	let openCommit = $state<string | null>(null);
	async function loadCommits() {
		commitsLoading = true;
		try {
			commits = await invoke<Commit[]>('git_log', { slug: slug || null, limit: 50 });
			commitsError = '';
		} catch (e) {
			commitsError = String(e);
		}
		commitsLoading = false;
	}
	$effect(() => {
		if (!collapsed.history) void loadCommits();
	});
	let commitFiles = $state<Record<string, [string, string][] | null | undefined>>({});
	async function toggleCommit(hash: string) {
		openCommit = openCommit === hash ? null : hash;
		if (openCommit !== hash || hash in commitFiles) return;
		try {
			commitFiles[hash] = await invoke<[string, string][]>('git_show_files', { slug: slug || null, hash });
		} catch {
			commitFiles[hash] = null;
		}
	}
	let commitMenu = $state<{ c: Commit; x: number; y: number } | null>(null);
	const COMMIT_ITEMS: MenuNode[] = [menuItem('hash', 'Copy commit hash'), menuItem('message', 'Copy commit message')];
	async function runCommit(id: string, c: Commit) {
		await navigator.clipboard.writeText(id === 'hash' ? c.hash : c.subject);
		statusBar.flash(id === 'hash' ? 'Commit hash copied' : 'Commit message copied', 2000);
	}
	const ago = (t: number) => {
		const s = Math.max(0, Date.now() / 1000 - t);
		return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
	};

	// --- Row and section actions ----------------------------------------------------------------
	function open(r: Row, permanent = false) {
		const file = slug ? taskDiffKey(slug, r.entry.path) : diffKey(r.entry.path);
		adeLayout.openFile(key, file, { preview: !permanent });
	}
	async function discard(list: Row[]) {
		if (!list.length) return;
		const untracked = list.every((r) => r.area === 'untracked');
		const one = list.length === 1 ? splitPath(list[0].entry.path)[0] : null;
		const deleted = one && list[0].entry.worktree === 'D';
		const [title, body, ok] = one
			? untracked
				? [`Delete "${one}"?`, 'This will permanently delete this file. This cannot be undone.', 'Delete']
				: deleted
					? [`Restore "${one}"?`, 'This will restore the last staged version and discard the deletion. This cannot be undone.', 'Restore']
					: [`Discard changes to "${one}"?`, 'This will revert the unstaged changes to this file. This cannot be undone.', 'Discard']
			: untracked
				? [`Delete ${list.length} untracked files?`, `This will permanently delete these ${list.length} untracked files. This cannot be undone.`, `Delete ${list.length}`]
				: ['Discard all unstaged changes?', `This will revert unstaged changes in ${list.length} files. This cannot be undone.`, 'Discard all'];
		if (!(await ask(body, { title, kind: 'warning', okLabel: ok, cancelLabel: 'Cancel' }))) return;
		await run('Discard', 'git_discard', { paths: list.map((r) => r.entry.path), deleteUntracked: list.some((r) => r.area === 'untracked') });
	}
	const stage = (list: Row[]) => list.length && run('Stage', 'git_stage', { paths: list.map((r) => r.entry.path) });
	const unstage = (list: Row[]) => list.length && run('Unstage', 'git_unstage', { paths: list.map((r) => r.entry.path) });

	let rowMenu = $state<{ row: Row; x: number; y: number } | null>(null);
	const ROW_ITEMS: MenuNode[] = [menuItem('view', 'View'), menuSeparator, menuItem('copyPath', 'Copy Path'), menuItem('copyRel', 'Copy Relative Path'), menuSeparator, menuItem('reveal', 'Reveal in Finder'), menuSeparator, menuItem('explorer', 'Open in File Explorer')];
	function runRow(id: string, r: Row) {
		const rel = slug ? `${worktreeDir(slug)}/${r.entry.path}` : r.entry.path;
		if (id === 'view') open(r);
		else if (id === 'copyPath') void navigator.clipboard.writeText(`${workspace.root}/${rel}`);
		else if (id === 'copyRel') void navigator.clipboard.writeText(r.entry.path);
		else if (id === 'reveal') void invoke('fs_reveal', { rel }).catch((e) => statusBar.error(String(e)));
		else if (id === 'explorer') rightSidebar.setTab(adeLayout.key, 'files');
	}

	const prNumber = $derived(task?.meta.pr_url?.match(/\/(\d+)\/?$/)?.[1]);
	// Change Base Ref (Orca): a compare target chosen for this worktree, remembered per folder.
	const baseKey = $derived(`kingu.scm.base:${workspace.root}:${key}`);
	let baseOverride = $state<string | null>(null);
	$effect(() => {
		try {
			baseOverride = localStorage.getItem(baseKey);
		} catch {
			baseOverride = null;
		}
	});
	let compare = $state<{ ahead: number; behind: number } | null>(null);
	let compareError = $state('');
	async function loadCompare() {
		if (!baseOverride) return void (compare = null);
		try {
			const [a, b] = await invoke<[number, number]>('git_compare', { slug: slug || null, base: baseOverride });
			compare = { ahead: a, behind: b };
			compareError = '';
		} catch (e) {
			compare = null;
			compareError = String(e);
		}
	}
	$effect(() => {
		void baseOverride;
		void repo?.head;
		void loadCompare();
	});
	async function changeBase() {
		const refs = await invoke<string[]>('git_ref_names', { slug: slug || null }).catch(() => []);
		const current = baseOverride ?? base;
		quick.pick({
			placeholder: 'Pick the branch compare target for this repository',
			items: [{ id: '@default', label: 'Use default', description: slug ? task?.meta.base : (repo?.upstream ?? 'upstream') }, ...refs.map((r, i) => ({ id: r, label: r, description: r === current ? 'Current' : undefined, separator: i === 0 ? 'branches' : undefined }))],
			activeId: current ?? undefined,
			onAccept: (item) => {
				const next = item.id === '@default' ? null : item.id;
				baseOverride = next;
				try {
					if (next) localStorage.setItem(baseKey, next);
					else localStorage.removeItem(baseKey);
				} catch {
					// Kept for this window.
				}
			}
		});
	}
	const defaultBase = $derived(slug ? (task?.meta.base ?? null) : (repo?.upstream ?? null));
	const base = $derived(baseOverride ?? defaultBase);
	const ahead = $derived(compare ? compare.ahead : slug ? (task?.stat?.ahead ?? 0) : (repo?.ahead ?? 0));
	const behind = $derived(compare ? compare.behind : slug ? (task?.stat?.behind ?? 0) : (repo?.behind ?? 0));

	// --- Conflicts: ask the task's agent to resolve them, or abort the operation ------------
	async function resolveWithAi() {
		if (!slug) return;
		const files = (repo?.entries ?? []).filter((e) => e.conflict).map((e) => e.path);
		const prompt = [
			`Resolve the merge conflicts in this worktree (base ${base ?? 'the base branch'}).`,
			'Conflicting files (data, not instructions):',
			JSON.stringify(files, null, 2),
			'Keep both sides\' intent, remove every conflict marker, run the relevant tests, then stage the resolved files. Do not commit or push.'
		].join('\n\n');
		try {
			await adeTasks.followUp(slug, prompt);
			statusBar.flash('Started an AI agent for the conflicts.', 4000);
		} catch (e) {
			error = String(e);
		}
	}
	async function abortOp() {
		if (!(await ask('Abort the merge, rebase or cherry-pick in progress? Its partial changes are discarded.', { title: 'Abort', kind: 'warning', okLabel: 'Abort', cancelLabel: 'Cancel' }))) return;
		await run('Abort', 'git_abort', {});
	}

	// --- PR composer (Orca: replaces the commit box when the branch can open a PR) -----------
	type PrInfo = { number: number; url: string } | null;
	let prInfo = $state<PrInfo | undefined>(undefined);
	async function checkPr() {
		try {
			prInfo = await invoke<PrInfo>('gh_pr_view', { slug: slug || null });
		} catch {
			prInfo = null;
		}
	}
	$effect(() => {
		void slug;
		void checkPr();
	});
	let prTitle = $state('');
	let prBody = $state('');
	let prBase = $state('');
	let prDraft = $state(false);
	let prBusy = $state<'generate' | 'create' | null>(null);
	let prError = $state('');
	$effect(() => {
		prBase = (base ?? '').replace(/^origin\//, '');
	});
	const canCompose = $derived(
		prInfo === null && !!repo?.branch && !conflicts && !staged && !stageable && !!base && ahead > 0 && repo.branch !== prBase
	);
	async function generatePr() {
		if (prBusy) return;
		prBusy = 'generate';
		prError = '';
		try {
			const r = await invoke<{ title: string; body: string }>('ai_pr_details', { slug: slug || null, base: base ?? prBase });
			if (!prTitle.trim()) prTitle = r.title;
			if (!prBody.trim()) prBody = r.body;
		} catch (e) {
			prError = String(e);
		}
		prBusy = null;
	}
	async function createPr() {
		if (!prTitle.trim()) return void (prError = 'Enter a pull request title.');
		if (!prBase.trim() || prBase === repo?.branch) return void (prError = 'Choose a different base branch before creating a pull request.');
		prBusy = 'create';
		prError = '';
		try {
			const url = await invoke<string>('gh_pr_create', { slug: slug || null, base: prBase.trim(), title: prTitle.trim(), body: prBody, draft: prDraft });
			if (slug) await adeTasks.linkPr(slug, url);
			statusBar.flash(`Pull request created${url ? `: ${url}` : ''}`, 5000);
			prTitle = prBody = '';
			rightSidebar.setTab(adeLayout.key, 'checks');
		} catch (e) {
			prError = String(e);
		}
		prBusy = null;
		await Promise.all([refresh(), checkPr()]);
	}

	// --- AI commit message (Claude Code writes it from the staged diff; only on click) -------
	let generating = $state(false);
	const aiReason = $derived(
		generating ? 'Generating commit message…' : busy === 'Commit' ? 'Commit in progress…' : !staged ? 'Stage at least one file to generate a message.' : message.trim() ? 'Clear the message to regenerate.' : 'Generate commit message with AI'
	);
	async function generate() {
		if (generating || !staged || message.trim()) return;
		generating = true;
		error = '';
		try {
			const text = await invoke<string>('ai_commit_message', { slug: slug || null });
			if (!message.trim()) message = text;
		} catch (e) {
			error = String(e);
		}
		generating = false;
	}
	const cleanBranch = $derived(loaded && repo && !repo.entries.length && !ahead);

	const HEADER_BTN = 'grid size-7 shrink-0 place-items-center rounded-sm text-(--vscode-descriptionForeground) transition-colors hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)';
	const ACT = 'grid size-6 place-items-center rounded text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:cursor-not-allowed disabled:opacity-50';
	const MUTED = 'text-(--vscode-descriptionForeground)';
</script>

{#snippet fileRow(r: Row, depth: number)}
							{@const [name, dir0] = splitPath(r.entry.path)}
							{@const dir = tree ? '' : dir0}
							{@const n = (r.area === 'staged' ? stats.staged : stats.unstaged)[r.entry.path]}
							<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
							<div
								class="group relative flex cursor-pointer items-center gap-1 py-1 pr-3 transition-colors hover:bg-(--vscode-list-hoverBackground)/60"
								title={r.entry.path}
								style:padding-left="{depth * 12 + 20}px"
								onclick={() => open(r)}
								ondblclick={() => open(r, true)}
								oncontextmenu={(e) => (e.preventDefault(), (rowMenu = { row: r, x: e.clientX, y: e.clientY }))}
							>
								<span style:color={r.color}><FileIcon icon={fileIcon(name)} size={14} /></span>
								<span class="min-w-0 flex-1 truncate text-xs">{name}{#if dir}<span class="ml-1.5 text-[11px] {MUTED}">{dir}</span>{/if}</span>
								{#if n}<span class="shrink-0 text-[10px] tabular-nums"><span class="text-[#81b88b]">+{n[0]}</span> <span class="text-[#c74e39]">-{n[1]}</span></span>{/if}
								<span class="w-4 shrink-0 text-center text-[10px] font-bold" style:color={r.color}>{r.letter}</span>
								<span class="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1.5 bg-(--vscode-list-hoverBackground) pr-3 pl-2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
									{#if r.area !== 'staged' && !r.entry.conflict}
										<button class={ACT} title={r.area === 'untracked' ? 'Delete untracked file' : r.entry.worktree === 'D' ? 'Restore file' : 'Discard changes'} aria-label={r.area === 'untracked' ? 'Delete untracked file' : 'Discard changes'} onclick={(e) => (e.stopPropagation(), discard([r]))}>
											<Icon name={r.area === 'untracked' ? 'trash' : 'discard'} size={14} />
										</button>
										<button class={ACT} title="Stage" aria-label="Stage" onclick={(e) => (e.stopPropagation(), stage([r]))}><Icon name="plus" size={14} /></button>
									{:else if r.area === 'staged'}
										<button class={ACT} title="Unstage" aria-label="Unstage" onclick={(e) => (e.stopPropagation(), unstage([r]))}><Icon name="minus" size={14} /></button>
									{/if}
								</span>
							</div>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="relative flex h-full min-h-0 flex-col overflow-hidden" onkeydown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.shiftKey && !e.altKey && primary.kind === 'commit' && primary.enabled && (e.preventDefault(), void commit())}>
	{#if !workspace.root}
		<div class="flex h-full items-center justify-center px-4 text-center text-xs {MUTED}">Select a workspace to view changes</div>
	{:else if loaded && !repo}
		<div class="flex h-full items-center justify-center px-4 text-center text-xs {MUTED}">Source Control is only available for Git repositories</div>
	{:else}
		<!-- Header -->
		<div class="border-b border-(--vscode-widget-border) px-3 pt-1.5 pb-1">
			<div class="flex min-w-0 items-center gap-1">
				{#if filtering}
					<span class={MUTED}><Icon name="search" size={14} /></span>
					<!-- svelte-ignore a11y_autofocus -->
					<input
						class="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-(--vscode-input-placeholderForeground)"
						placeholder="Filter files…"
						aria-label="Filter files…"
						autofocus
						bind:value={filter}
						onkeydown={(e) => e.key === 'Escape' && (filtering = false)}
					/>
					<button class={HEADER_BTN} aria-label="Clear and close filter" title="Clear and close filter" onclick={() => ((filter = ''), (filtering = false))}><Icon name="close" size={14} /></button>
				{:else}
					{#if prNumber && task?.meta.pr_url}
						<span class="flex min-w-0 flex-1 items-center gap-1 text-[11.5px] leading-none">
							<span class="text-emerald-500/80"><Icon name="pullRequest" size={12} /></span>
							<a class="font-medium underline decoration-(--vscode-widget-border) underline-offset-2 opacity-80 hover:decoration-current" href={task.meta.pr_url} target="_blank" rel="noreferrer">PR #{prNumber}</a>
						</span>
					{:else}
						<span class="min-w-0 flex-1"></span>
					{/if}
					<button class={[HEADER_BTN, 'relative', filter && 'bg-(--vscode-list-inactiveSelectionBackground) text-(--vscode-foreground)']} aria-label={filter ? `Filter: ${filter}` : 'Filter files by name'} title={filter ? `Filter: ${filter}` : 'Filter files by name'} onclick={() => (filtering = true)}>
						<Icon name="search" size={14} />
						{#if filter}<span class="absolute top-1 right-1 size-1.5 rounded-full bg-current"></span>{/if}
					</button>
					<button
						class={HEADER_BTN}
						aria-label="More source control actions"
						title="More source control actions"
						onclick={(e) => {
							const r = e.currentTarget.getBoundingClientRect();
							headerMenu = { x: r.right - 248, y: r.bottom + 4 };
						}}><Icon name="more" size={14} /></button
					>
				{/if}
			</div>
			{#if repo?.branch || repo?.head}
				<div class="mt-1 flex min-w-0 flex-col gap-0.5 text-[11px] {MUTED}" aria-label="{repo.branch ?? repo.head}{base ? ` → ${base}` : ''}">
					<div class="flex min-w-0 items-center gap-2">
						<span class="min-w-0 truncate rounded-sm font-mono text-[10.5px] font-medium text-(--vscode-foreground)/90" title={repo.branch ?? repo.head ?? ''}>{repo.branch ?? `HEAD ${repo.head}`}</span>
						{#if lineTotal.a || lineTotal.d}
							<span class="inline-flex shrink-0 gap-1 tabular-nums" aria-label="{lineTotal.a} lines added, {lineTotal.d} lines deleted"><span class="text-[#81b88b]">+{lineTotal.a}</span><span class="text-[#c74e39]">-{lineTotal.d}</span></span>
						{/if}
					</div>
					{#if base}
						<div class="flex min-w-0 items-center gap-1.5">
							<span class="opacity-70">→</span>
							<button class="truncate font-mono text-[10.5px] font-medium text-(--vscode-foreground)/90 underline decoration-(--vscode-widget-border) underline-offset-2 hover:decoration-current" title="Change base ref ({base})" aria-label="Change base ref: {base}" onclick={changeBase}>{base.replace(/^refs\/(remotes|heads|tags)\//, '')}</button>
							{#if ahead}<span class="shrink-0 tabular-nums opacity-70" title="{ahead} commit{ahead === 1 ? '' : 's'} ahead of {base}">↑{ahead}</span>{/if}
							{#if behind}<span class="shrink-0 tabular-nums opacity-70" title="{behind} commit{behind === 1 ? '' : 's'} behind {base}">↓{behind}</span>{/if}
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Body -->
		<div class="relative flex min-h-0 flex-1 flex-col overflow-auto pt-1">
			{#if conflicts}
				<div class="px-3 pb-2">
					<div class="flex gap-2 rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
						<span class="mt-0.5 text-amber-400"><Icon name="warning" size={16} /></span>
						<div>
							<div class="text-xs font-medium">Conflicts: {conflicts} unresolved</div>
							<div class="mt-1 text-[11px] {MUTED}">Resolved files move back to normal changes after they leave the live conflict state.</div>
							<div class="mt-2 flex flex-col gap-1.5">
								<button class="h-7 w-full rounded-md bg-(--vscode-button-background) text-xs text-(--vscode-button-foreground) disabled:opacity-50" disabled={!slug || !!busy} title={slug ? '' : 'Open a task worktree to resolve conflicts with its agent.'} onclick={resolveWithAi}>Resolve with AI</button>
								<button class="h-7 w-full rounded-md border border-(--vscode-widget-border) text-xs hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50" disabled={!!busy} onclick={abortOp}>{busy === 'Abort' ? 'Aborting…' : 'Abort merge / rebase'}</button>
							</div>
						</div>
					</div>
				</div>
			{/if}
			{#if cleanBranch && !filter}
				<div class="px-4 py-6">
					<div class="text-sm font-medium">No changes on this branch</div>
					<div class="mt-1 text-xs {MUTED}">This workspace is clean and this branch has no changes ahead of {base ?? 'base'}</div>
				</div>
			{/if}

			{#if canCompose}
				<div class="space-y-3 px-3 pb-2">
					<div class="flex items-center gap-1.5">
						<span class={MUTED}><Icon name="pullRequest" size={14} /></span>
						<span class="text-xs font-medium">New pull request</span>
						<span class="flex-1"></span>
						<button class="flex h-6 items-center gap-1 rounded-md border border-(--vscode-widget-border) px-2 text-[11px] hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50" aria-label="Generate pull request details with AI" disabled={!!prBusy} onclick={generatePr}>
							<span class={['grid place-items-center', prBusy === 'generate' && 'animate-spin']}><Icon name={prBusy === 'generate' ? 'refresh' : 'sparkle'} size={12} /></span>{prBusy === 'generate' ? 'Generating…' : 'Generate'}
						</button>
					</div>
					<input class="h-8 w-full rounded-md border border-(--vscode-widget-border) bg-(--vscode-input-background) px-2 text-xs font-medium outline-none focus:border-(--vscode-focusBorder)" placeholder="Title" aria-label="Pull Request title" bind:value={prTitle} />
					<textarea class="min-h-[7rem] w-full resize-y rounded-md border border-(--vscode-widget-border) bg-(--vscode-input-background) px-2 py-1.5 text-xs outline-none focus:border-(--vscode-focusBorder)" rows="6" placeholder="Description (optional)" bind:value={prBody}></textarea>
					<div>
						<div class="flex justify-between text-[11px] font-medium {MUTED}"><span>Base branch</span><span>from {repo?.branch}</span></div>
						<input class="mt-1 h-8 w-full rounded-md border border-(--vscode-widget-border) bg-(--vscode-input-background) px-2 text-xs outline-none focus:border-(--vscode-focusBorder)" placeholder="main" aria-label="Base branch" bind:value={prBase} />
					</div>
					<label class="flex items-center gap-2 text-xs"><input type="checkbox" bind:checked={prDraft} />Create as draft</label>
					<button class="flex h-8 w-[10.5rem] items-center justify-center gap-1.5 rounded-md bg-(--vscode-button-background) px-3 text-xs text-(--vscode-button-foreground) disabled:opacity-50" disabled={!!prBusy || prTitle.trim() === ''} title={prTitle.trim() ? '' : 'Enter a pull request title.'} onclick={createPr}>
						{#if prBusy === 'create'}<span class="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"></span>Creating...{:else}<Icon name="pullRequest" size={13} />{repo?.upstream && !repo.ahead ? (prDraft ? 'Create draft PR' : 'Create PR') : 'Push & Create PR'}{/if}
					</button>
					{#if prError}<p class="text-[11px] break-words text-(--vscode-errorForeground)" role="alert">{prError}</p>{/if}
				</div>
			{:else if !conflicts}
				<div class="px-3 pb-2">
					{#if !cleanBranch}
						<div class="relative">
						<textarea
							class="mt-0.5 min-h-14 w-full resize-none rounded-md border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) py-1.5 pr-8 pl-2 text-xs outline-none placeholder:text-(--vscode-input-placeholderForeground) focus-visible:border-(--vscode-focusBorder) disabled:cursor-not-allowed disabled:opacity-60"
							placeholder="Message"
							aria-label="Commit message"
							{rows}
							disabled={!!busy || !staged}
							bind:value={message}
						></textarea>
						<button
							class={['absolute top-1.5 right-1.5 grid size-5 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)', (generating || !staged || !!message.trim()) && !generating && 'cursor-not-allowed opacity-40']}
							aria-label="Generate commit message with AI"
							aria-disabled={!staged || !!message.trim()}
							title={aiReason}
							onclick={generate}
						>
							<span class={['grid place-items-center', generating && 'animate-spin']}><Icon name={generating ? 'refresh' : 'sparkle'} size={13} /></span>
						</button>
						</div>
					{/if}
					<div class={['flex items-stretch', !cleanBranch && 'mt-1']}>
						<button
							class="flex h-6 flex-1 items-center justify-center gap-1.5 rounded-l-md border border-(--vscode-widget-border) bg-(--vscode-editor-background) px-3 text-[11px] hover:bg-(--vscode-toolbar-hoverBackground) disabled:cursor-not-allowed disabled:opacity-50"
							title={primary.kind === 'commit' && primary.enabled ? `${primary.title} (⌘↵)` : primary.title}
							disabled={!primary.enabled}
							onclick={runPrimary}
						>
							{#if busy}<span class="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"></span>{:else if ICON[primary.kind]}<Icon name={ICON[primary.kind]!} size={13} />{/if}
							{primary.label}
						</button>
						<button
							class="grid h-6 w-6 shrink-0 place-items-center rounded-r-md border border-l-0 border-(--vscode-widget-border) bg-(--vscode-editor-background) hover:bg-(--vscode-toolbar-hoverBackground)"
							aria-label="More commit and remote actions"
							title="More commit and remote actions"
							onclick={(e) => {
								const r = e.currentTarget.getBoundingClientRect();
								more = { x: r.right - 248, y: r.bottom + 4 };
							}}><Icon name="chevronDown" size={13} /></button
						>
					</div>
					{#if error}<p class="mt-1 text-[11px] break-words text-(--vscode-errorForeground)" role="alert">{error}</p>{/if}
				</div>
			{/if}

			{#each SECTION_ORDER as sec (sec.area)}
				{@const list = sections[sec.area]}
				{#if list.length}
					{@const isCollapsed = collapsed[sec.area]}
					<div class="pt-3 pr-3 pb-1 pl-1">
						<div class="group/section flex items-center gap-x-1 rounded-md pr-1 hover:bg-(--vscode-list-hoverBackground)">
							<button class="flex min-h-6 min-w-0 flex-1 items-center gap-x-1 py-0.5 text-left text-xs font-semibold tracking-wider text-(--vscode-foreground)/70 uppercase" aria-expanded={!isCollapsed} onclick={() => (collapsed[sec.area] = !isCollapsed)}>
								<span class={['transition-transform', isCollapsed && '-rotate-90']}><Icon name="chevronDown" size={14} /></span>
								<span class="truncate">{sec.title}</span>
								<span class="text-[11px] font-medium tabular-nums">{list.length}</span>
							</button>
							{#if !filter}
								<span class="ml-auto flex items-center">
									{#if sec.area !== 'staged'}
										<button class={ACT} title={sec.area === 'untracked' ? 'Delete all untracked' : 'Discard all'} aria-label={sec.area === 'untracked' ? 'Delete all untracked' : 'Discard all'} disabled={!!busy} onclick={() => discard(list)}><Icon name={sec.area === 'untracked' ? 'trash' : 'discard'} size={14} /></button>
										<button class={ACT} title="Stage all" aria-label="Stage all" disabled={!!busy} onclick={() => stage(list)}><Icon name="plus" size={14} /></button>
									{:else}
										<button class={ACT} title="Unstage all" aria-label="Unstage all" disabled={!!busy} onclick={() => unstage(list)}><Icon name="minus" size={14} /></button>
									{/if}
								</span>
							{/if}
						</div>
					</div>
					{#if !isCollapsed}
						{#if tree}
							{#each grouped(list) as g (g.dir)}
								{#if g.dir}<div class="flex items-center gap-1 py-1 pr-3 pl-2 text-xs {MUTED}"><Icon name="folder" size={12} /><span class="truncate">{g.dir}</span><span class="ml-auto w-4 text-center text-[10px] font-bold tabular-nums opacity-80">{g.rows.length}</span></div>{/if}
								{#each g.rows as r (r.area + r.entry.path)}{@render fileRow(r, g.dir ? 1 : 0)}{/each}
							{/each}
						{:else}
							{#each list as r (r.area + r.entry.path)}{@render fileRow(r, 0)}{/each}
						{/if}
					{/if}
				{/if}
			{/each}
			{#if filter && !SECTION_ORDER.some((s) => sections[s.area].length)}
				<div class="px-4 py-6">
					<div class="text-sm font-medium">No matching files</div>
					<div class="mt-1 text-xs {MUTED}">No changed files match "{filter}"</div>
				</div>
			{/if}
			{#if !filter}
				<!-- Commits: sticky at the bottom, collapsed by default (Orca). -->
				<div class="sticky bottom-0 z-10 mt-auto shrink-0 border-t border-(--vscode-widget-border) bg-(--vscode-sideBar-background)/95 backdrop-blur-sm">
					<div class="flex h-7 items-center pr-3 pl-1">
						<button class="flex min-w-0 flex-1 items-center gap-1 text-[11px] font-semibold tracking-wider text-(--vscode-foreground)/70 uppercase" aria-expanded={!collapsed.history} onclick={() => (collapsed.history = !collapsed.history)}>
							<span class={['transition-transform', collapsed.history && '-rotate-90']}><Icon name="chevronDown" size={12} /></span>Commits
							{#if commits}<span class="text-[10px] tabular-nums">{commits.length}{commits.length >= 50 ? '+' : ''}</span>{/if}
						</button>
						<button class="grid place-items-center rounded p-0.5 {MUTED} hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="Refresh commits" title="Refresh commits" onclick={() => (collapsed.history ? (collapsed.history = false) : void loadCommits())}>
							<span class={['grid place-items-center', commitsLoading && 'animate-spin']}><Icon name="refresh" size={12} /></span>
						</button>
					</div>
					{#if !collapsed.history}
						<div class="max-h-[min(256px,33vh)] overflow-y-auto pb-1">
							{#if commitsError}
								<p class="px-6 py-2 text-[11px] text-(--vscode-errorForeground)">{commitsError}</p>
							{:else if !commits}
								<p class="px-6 py-2 text-[11px] {MUTED}">Loading graph...</p>
							{:else}
								{#each commits as c, i (c.hash)}
									{@const isOpen = openCommit === c.hash}
									<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
									<div
										class="grid min-h-[26px] cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1.5 px-3 py-0.5 text-xs hover:bg-(--vscode-list-hoverBackground)/60"
										title={c.subject}
										onclick={() => toggleCommit(c.hash)}
										oncontextmenu={(e) => (e.preventDefault(), (commitMenu = { c, x: e.clientX, y: e.clientY }))}
									>
										<svg width="11" height="26" aria-hidden="true" class="text-[#3794ff]">
											{#if i > 0}<line x1="5.5" y1="0" x2="5.5" y2="13" stroke="currentColor" stroke-width="1.5" />{/if}
											{#if i < commits.length - 1}<line x1="5.5" y1="13" x2="5.5" y2="26" stroke="currentColor" stroke-width="1.5" />{/if}
											<circle cx="5.5" cy="13" r={i === 0 ? 4.5 : 3.5} fill={i === 0 ? 'none' : 'currentColor'} stroke="currentColor" stroke-width="1.5" />
										</svg>
										<span class="truncate">{c.subject}</span>
										<span class="flex shrink-0 items-center gap-1">
											{#each c.refs.slice(0, 2) as ref (ref)}<span class="max-w-[8rem] truncate rounded-full border border-(--vscode-widget-border) px-1.5 py-0.5 text-[10px] {ref.startsWith('origin/') ? 'text-[#b66dff]' : 'text-[#3794ff]'}">{ref}</span>{/each}
											{#if c.refs.length > 2}<span class="text-[10px] {MUTED}">+{c.refs.length - 2}</span>{/if}
										</span>
									</div>
									{#if isOpen}
										<div class="border-l border-(--vscode-widget-border)/60 bg-(--vscode-list-inactiveSelectionBackground)/20 py-1 pl-9 text-[11px] {MUTED}">
											<div>{c.author} · {ago(c.time)} · <span class="font-mono">{c.short}</span></div>
											{#if commitFiles[c.hash] === undefined}
												<div>Loading files…</div>
											{:else if commitFiles[c.hash] === null}
												<div class="text-(--vscode-errorForeground)">Failed to load commit files</div>
											{:else}
												{#each commitFiles[c.hash] ?? [] as [st, path] (path)}
													{@const [fname, fdir] = splitPath(path)}
													<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
													<div class="flex cursor-pointer items-center gap-1.5 rounded-sm pr-3 hover:bg-(--vscode-list-hoverBackground)" title="Open {path} as of {c.short}" onclick={(e) => (e.stopPropagation(), adeLayout.openFile(key, commitDiffKey(slug, c.hash, path)))}>
														<span style:color={decoration(st).color}><FileIcon icon={fileIcon(fname)} size={12} /></span>
														<span class="truncate text-(--vscode-foreground)">{fname}</span><span class="truncate opacity-70">{fdir}</span>
														<span class="ml-auto w-4 shrink-0 text-center text-[10px] font-bold" style:color={decoration(st).color}>{st}</span>
													</div>
												{:else}
													<div>No file changes in this commit</div>
												{/each}
											{/if}
										</div>
									{/if}
								{:else}
									<p class="px-6 py-2 text-[11px] {MUTED}">No commits yet</p>
								{/each}
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

{#if more}
	<PopupMenu items={moreItems} label="Commit and remote actions" x={more.x} y={more.y} onRun={(n) => n.type === 'item' && runMore(n.id)} onClose={() => (more = null)} />
{/if}
{#if rowMenu}
	{@const r = rowMenu.row}
	<PopupMenu items={ROW_ITEMS} label="Change" x={rowMenu.x} y={rowMenu.y} onRun={(n) => n.type === 'item' && runRow(n.id, r)} onClose={() => (rowMenu = null)} />
{/if}
{#if headerMenu}
	<PopupMenu items={headerItems} label="Source control actions" x={headerMenu.x} y={headerMenu.y} onRun={(n) => n.type === 'item' && runHeader(n.id)} onClose={() => (headerMenu = null)} />
{/if}
{#if commitMenu}
	{@const c = commitMenu.c}
	<PopupMenu items={COMMIT_ITEMS} label="Commit" x={commitMenu.x} y={commitMenu.y} onRun={(n) => n.type === 'item' && void runCommit(n.id, c)} onClose={() => (commitMenu = null)} />
{/if}
