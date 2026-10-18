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
	import { aggregateStats, STATUS_LABEL, timeAgo, type TaskView } from './model';
	import { adeTasks } from './tasks.svelte';
	import { automations } from './automations.svelte.ts';
	import { STATUS_DOT } from './ui';
	import { newSession } from './agentsMode.svelte';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import { actionsFor, runWorktreeAction } from './worktreeMenu.svelte';
	import type { WorktreeAction } from './worktreeActions';
	import { repoDialog } from '#lib/workbench/repoDialog.svelte.ts';
	import { scm } from '#lib/workbench/scm.svelte.ts';

	/** Needs-attention first, then in progress, then done (Orca keeps busy worktrees on top). */
	const ordered = $derived([...adeTasks.groups.attention, ...adeTasks.groups.active, ...adeTasks.groups.done]);
	const shown = $derived(ordered.filter((v) => matchesQuery(adeLayout.query, v.meta.title, adeTasks.branchOf(v.meta.slug))));
	const primaryShown = $derived(matchesQuery(adeLayout.query, workspace.name, status.branch));
	const selectedKey = $derived(adeLayout.board ? null : adeLayout.key);

	const summary = (v: TaskView) => v.runtime?.lastEvent ?? v.meta.last_run?.summary ?? STATUS_LABEL[v.status];
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
		<button
			class={[NAV, adeLayout.page === 'issues' && 'bg-(--vscode-list-activeSelectionBackground)/40']}
			aria-pressed={adeLayout.page === 'issues'}
			disabled={!workspace.root}
			onclick={() => adeLayout.togglePage('issues')}
		>
			<Icon name="bug" size={16} /> <span class="flex-1 text-left">Issues</span>
		</button>
	</div>

	<div class="flex h-7 shrink-0 items-center gap-0.5 pr-2 pl-4">
		<span class="flex-1 text-[13px] text-(--vscode-descriptionForeground)">Projects</span>
		<button class={HEADER_ACTION} aria-label="รีเฟรช" title="รีเฟรช" disabled={!workspace.root} onclick={() => adeTasks.load()}><Icon name="refresh" size={15} /></button>
		<button class={HEADER_ACTION} aria-label="เพิ่ม: งานใหม่หรือโปรเจกต์" title="งานใหม่ / เปิด, clone หรือสร้างโปรเจกต์" aria-haspopup="menu" onclick={openAddMenu}><Icon name="plus" size={16} /></button>
	</div>

	{#if addMenu}
		<PopupMenu items={ADD_ITEMS} label="เพิ่ม" x={addMenu.x} y={addMenu.y} focusFirst={addMenu.keyboard} onRun={(node) => node.type === 'item' && runAdd(node.id)} onClose={() => (addMenu = null)} />
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
			<div class="flex h-9 items-center gap-2 px-2 text-[14px] font-semibold">
				<Icon name="folder" size={16} />
				<span class="truncate">{workspace.name}</span>
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

				{#each shown as v (v.meta.slug)}
					{@const selected = selectedKey === v.meta.slug}
					{@const totals = v.stat ? aggregateStats(v.stat.files) : null}
					<button
						class={[CARD, selected ? 'border-(--vscode-widget-border) bg-(--vscode-list-hoverBackground)' : 'border-transparent hover:bg-(--vscode-list-hoverBackground)']}
						aria-current={selected ? 'true' : undefined}
						aria-label="{v.meta.title} — {STATUS_LABEL[v.status]}"
						onclick={() => adeLayout.show(v.meta.slug)}
						oncontextmenu={(e) => openMenu(v.meta.slug, e)}
					>
						<span class="group/card flex items-center gap-2">
							<!-- Orca's worktree marker: a bell when the agent waits for you, a spinner while it works. -->
							{#if v.status === 'waiting'}
								<span class="kg-ring -mx-0.5 shrink-0 text-(--vscode-editorWarning-foreground)" title={STATUS_LABEL[v.status]}><Icon name="bell" size={13} filled /></span>
							{:else if v.status === 'running'}
								<span class="size-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-(--vscode-editorInfo-foreground) border-t-transparent" title={STATUS_LABEL[v.status]}></span>
							{:else}
								<span class={['size-2 shrink-0 rounded-full', STATUS_DOT[v.status]]} title={STATUS_LABEL[v.status]}></span>
							{/if}
							<span class="min-w-0 flex-1 truncate text-[13px]" title={v.meta.title}>{v.meta.title}</span>
							<span
								role="button"
								tabindex="0"
								aria-label="การทำงานของ worktree"
								title="การทำงานของ worktree"
								class="grid size-5 shrink-0 place-items-center rounded opacity-0 group-hover/card:opacity-100 hover:bg-(--vscode-toolbar-hoverBackground) focus-visible:opacity-100"
								onclick={(e) => openMenu(v.meta.slug, e)}
								onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && openMenu(v.meta.slug, e as unknown as MouseEvent)}>⋯</span
							>
							{#if totals && (totals.added || totals.deleted)}
								<span class="shrink-0 font-mono text-[11px]"><span class="text-[#73C991]">+{totals.added}</span> <span class="text-[#F48771]">−{totals.deleted}</span></span>
							{/if}
						</span>
						<span class="mt-0.5 block truncate pl-4 font-mono text-xs text-(--vscode-descriptionForeground)">{adeTasks.branchOf(v.meta.slug)}</span>
						<span class="mt-1 flex items-center gap-1.5 pl-4 text-xs">
							<span class={['shrink-0', v.status === 'waiting' ? 'text-(--vscode-editorWarning-foreground)' : 'text-(--vscode-descriptionForeground)']}><Icon name="agent" size={12} /></span>
							<span class={['min-w-0 flex-1 truncate', v.status === 'waiting' ? 'text-(--vscode-editorWarning-foreground)' : 'text-(--vscode-foreground)/80']}>{summary(v)}</span>
							<span class="shrink-0 text-[11px] text-(--vscode-descriptionForeground)">{timeAgo(when(v), adeTasks.now)}</span>
						</span>
					</button>
				{/each}
				{#if adeLayout.query && !shown.length && !primaryShown}
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
