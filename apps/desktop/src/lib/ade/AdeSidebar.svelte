<script lang="ts">
	// Agents layout side bar, laid out like Orca's: a search box and Tasks (the board) on top, then
	// Projects: the open folder with its worktrees as cards. The folder itself is the "primary"
	// worktree; each task is a worktree on `kingu/<slug>` with its agent session listed under it.
	import Icon from '#lib/workbench/Icon.svelte';
	import { commands } from '#lib/workbench/commands.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { adeLayout, PRIMARY } from './adeLayout.svelte';
	import { matchesQuery } from './adeTabs';
	import { aggregateStats, STATUS_LABEL, timeAgo, type TaskView } from './model';
	import { adeTasks } from './tasks.svelte';
	import { STATUS_DOT } from './ui';
	import { newSession } from './agentsMode.svelte';

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
		<button class={[NAV, adeLayout.board && 'bg-(--vscode-list-activeSelectionBackground)/40']} aria-pressed={adeLayout.board} onclick={() => (adeLayout.board = !adeLayout.board)}>
			<Icon name="tasks" size={16} /> <span class="flex-1 text-left">Tasks</span>
			{#if adeTasks.counts.needsInput}
				<span class="rounded-full bg-(--vscode-editorWarning-foreground) px-1.5 text-[10px] leading-4 font-semibold text-black" title="รอคุณ">{adeTasks.counts.needsInput}</span>
			{/if}
		</button>
	</div>

	<div class="flex h-7 shrink-0 items-center gap-0.5 pr-2 pl-4">
		<span class="flex-1 text-[13px] text-(--vscode-descriptionForeground)">Projects</span>
		<button class={HEADER_ACTION} aria-label="รีเฟรช" title="รีเฟรช" disabled={!workspace.root} onclick={() => adeTasks.load()}><Icon name="refresh" size={15} /></button>
		<button class={HEADER_ACTION} aria-label="งานใหม่ (worktree ใหม่)" title="งานใหม่ (worktree ใหม่)" disabled={!workspace.root} onclick={newTask}><Icon name="plus" size={16} /></button>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
		{#if !workspace.root}
			<div class="space-y-2 px-2 py-3 text-xs text-(--vscode-descriptionForeground)">
				<p>เปิดโฟลเดอร์ที่เป็น git repository ก่อน แล้วจึงสร้างงานให้ agent ได้</p>
				<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => commands.run('workbench.action.files.openFolder')}>เปิดโฟลเดอร์…</button>
			</div>
		{:else}
			<div class="flex h-9 items-center gap-2 px-2 text-[14px] font-semibold">
				<Icon name="folder" size={16} />
				<span class="truncate">{workspace.name}</span>
			</div>

			<div class="space-y-1.5">
				{#if primaryShown}
					<button
						class={[CARD, selectedKey === PRIMARY ? 'border-(--vscode-widget-border) bg-(--vscode-list-hoverBackground)' : 'border-transparent hover:bg-(--vscode-list-hoverBackground)']}
						aria-current={selectedKey === PRIMARY ? 'true' : undefined}
						onclick={() => adeLayout.show(PRIMARY)}
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
					>
						<span class="flex items-center gap-2">
							<span class={['size-2 shrink-0 rounded-full', STATUS_DOT[v.status]]} title={STATUS_LABEL[v.status]}></span>
							<span class="min-w-0 flex-1 truncate text-[13px]" title={v.meta.title}>{v.meta.title}</span>
							{#if totals && (totals.added || totals.deleted)}
								<span class="shrink-0 font-mono text-[11px]"><span class="text-[#73C991]">+{totals.added}</span> <span class="text-[#F48771]">−{totals.deleted}</span></span>
							{/if}
						</span>
						<span class="mt-0.5 block truncate pl-4 font-mono text-xs text-(--vscode-descriptionForeground)">kingu/{v.meta.slug}</span>
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

	<div class="flex h-9 shrink-0 items-center gap-0.5 border-t border-(--vscode-sideBar-border) px-2">
		<button class={HEADER_ACTION} aria-label="Settings" title="Settings" onclick={() => commands.run('workbench.action.openSettings')}><Icon name="settings" size={16} /></button>
		<span class="flex-1"></span>
		<button class={HEADER_ACTION} aria-label="Open in Editor" title="กลับไปที่ Editor (⇧⌘A)" onclick={() => appMode.setMode('workbench')}><Icon name="code" size={16} /></button>
	</div>
</div>
