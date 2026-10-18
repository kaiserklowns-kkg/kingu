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
	import { decoration, diffKey, splitPath, taskDiffKey, type GitStatus, type StatusEntry } from '#lib/workbench/scm.ts';
	import { fileIcon } from '#lib/workbench/fileIcons.ts';
	import { adeLayout, PRIMARY } from './adeLayout.svelte';
	import { adeTasks } from './tasks.svelte';
	import { worktreeDir } from './keys';
	import { drafts } from './scmDrafts';

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
		// Kingu's sync pulls then pushes; with nothing to pull it only pushes, and without an upstream it publishes.
		return void run(p.label, 'git_sync', {});
	}
	let more = $state<{ x: number; y: number } | null>(null);
	const moreItems = $derived<MenuNode[]>([
		menuItem('commit', 'Commit', { enabled: !!staged && !!message.trim() && !busy }),
		menuItem('commitPush', 'Commit & Push', { enabled: !!staged && !!message.trim() && !busy && !!repo?.upstream }),
		menuItem('commitSync', 'Commit & Sync', { enabled: !!staged && !!message.trim() && !busy && !!repo?.upstream }),
		menuSeparator,
		menuItem('push', repo?.ahead ? `Push (${repo.ahead})` : 'Push', { enabled: !!repo?.upstream && !!repo.ahead && !busy }),
		menuItem('pull', repo?.behind ? `Pull (${repo.behind})` : 'Pull', { enabled: !!repo?.upstream && !!repo.behind && !busy }),
		menuItem('sync', repo && (repo.ahead || repo.behind) ? `Sync (↓${repo.behind} ↑${repo.ahead})` : 'Sync', { enabled: !!repo?.upstream && !busy }),
		menuItem('publish', 'Publish Branch', { enabled: !!repo?.branch && !repo.upstream && !busy })
	]);
	function runMore(id: string) {
		if (id === 'commit') void commit();
		else if (id === 'commitPush') void commit('push');
		else if (id === 'commitSync') void commit('sync');
		else void run(id === 'publish' ? 'Publish Branch' : id[0].toUpperCase() + id.slice(1), 'git_sync', {});
	}

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
		else if (id === 'explorer') adeLayout.rightTab = 'files';
	}

	const prNumber = $derived(task?.meta.pr_url?.match(/\/(\d+)\/?$/)?.[1]);
	const base = $derived(slug ? (task?.meta.base ?? null) : (repo?.upstream ?? null));
	const ahead = $derived(slug ? (task?.stat?.ahead ?? 0) : (repo?.ahead ?? 0));
	const behind = $derived(slug ? (task?.stat?.behind ?? 0) : (repo?.behind ?? 0));
	const cleanBranch = $derived(loaded && repo && !repo.entries.length && !ahead);

	const HEADER_BTN = 'grid size-7 shrink-0 place-items-center rounded-sm text-(--vscode-descriptionForeground) transition-colors hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)';
	const ACT = 'grid size-6 place-items-center rounded text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:cursor-not-allowed disabled:opacity-50';
	const MUTED = 'text-(--vscode-descriptionForeground)';
</script>

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
					<button class={HEADER_BTN} aria-label="Refresh" title="Refresh" onclick={refresh}><Icon name="refresh" size={14} /></button>
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
							<span class="truncate font-mono text-[10.5px] font-medium text-(--vscode-foreground)/90">{base.replace(/^refs\/(remotes|heads|tags)\//, '')}</span>
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

			{#if !conflicts}
				<div class="px-3 pb-2">
					{#if !cleanBranch}
						<textarea
							class="mt-0.5 min-h-14 w-full resize-none rounded-md border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-2 py-1.5 text-xs outline-none placeholder:text-(--vscode-input-placeholderForeground) focus-visible:border-(--vscode-focusBorder) disabled:cursor-not-allowed disabled:opacity-60"
							placeholder="Message"
							aria-label="Commit message"
							{rows}
							disabled={!!busy || !staged}
							bind:value={message}
						></textarea>
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
						{#each list as r (r.area + r.entry.path)}
							{@const [name, dir] = splitPath(r.entry.path)}
							{@const n = (r.area === 'staged' ? stats.staged : stats.unstaged)[r.entry.path]}
							<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
							<div
								class="group relative flex cursor-pointer items-center gap-1 py-1 pr-3 pl-5 transition-colors hover:bg-(--vscode-list-hoverBackground)/60"
								title={r.entry.path}
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
						{/each}
					{/if}
				{/if}
			{/each}
			{#if filter && !SECTION_ORDER.some((s) => sections[s.area].length)}
				<div class="px-4 py-6">
					<div class="text-sm font-medium">No matching files</div>
					<div class="mt-1 text-xs {MUTED}">No changed files match "{filter}"</div>
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
