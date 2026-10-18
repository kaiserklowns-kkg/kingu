<script lang="ts">
	// Agents layout side bar, laid out like Orca's: a search box, Tasks (the board), Automations and Issues on top, then
	// Projects: the open folder with its worktrees as cards. The folder itself is the "primary"
	// worktree; each task is a worktree on `kingu/<slug>` with its agent session listed under it.
	import Icon from '#lib/workbench/Icon.svelte';
	import { commands } from '#lib/workbench/commands.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { adeLayout, PRIMARY } from './adeLayout.svelte';
	import { matchesQuery } from './adeTabs';
	import { aggregateStats, isQuestion, MAX_TITLE, STATUS_LABEL, statusLabel, timeAgo, type TaskView } from './model';
	import { adeTasks } from './tasks.svelte';
	import { automations } from './automations.svelte.ts';
	import { QUESTION_TEXT, statusDot } from './ui';
	import { newSession } from './agentsMode.svelte';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import { actionsFor, runWorktreeAction } from './worktreeMenu.svelte';
	import type { WorktreeAction } from './worktreeActions';
	import { repoDialog } from '#lib/workbench/repoDialog.svelte.ts';
	import { scm } from '#lib/workbench/scm.svelte.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { baseName, cardProperties, externalWorktrees, hexColor, sidebarGroups, type Visibility } from './sidebarView';
	import { sidebarPrefs, sidebarTask } from './sidebarState.svelte';
	import { prStatuses } from './prStatus.svelte';
	import { isLinear, issueRef } from './issues.ts';
	import { openWorktreeIn } from './worktreeMenu.svelte';
	import { openInLabels } from './worktreeActions';

	// The ADE Sidebar settings (Orca's sidebar UI preferences): filters, sort, grouping and card properties.
	const prefs = $derived(sidebarPrefs());
	const groups = $derived(
		sidebarGroups(
			adeTasks.views.filter((v) => matchesQuery(adeLayout.query, v.meta.title, adeTasks.branchOf(v.meta.slug))).map(sidebarTask),
			prefs
		)
	);
	const shownCount = $derived(groups.reduce((n, g) => n + g.tasks.length, 0));
	const props = $derived(cardProperties(settings.get<unknown[]>('kingu.sidebar.cardProperties'), settings.get<boolean>('kingu.sidebar.compactCards') === true));
	const primaryShown = $derived(settings.get<boolean>('kingu.sidebar.hideDefaultBranch') !== true && !prefs.showActiveOnly && matchesQuery(adeLayout.query, workspace.name, status.branch));
	const selectedKey = $derived(adeLayout.board ? null : adeLayout.key);
	// Repository display (Orca's per-repo display name, badge color and icon).
	const repoName = $derived((settings.get<string>('kingu.repo.displayName') ?? '').trim() || workspace.name);
	const repoBadge = $derived(hexColor(settings.get<string>('kingu.repo.badgeColor')));
	const repoIcon = $derived([...(settings.get<string>('kingu.repo.icon') ?? '').trim()].slice(0, 2).join(''));
	// Worktrees Kingu did not make (Orca's external / agent worktree visibility): read-only cards.
	const externals = $derived(
		workspace.root
			? externalWorktrees(adeTasks.listed, workspace.root, {
					external: settings.get<Visibility>('kingu.worktree.externalVisibility'),
					agent: settings.get<Visibility>('kingu.worktree.agentVisibility'),
					custom: settings.get<string[]>('kingu.worktree.visibilitySources')
				}).filter((w) => matchesQuery(adeLayout.query, baseName(w.path), w.branch ?? ''))
			: []
	);
	const openIn = $derived(openInLabels(settings.get<Record<string, unknown>>('kingu.worktree.openIn')));
	let externalMenu = $state<{ path: string; x: number; y: number } | null>(null);

	// PR state for grouping and the card's PR property: read once per task (gh) when either needs it.
	const asked = new Set<string>();
	$effect(() => {
		if (prefs.groupBy !== 'pr-status' && !props.has('pr')) return;
		for (const v of adeTasks.views) {
			const slug = v.meta.slug;
			if (asked.has(slug) || prStatuses.bySlug[slug]) continue;
			asked.add(slug);
			void prStatuses.refresh(slug, { threads: false });
		}
	});

	const summary = (v: TaskView) => v.runtime?.lastEvent ?? v.meta.last_run?.summary ?? statusLabel(v);
	const when = (v: TaskView) => Math.max(v.meta.updated_at, v.runtime?.updatedAt ?? 0);

	function newTask() {
		adeLayout.show(PRIMARY);
		adeLayout.select(PRIMARY, 'main');
		newSession();
	}

	/** The open folder is not a git repository: tasks need one (Orca adds only git projects). */
	const notGit = $derived(!!workspace.root && scm.loaded && scm.repo === null);
	async function initGit() {
		if (await scm.init(true)) await adeTasks.load();
	}

	// Orca's Projects "+": add a project (open, clone, create), next to a new task here.
	let addMenu = $state<{ x: number; y: number; keyboard: boolean } | null>(null);
	const ADD_ITEMS = $derived([
		menuItem('task', 'งานใหม่ (worktree ใหม่)', { enabled: !!workspace.root && !notGit }),
		menuSeparator,
		menuItem('open', 'เปิดโฟลเดอร์…'),
		menuItem('clone', 'Clone repository…'),
		menuItem('create', 'สร้างโปรเจกต์ใหม่…')
	]);
	function openAddMenu(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		addMenu = { x: r.right - 220, y: r.bottom + 2, keyboard: e.detail === 0 };
	}
	function runAdd(id: string) {
		if (id === 'task') newTask();
		else if (id === 'open') void commands.run('workbench.action.files.openFolder');
		else void repoDialog.show(id === 'clone' ? 'clone' : 'create');
	}

	// Orca's worktree context menu: right-click a card (or its ⋯ button).
	let menu = $state<{ key: string; x: number; y: number; keyboard: boolean } | null>(null);
	const menuItems = $derived(
		menu ? actionsFor(menu.key).map((r) => (r === 'separator' ? menuSeparator : menuItem(r.id, r.label, { enabled: r.enabled ?? true }))) : []
	);
	function openMenu(key: string, e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		menu = e.type === 'contextmenu' && e.clientX ? { key, x: e.clientX, y: e.clientY, keyboard: false } : { key, x: r.right - 248, y: r.bottom + 2, keyboard: e.detail === 0 };
	}

	// Orca's WorktreeTitleInlineRename: Enter or leaving the box saves, Escape cancels; empty or
	// unchanged keeps the old name. Only the display name changes, never the branch.
	let renameValue = $state('');
	let saving = false;
	$effect(() => {
		const slug = adeTasks.renaming;
		if (slug) renameValue = adeTasks.find(slug)?.meta.title ?? '';
	});
	function focusSelect(node: HTMLInputElement) {
		node.focus();
		node.select();
	}
	async function commitRename(slug: string) {
		if (saving || adeTasks.renaming !== slug) return;
		saving = true;
		try {
			await adeTasks.rename(slug, renameValue);
		} finally {
			saving = false;
			if (adeTasks.renaming === slug) adeTasks.renaming = null;
		}
	}
	function onRenameKey(e: KeyboardEvent, slug: string) {
		if (e.isComposing) return;
		if (e.key === 'Enter') {
			e.preventDefault();
			void commitRename(slug);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			adeTasks.renaming = null;
		}
	}

	const NAV = 'flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] hover:bg-(--vscode-list-hoverBackground)';
	const HEADER_ACTION = 'grid size-6 place-items-center rounded-md text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:opacity-40';
	const CARD = 'block w-full rounded-lg border px-2.5 py-2 text-left outline-none focus-visible:border-(--vscode-focusBorder)';
