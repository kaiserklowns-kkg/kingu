<script lang="ts">
	// Agents layout side bar, laid out like Orca's: a search box and Tasks (the board) on top, then
	// Projects: the open folder with its worktrees as cards. The folder itself is the "primary"
	// worktree; each task is a worktree on `kingu/<slug>` with its agent session listed under it.
	import Icon from '#lib/workbench/Icon.svelte';
	import { commands } from '#lib/workbench/commands.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { adeLayout, PRIMARY } from './adeLayout.svelte';
	import { matchesQuery } from './adeTabs';
	import { aggregateStats, STATUS_LABEL, timeAgo, type TaskView } from './model';
	import { adeTasks } from './tasks.svelte';
	import { cleanup } from './cleanup.svelte';
	import { STATUS_DOT } from './ui';
	import { newSession } from './agentsMode.svelte';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import { actionsFor, runWorktreeAction } from './worktreeMenu.svelte';
	import type { WorktreeAction } from './worktreeActions';

	/** Needs-attention first, then in progress, then done (Orca keeps busy worktrees on top). */
	const ordered = $derived([...adeTasks.groups.attention, ...adeTasks.groups.active, ...adeTasks.groups.done]);
	const shown = $derived(ordered.filter((v) => matchesQuery(adeLayout.query, v.meta.title, `kingu/${v.meta.slug}`)));
	const primaryShown = $derived(matchesQuery(adeLayout.query, workspace.name, status.branch));
	const selectedKey = $derived(adeLayout.board ? null : adeLayout.key);

	const summary = (v: TaskView) => v.runtime?.lastEvent ?? v.meta.last_run?.summary ?? STATUS_LABEL[v.status];
	const when = (v: TaskView) => Math.max(v.meta.updated_at, v.runtime?.updatedAt ?? 0);

	function newTask() {
		adeLayout.show(PRIMARY);
		adeLayout.select(PRIMARY, 'main');
		newSession();
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

	let collapsed = $state(false);

	const VIEWS = [
		{ board: false, label: 'Worktrees', icon: 'git' },
		{ board: true, label: 'Tasks', icon: 'tasks' }
	] as const;
	const HEADER_ACTION = 'grid size-[22px] place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
	// Explorer rows: inset, rounded, the focus outline on the selection.
	const ROW = 'mx-1.5 block w-[calc(100%-12px)] rounded-md py-1 pr-2 pl-2 text-left outline-offset-[-1px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)';
	const rowState = (selected: boolean) =>
		selected ? 'bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground) outline outline-1 outline-(--vscode-focusBorder)' : 'hover:bg-(--vscode-list-hoverBackground)';
</script>

<!-- Laid out like the IDE side bar: view icons on top, the view title, then an Explorer-style tree. -->
<div class="flex h-full min-h-0 flex-col bg-(--vscode-sideBar-background) text-(--vscode-sideBar-foreground)">
	<div class="flex h-(--kg-part-title-height) shrink-0 items-center px-1.5">
		{#each VIEWS as v (v.label)}
			{@const on = adeLayout.board === v.board}
			<button
				class={['relative grid h-full w-8 place-items-center text-(--vscode-foreground)', on ? '' : 'opacity-60 hover:opacity-100']}
				aria-label={v.label}
				aria-pressed={on}
				title={v.label}
				onclick={() => (adeLayout.board = v.board)}
			>
				{#if on}<span class="absolute inset-x-1 bottom-0 h-px bg-(--vscode-foreground)"></span>{/if}
				<Icon name={v.icon} size={16} filled={on} />
				{#if v.board && adeTasks.counts.needsInput}
					<span class="absolute top-0.5 right-0 h-3.5 min-w-3.5 rounded-full bg-(--vscode-activityBarBadge-background) px-0.5 text-center text-[8px] leading-3.5 font-semibold text-(--vscode-activityBarBadge-foreground)" title="รอคุณ">{adeTasks.counts.needsInput}</span>
				{/if}
			</button>
		{/each}
		<span class="flex-1"></span>
		<button class={HEADER_ACTION} aria-label="งานใหม่ (worktree ใหม่)" title="งานใหม่ (worktree ใหม่)" disabled={!workspace.root} onclick={newTask}><Icon name="plus" size={16} /></button>
		<button class={HEADER_ACTION} aria-label="รีเฟรช" title="รีเฟรช" disabled={!workspace.root} onclick={() => adeTasks.load()}><Icon name="refresh" size={15} /></button>
		<button class={HEADER_ACTION} aria-label="ล้างงาน" title="ล้างงาน (Clean Up Tasks)" disabled={!adeTasks.views.length} onclick={() => (cleanup.open = true)}><Icon name="trash" size={15} /></button>
	</div>
	<div class="flex h-6 shrink-0 items-center pl-5 text-[11px] text-(--vscode-sideBarTitle-foreground) uppercase">{adeLayout.board ? 'Tasks' : 'Worktrees'}</div>

	<label class="mx-2.5 mt-1 mb-2 flex h-[26px] shrink-0 items-center gap-1.5 rounded-md border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) px-2 text-[13px] focus-within:border-(--vscode-focusBorder)">
		<Icon name="search" size={14} />
		<span class="sr-only">ค้นหา worktree</span>
		<input
			class="min-w-0 flex-1 bg-transparent outline-none placeholder:text-(--vscode-input-placeholderForeground)"
			placeholder="ค้นหา worktree"
			bind:value={adeLayout.query}
			onkeydown={(e) => e.key === 'Escape' && (adeLayout.query = '')}
		/>
	</label>

	{#if menu}
		<PopupMenu
			items={menuItems}
			label="Worktree"
			x={menu.x}
			y={menu.y}
			focusFirst={menu.keyboard}
			onRun={(node) => node.type === 'item' && menu && runWorktreeAction(menu.key, node.id as WorktreeAction)}
			onClose={() => (menu = null)}
		/>
	{/if}

	<div class="min-h-0 flex-1 overflow-y-auto pb-2">
		{#if !workspace.root}
			<div class="space-y-2 px-5 py-2 text-xs text-(--vscode-descriptionForeground)">
				<p>เปิดโฟลเดอร์ที่เป็น git repository ก่อน แล้วจึงสร้างงานให้ agent ได้</p>
				<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => commands.run('workbench.action.files.openFolder')}>เปิดโฟลเดอร์…</button>
			</div>
		{:else}
			<!-- The folder, as the Explorer's root section. -->
			<button
				class="flex h-(--kg-row-height) w-full items-center gap-0.5 px-0.5 text-[11px] font-bold text-(--vscode-sideBarTitle-foreground) uppercase"
				aria-expanded={!collapsed}
				onclick={() => (collapsed = !collapsed)}
			>
				<Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={16} />
				<span class="min-w-0 flex-1 truncate text-left">{workspace.name}</span>
				<span class="pr-3 font-normal normal-case opacity-70">{shown.length + (primaryShown ? 1 : 0)}</span>
			</button>

			{#if !collapsed}
				<div class="space-y-px">
					{#if primaryShown}
						<button
							class={[ROW, rowState(selectedKey === PRIMARY)]}
							aria-current={selectedKey === PRIMARY ? 'true' : undefined}
							onclick={() => adeLayout.show(PRIMARY)}
							oncontextmenu={(e) => openMenu(PRIMARY, e)}
						>
							<span class="flex h-5 items-center gap-2">
								<span class="grid size-4 shrink-0 place-items-center"><span class="size-2 rounded-full bg-[#73C991]"></span></span>
								<span class="truncate text-[13px]">{workspace.name}</span>
								<span class="shrink-0 rounded border border-current/30 px-1 text-[10px] leading-3.5 opacity-70">primary</span>
							</span>
							<span class="block truncate pl-6 font-mono text-[11px] opacity-70">{status.branch || 'HEAD'}</span>
						</button>
					{/if}

					{#each shown as v (v.meta.slug)}
						{@const selected = selectedKey === v.meta.slug}
						{@const totals = v.stat ? aggregateStats(v.stat.files) : null}
						<button
							class={[ROW, rowState(selected)]}
							aria-current={selected ? 'true' : undefined}
							aria-label="{v.meta.title} — {STATUS_LABEL[v.status]}"
							onclick={() => adeLayout.show(v.meta.slug)}
							oncontextmenu={(e) => openMenu(v.meta.slug, e)}
						>
							<span class="group/card flex h-5 items-center gap-2">
								<!-- Orca's worktree marker: a bell when the agent waits for you, a spinner while it works. -->
								<span class="grid size-4 shrink-0 place-items-center">
									{#if v.status === 'waiting'}
										<span class="kg-ring text-(--vscode-editorWarning-foreground)" title={STATUS_LABEL[v.status]}><Icon name="bell" size={13} filled /></span>
									{:else if v.status === 'running'}
										<span class="size-2.5 animate-spin rounded-full border-[1.5px] border-(--vscode-editorInfo-foreground) border-t-transparent" title={STATUS_LABEL[v.status]}></span>
									{:else}
										<span class={['size-2 rounded-full', STATUS_DOT[v.status]]} title={STATUS_LABEL[v.status]}></span>
									{/if}
								</span>
								<span class="min-w-0 flex-1 truncate text-[13px]" title={v.meta.title}>{v.meta.title}</span>
								{#if totals && (totals.added || totals.deleted)}
									<span class="shrink-0 font-mono text-[11px] group-hover/card:hidden"><span class="text-[#73C991]">+{totals.added}</span> <span class="text-[#F48771]">−{totals.deleted}</span></span>
								{/if}
								<span
									role="button"
									tabindex="0"
									aria-label="การทำงานของ worktree"
									title="การทำงานของ worktree"
									class="hidden size-5 shrink-0 place-items-center rounded group-hover/card:grid hover:bg-(--vscode-toolbar-hoverBackground) focus-visible:grid"
									onclick={(e) => openMenu(v.meta.slug, e)}
									onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && openMenu(v.meta.slug, e as unknown as MouseEvent)}><Icon name="more" size={14} /></span
								>
							</span>
							<span class="flex items-center gap-1.5 pl-6 text-[11px]">
								<span class={['min-w-0 flex-1 truncate', v.status === 'waiting' ? 'text-(--vscode-editorWarning-foreground)' : 'opacity-70']}>{summary(v)}</span>
								<span class="shrink-0 opacity-60">{timeAgo(when(v), adeTasks.now)}</span>
							</span>
						</button>
					{/each}
					{#if adeLayout.query && !shown.length && !primaryShown}
						<p class="px-5 py-1 text-xs text-(--vscode-descriptionForeground)">ไม่พบ worktree ที่ตรงกับ “{adeLayout.query}”</p>
					{/if}
				</div>
			{/if}
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