</script>

<div class="flex h-full min-h-0 flex-col text-(--vscode-foreground)">
	<div class="shrink-0 space-y-0.5 px-2 pt-2 pb-3">
		<label class="mb-1.5 flex h-8 items-center gap-2 rounded-lg bg-(--vscode-input-background) px-2.5 text-[13px] focus-within:outline focus-within:outline-1 focus-within:outline-(--vscode-focusBorder)">
			<Icon name="search" size={15} />
			<span class="sr-only">ค้นหา worktree</span>
			<input
				class="min-w-0 flex-1 bg-transparent outline-none placeholder:text-(--vscode-input-placeholderForeground)"
				placeholder="Search"
				bind:value={adeLayout.query}
				onkeydown={(e) => e.key === 'Escape' && (adeLayout.query = '')}
			/>
		</label>
		<button class={[NAV, adeLayout.page === 'board' && 'bg-(--vscode-list-activeSelectionBackground)/40']} aria-pressed={adeLayout.page === 'board'} onclick={() => adeLayout.togglePage('board')}>
			<Icon name="tasks" size={16} /> <span class="flex-1 text-left">Tasks</span>
			{#if adeTasks.counts.needsInput}
				<span class="rounded-full bg-(--vscode-editorWarning-foreground) px-1.5 text-[10px] leading-4 font-semibold text-black" title="รอคุณ">{adeTasks.counts.needsInput}</span>
			{/if}
		</button>
		{#if settings.get<boolean>('kingu.sidebar.showAutomations') !== false}
		<button
			class={[NAV, adeLayout.page === 'automations' && 'bg-(--vscode-list-activeSelectionBackground)/40']}
			aria-pressed={adeLayout.page === 'automations'}
			disabled={!workspace.root}
			onclick={() => adeLayout.togglePage('automations')}
		>
			<Icon name="clock" size={16} /> <span class="flex-1 text-left">Automations</span>
			{#if automations.activeCount}
				<span class="text-[11px] text-(--vscode-descriptionForeground)" title={automations.globalEnabled ? 'automation ที่เปิดอยู่' : 'หยุดทั้งหมดอยู่'}>{automations.globalEnabled ? automations.activeCount : 'หยุด'}</span>
			{/if}
		</button>
		{/if}
		{#if settings.get<boolean>('kingu.sidebar.showIssues') !== false}
		<button
			class={[NAV, adeLayout.page === 'issues' && 'bg-(--vscode-list-activeSelectionBackground)/40']}
			aria-pressed={adeLayout.page === 'issues'}
			disabled={!workspace.root}
			onclick={() => adeLayout.togglePage('issues')}
		>
			<Icon name="bug" size={16} /> <span class="flex-1 text-left">Issues</span>
		</button>
		{/if}
	</div>

	<div class="flex h-7 shrink-0 items-center gap-0.5 pr-2 pl-4">
		<span class="flex-1 text-[13px] text-(--vscode-descriptionForeground)">Projects</span>
		<button class={HEADER_ACTION} aria-label="รีเฟรช" title="รีเฟรช" disabled={!workspace.root} onclick={() => adeTasks.load()}><Icon name="refresh" size={15} /></button>
		<button class={HEADER_ACTION} aria-label="เพิ่ม: งานใหม่หรือโปรเจกต์" title="งานใหม่ / เปิด, clone หรือสร้างโปรเจกต์" aria-haspopup="menu" onclick={openAddMenu}><Icon name="plus" size={16} /></button>
	</div>

	{#if addMenu}
		<PopupMenu items={ADD_ITEMS} label="เพิ่ม" x={addMenu.x} y={addMenu.y} focusFirst={addMenu.keyboard} onRun={(node) => node.type === 'item' && runAdd(node.id)} onClose={() => (addMenu = null)} />
	{/if}

	{#if externalMenu}
		{@const path = externalMenu.path}
		<PopupMenu
			items={[...openIn.map((l) => menuItem(`openIn:${l}`, `เปิดใน ${l} (Open in ${l})`)), ...(openIn.length ? [menuSeparator] : []), menuItem('copyPath', 'คัดลอก path')]}
			label="Worktree"
			x={externalMenu.x}
			y={externalMenu.y}
			onRun={(node) => {
				if (node.type !== 'item') return;
				if (node.id.startsWith('openIn:')) openWorktreeIn(node.id.slice(7), path);
				else void navigator.clipboard.writeText(path).then(() => status.flash('คัดลอก path แล้ว'));
			}}
			onClose={() => (externalMenu = null)}
		/>
	{/if}

	{#if menu}
		<!-- PopupMenu closes (menu = null) before it runs the item, so the key is taken here. -->
		{@const key = menu.key}
		<PopupMenu
			items={menuItems}
			label="Worktree"
			x={menu.x}
			y={menu.y}
			focusFirst={menu.keyboard}
			onRun={(node) => node.type === 'item' && runWorktreeAction(key, node.id as WorktreeAction)}
			onClose={() => (menu = null)}
		/>
	{/if}

	<div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
		{#if !workspace.root}
			<div class="space-y-2 px-2 py-3 text-xs text-(--vscode-descriptionForeground)">
				<p>เปิดโฟลเดอร์ที่เป็น git repository ก่อน แล้วจึงสร้างงานให้ agent ได้</p>
				<button class="block text-(--vscode-textLink-foreground) hover:underline" onclick={() => commands.run('workbench.action.files.openFolder')}>เปิดโฟลเดอร์…</button>
				<button class="block text-(--vscode-textLink-foreground) hover:underline" onclick={() => repoDialog.show('clone')}>Clone repository…</button>
				<button class="block text-(--vscode-textLink-foreground) hover:underline" onclick={() => repoDialog.show('create')}>สร้างโปรเจกต์ใหม่…</button>
			</div>
		{:else}
			<div class="flex h-9 items-center gap-2 px-2 text-[14px] font-semibold" title={workspace.root}>
				{#if repoIcon}
					<span class="grid size-4 shrink-0 place-items-center text-[13px] leading-none">{repoIcon}</span>
				{:else}
					<Icon name="folder" size={16} />
				{/if}
				<span class="truncate">{repoName}</span>
				{#if repoBadge}
					<span class="size-2 shrink-0 rounded-full" style:background={repoBadge} aria-hidden="true"></span>
				{/if}
			</div>

			{#if notGit}
				<div class="mb-2 space-y-1.5 rounded-lg border border-(--vscode-widget-border) px-2.5 py-2 text-xs">
					<p class="text-(--vscode-descriptionForeground)">โฟลเดอร์นี้ยังไม่เป็น git repository งานของ agent ต้องแตก git worktree จึงยังสร้างงานไม่ได้</p>
					<button class="text-(--vscode-textLink-foreground) hover:underline disabled:opacity-50" disabled={scm.busy} onclick={initGit}>เริ่มใช้ git (git init + commit แรก)</button>
				</div>
			{/if}
			<div class="space-y-1.5">
				{#if primaryShown}
					<button
						class={[CARD, selectedKey === PRIMARY ? 'border-(--vscode-widget-border) bg-(--vscode-list-hoverBackground)' : 'border-transparent hover:bg-(--vscode-list-hoverBackground)']}
						aria-current={selectedKey === PRIMARY ? 'true' : undefined}
						onclick={() => adeLayout.show(PRIMARY)}
						oncontextmenu={(e) => openMenu(PRIMARY, e)}
					>
						<span class="flex items-center gap-2">
							<span class="size-2 shrink-0 rounded-full bg-[#73C991]"></span>
							<span class="truncate text-[13px]">{workspace.name}</span>
							<span class="shrink-0 rounded border border-(--vscode-widget-border) px-1.5 text-[11px] leading-4 text-(--vscode-descriptionForeground)">primary</span>
						</span>
						<span class="mt-0.5 block truncate pl-4 text-xs text-(--vscode-descriptionForeground)">{status.branch || 'HEAD'}</span>
					</button>
				{/if}

				{#each groups as g (g.id)}
				{#if g.label}
					<div class="flex items-center gap-1.5 px-2 pt-2 pb-0.5 text-[11px] font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase">
						<span class="truncate">{g.label}</span>
						<span class="font-normal">{g.tasks.length}</span>
					</div>
				{/if}
				{#each g.tasks as t (t.slug)}
					{@const v = t.view}
					{@const selected = selectedKey === v.meta.slug}
					{@const pr = prStatuses.bySlug[v.meta.slug]?.pr}
					{@const totals = v.stat ? aggregateStats(v.stat.files) : null}
					{#if adeTasks.renaming === v.meta.slug}
						<div class={[CARD, 'border-(--vscode-focusBorder) bg-(--vscode-list-hoverBackground)']}>
							<input
								class="h-6 w-full rounded-sm border border-(--vscode-focusBorder) bg-(--vscode-input-background) px-1.5 text-[13px] text-(--vscode-input-foreground) outline-none"
								aria-label="เปลี่ยนชื่องาน"
								maxlength={MAX_TITLE}
								bind:value={renameValue}
								use:focusSelect
								onkeydown={(e) => onRenameKey(e, v.meta.slug)}
								onblur={() => void commitRename(v.meta.slug)}
							/>
							<span class="mt-0.5 block truncate pl-1 font-mono text-xs text-(--vscode-descriptionForeground)" title="branch ไม่เปลี่ยน">{adeTasks.branchOf(v.meta.slug)}</span>
						</div>
					{:else}
					<button
						class={[CARD, selected ? 'border-(--vscode-widget-border) bg-(--vscode-list-hoverBackground)' : 'border-transparent hover:bg-(--vscode-list-hoverBackground)']}
						aria-current={selected ? 'true' : undefined}
						aria-label="{v.meta.title} — {statusLabel(v)}"
						onclick={() => adeLayout.show(v.meta.slug)}
						oncontextmenu={(e) => openMenu(v.meta.slug, e)}
					>
						<span class="group/card flex items-center gap-2">
							<!-- Orca's worktree marker: a bell when the agent waits for you, a spinner while it works. -->
							{#if isQuestion(v)}
								<span class="-mx-0.5 shrink-0 {QUESTION_TEXT}" title={statusLabel(v)}><Icon name="question" size={13} filled /></span>
							{:else if v.status === 'waiting'}
								<span class="kg-ring -mx-0.5 shrink-0 text-(--vscode-editorWarning-foreground)" title={statusLabel(v)}><Icon name="bell" size={13} filled /></span>
							{:else if v.status === 'running'}
								<span class="size-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-(--vscode-editorInfo-foreground) border-t-transparent" title={statusLabel(v)}></span>
							{:else if props.has('status')}
								<span class={['size-2 shrink-0 rounded-full', statusDot(v)]} title={statusLabel(v)}></span>
							{/if}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<span class="min-w-0 flex-1 truncate text-[13px]" title="{v.meta.title} (ดับเบิลคลิกเพื่อเปลี่ยนชื่อ)" ondblclick={(e) => (e.stopPropagation(), adeTasks.startRename(v.meta.slug))}>{v.meta.title}</span>
							<span
								role="button"
								tabindex="0"
								aria-label="การทำงานของ worktree"
								title="การทำงานของ worktree"
								class="grid size-5 shrink-0 place-items-center rounded opacity-0 group-hover/card:opacity-100 hover:bg-(--vscode-toolbar-hoverBackground) focus-visible:opacity-100"
								onclick={(e) => openMenu(v.meta.slug, e)}
								onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && openMenu(v.meta.slug, e as unknown as MouseEvent)}>⋯</span
							>
							{#if props.has('diff') && totals && (totals.added || totals.deleted)}
								<span class="shrink-0 font-mono text-[11px]"><span class="text-[#73C991]">+{totals.added}</span> <span class="text-[#F48771]">−{totals.deleted}</span></span>
							{/if}
						</span>
						{#if props.has('branch') || props.has('pr') || props.has('issue') || props.has('automation')}
							<span class="mt-0.5 flex items-center gap-1.5 truncate pl-4 text-xs text-(--vscode-descriptionForeground)">
								{#if props.has('branch')}<span class="min-w-0 flex-1 truncate font-mono">{adeTasks.branchOf(v.meta.slug)}</span>{:else}<span class="flex-1"></span>{/if}
								{#if props.has('automation') && v.meta.origin === 'automation'}
									<span class="shrink-0 rounded border border-(--vscode-widget-border) px-1 text-[10px] leading-4" title="งานที่ automation สร้าง">auto</span>
								{/if}
								{#if props.has('issue') && v.meta.issue}
									<span class="shrink-0 font-mono" title="{isLinear(v.meta.issue) ? 'Linear' : 'GitHub'}: {v.meta.issue.title}">{issueRef(v.meta.issue)}</span>
								{/if}
								{#if props.has('pr') && pr}
									<span class="shrink-0 font-mono" title="PR #{pr.number}: {pr.title} ({pr.draft ? 'DRAFT' : pr.state})">PR #{pr.number}</span>
								{/if}
							</span>
						{/if}
						{#if props.has('activity') || props.has('time')}
							<span class="mt-1 flex items-center gap-1.5 pl-4 text-xs">
								{#if props.has('activity')}
									<span class={['shrink-0', isQuestion(v) ? QUESTION_TEXT : v.status === 'waiting' ? 'text-(--vscode-editorWarning-foreground)' : 'text-(--vscode-descriptionForeground)']}><Icon name={isQuestion(v) ? 'question' : 'agent'} size={12} /></span>
									<span class={['min-w-0 flex-1 truncate', isQuestion(v) ? QUESTION_TEXT : v.status === 'waiting' ? 'text-(--vscode-editorWarning-foreground)' : 'text-(--vscode-foreground)/80']}>{summary(v)}</span>
								{:else}<span class="flex-1"></span>{/if}
								{#if props.has('time')}<span class="shrink-0 text-[11px] text-(--vscode-descriptionForeground)">{timeAgo(when(v), adeTasks.now)}</span>{/if}
							</span>
						{/if}
					</button>
					{/if}
				{/each}
				{/each}

				{#each externals as w (w.path)}
					<!-- Not made by Kingu (Orca's external / agent worktrees): a read-only card that opens the folder elsewhere. -->
					<button
						class={[CARD, 'border-transparent hover:bg-(--vscode-list-hoverBackground)']}
						title="{w.path} — worktree ที่ Kingu ไม่ได้สร้าง ({w.kind === 'agent' ? 'ของ agent' : 'ภายนอก'})"
						onclick={(e) => {
							const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
							externalMenu = { path: w.path, x: r.left + 16, y: r.bottom + 2 };
						}}
						oncontextmenu={(e) => {
							e.preventDefault();
							externalMenu = { path: w.path, x: e.clientX, y: e.clientY };
						}}
					>
						<span class="flex items-center gap-2">
							<span class="size-2 shrink-0 rounded-full border border-(--vscode-descriptionForeground)"></span>
							<span class="min-w-0 flex-1 truncate text-[13px]">{baseName(w.path)}</span>
							<span class="shrink-0 rounded border border-(--vscode-widget-border) px-1.5 text-[11px] leading-4 text-(--vscode-descriptionForeground)">{w.kind === 'agent' ? 'agent' : 'external'}</span>
						</span>
						<span class="mt-0.5 block truncate pl-4 font-mono text-xs text-(--vscode-descriptionForeground)">{w.branch ?? (w.detached ? 'detached HEAD' : '')}</span>
					</button>
				{/each}
				{#if adeLayout.query && !shownCount && !primaryShown && !externals.length}
					<p class="px-2 py-1 text-xs text-(--vscode-descriptionForeground)">ไม่พบ worktree ที่ตรงกับ “{adeLayout.query}”</p>
				{/if}
			</div>
		{/if}
	</div>

</div>

<style>
	/* The waiting bell rings now and then, unless the user asks for less motion. */
	.kg-ring {
		animation: kg-ring 2.4s ease-in-out infinite;
		transform-origin: 50% 10%;
	}
	@keyframes kg-ring {
		0%, 80%, 100% {
			transform: rotate(0);
		}
		84% {
			transform: rotate(14deg);
		}
		90% {
			transform: rotate(-12deg);
		}
		95% {
			transform: rotate(6deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.kg-ring {
			animation: none;
		}
	}
</style>
