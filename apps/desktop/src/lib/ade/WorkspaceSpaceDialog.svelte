<script lang="ts">
	// Workspace Space (Orca's workspaceSpace view): how much disk each worktree of the open project
	// takes, largest first, with its biggest top-level folders. The main checkout is never counted as
	// reclaimable. Read only: Clean Up Tasks… and a task's Remove… do the deleting, each with its own
	// confirmation. Rules and numbers: MECHANICS.md › Workspace Space.
	import Icon from '#lib/workbench/Icon.svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { adeTasks } from './tasks.svelte';
	import { runtime } from './runtime.svelte';
	import { cleanup } from './cleanup.svelte';
	import { adeDialogs } from './dialogs.svelte.ts';
	import { workspaceSpace as space } from './workspaceSpace.svelte';
	import { STATUS_TEXT, formatBytes, progressText, rowLabel, share, type SpaceRow } from './workspaceSpace';

	const a = $derived(space.analysis);
	const largest = $derived(a?.rows[0]?.sizeBytes ?? 0);

	function rel(row: SpaceRow): string | null {
		const root = workspace.root;
		if (!root) return null;
		if (row.path === root) return '';
		return row.path.startsWith(`${root}/`) ? row.path.slice(root.length + 1) : null;
	}

	function reveal(row: SpaceRow) {
		const r = rel(row);
		if (r === null) return notifications.error(`${row.path} is outside the open folder`);
		invoke('fs_reveal', { rel: r }).catch((e) => notifications.error(e));
	}

	const removable = (row: SpaceRow) => !row.isMain && !!row.slug && !!adeTasks.find(row.slug) && !runtime.isWorking(row.slug);

	function remove(row: SpaceRow) {
		if (!row.slug) return;
		space.close();
		adeDialogs.open({ kind: 'remove', slug: row.slug });
	}

	function cleanUp() {
		space.close();
		cleanup.open = true;
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			space.close();
		}
	}

	const MUTED = 'text-(--vscode-descriptionForeground)';
	const ICON_BTN = 'grid size-6 shrink-0 place-items-center rounded text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:opacity-40';
</script>

<svelte:window {onkeydown} />

<div class="fixed inset-0 z-[65] grid place-items-center bg-black/40 p-6" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && space.close()}>
	<div role="dialog" aria-modal="true" aria-labelledby="kg-space-title" class="flex max-h-[80vh] w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) text-(--vscode-foreground) shadow-2xl shadow-black/50">
		<header class="flex items-center gap-2.5 px-5 pt-5 pb-3">
			<Icon name="chartBar" size={18} />
			<h2 id="kg-space-title" class="flex-1 text-[14px] font-semibold">Workspace Space</h2>
			{#if space.running}
				<button class="rounded-md px-2 text-xs text-(--vscode-textLink-foreground) hover:underline" onclick={() => space.cancel()}>Stop</button>
			{:else}
				<button class={ICON_BTN} aria-label="Measure again" title="Measure again" onclick={() => space.analyze()}><Icon name="refresh" size={14} /></button>
			{/if}
			<button class={ICON_BTN} aria-label="Close" title="Close" onclick={() => space.close()}><Icon name="close" size={14} /></button>
		</header>

		<!-- Totals: what every worktree takes, and what removing the tasks would give back. -->
		<div class="grid grid-cols-3 gap-2 px-5 pb-3">
			<div class="rounded-lg bg-(--vscode-foreground)/5 px-3 py-2">
				<div class="text-[11px] {MUTED}">Total</div>
				<div class="text-[15px] font-semibold tabular-nums" data-testid="space-total">{a ? formatBytes(a.totalBytes) : '—'}</div>
			</div>
			<div class="rounded-lg bg-(--vscode-foreground)/5 px-3 py-2">
				<div class="text-[11px] {MUTED}">Reclaimable</div>
				<div class="text-[15px] font-semibold tabular-nums text-(--vscode-charts-green,#3fb950)">{a ? formatBytes(a.reclaimableBytes) : '—'}</div>
			</div>
			<div class="rounded-lg bg-(--vscode-foreground)/5 px-3 py-2">
				<div class="text-[11px] {MUTED}">Workspaces</div>
				<div class="text-[15px] font-semibold tabular-nums">{a ? a.worktreeCount : '—'}{#if a?.unavailableCount}<span class="ml-1 text-[11px] font-normal {MUTED}">({a.unavailableCount} not measured)</span>{/if}</div>
			</div>
		</div>

		{#if space.running}
			<div class="px-5 pb-3" role="status">
				<div class="mb-1 truncate text-[12px] {MUTED}">{progressText(space.progress)}</div>
				<div class="h-1 overflow-hidden rounded bg-(--vscode-foreground)/10">
					<div class="h-full bg-(--vscode-progressBar-background,#0e70c0) transition-[width]" style:width="{space.progress?.total ? (space.progress.scanned / space.progress.total) * 100 : 5}%"></div>
				</div>
			</div>
		{/if}
		{#if space.error}<p class="px-5 pb-3 text-[12px] text-(--vscode-errorForeground)">{space.error}</p>{/if}

		<ul class="min-h-0 flex-1 overflow-y-auto border-y border-(--vscode-widget-border) py-1">
			{#each a?.rows ?? [] as row (row.path)}
				{@const open = !!space.expanded[row.path]}
				<li class="mx-1.5 rounded-md hover:bg-(--vscode-list-hoverBackground)/60">
					<div class="group/space flex items-center gap-2 px-2 py-1.5">
						<button class="grid size-5 shrink-0 place-items-center rounded {MUTED} disabled:opacity-0" aria-label={open ? 'Hide folders' : 'Show folders'} aria-expanded={open} disabled={!row.topItems.length} onclick={() => space.toggle(row.path)}>
							<span class={['grid place-items-center transition-transform', !open && '-rotate-90']}><Icon name="chevronDown" size={12} /></span>
						</button>
						<span class="min-w-0 flex-1">
							<span class="flex items-baseline gap-1.5">
								<span class="truncate text-[13px]">{rowLabel(row)}</span>
								{#if row.isMain}<span class="shrink-0 rounded bg-(--vscode-foreground)/10 px-1 text-[10px] {MUTED}">main checkout</span>{/if}
								{#if row.status !== 'ok'}<span class="shrink-0 text-[11px] text-(--vscode-errorForeground)" title={row.error ?? ''}>{STATUS_TEXT[row.status]}</span>{/if}
							</span>
							<span class="mt-1 block h-1.5 overflow-hidden rounded bg-(--vscode-foreground)/8">
								<span class={['block h-full rounded', row.isMain ? 'bg-(--vscode-foreground)/30' : 'bg-(--vscode-progressBar-background,#0e70c0)']} style:width="{share(row.sizeBytes, largest)}%"></span>
							</span>
						</span>
						<span class="w-16 shrink-0 text-right font-mono text-[12px] tabular-nums">{formatBytes(row.sizeBytes)}</span>
						<span class="flex shrink-0 gap-0.5 opacity-0 group-hover/space:opacity-100 group-focus-within/space:opacity-100">
							<button class={ICON_BTN} aria-label="Reveal in Finder" title="Reveal in Finder" onclick={() => reveal(row)}><Icon name="folder" size={13} /></button>
							<button class={ICON_BTN} aria-label="Remove task" title={row.isMain ? "The main checkout can't be removed" : 'Remove task…'} disabled={!removable(row)} onclick={() => remove(row)}><Icon name="trash" size={13} /></button>
						</span>
					</div>
					{#if open}
						<ul class="pb-1.5 pl-9 pr-3">
							{#each row.topItems as item (item.path || item.name)}
								<li class="flex items-center gap-2 py-0.5 text-[12px]">
									<Icon name={item.kind === 'directory' ? 'folder' : item.kind === 'file' ? 'file' : 'more'} size={12} />
									<span class="min-w-0 flex-1 truncate {item.kind === 'other' ? MUTED : ''}">{item.kind === 'other' ? `${row.omittedItemCount} more` : item.name}</span>
									<span class="h-1 w-20 shrink-0 overflow-hidden rounded bg-(--vscode-foreground)/8"><span class="block h-full bg-(--vscode-foreground)/35" style:width="{share(item.sizeBytes, row.sizeBytes)}%"></span></span>
									<span class="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums {MUTED}">{formatBytes(item.sizeBytes)}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</li>
			{:else}
				<li class="px-5 py-8 text-center text-[13px] {MUTED}">{space.running ? 'Measuring…' : workspace.root ? 'No workspaces measured yet.' : 'Open a folder to measure its workspaces.'}</li>
			{/each}
		</ul>
		<footer class="flex items-center gap-3 px-5 py-3">
			<span class="flex-1 text-[12px] {MUTED}">{a?.scannedAt ? `Measured ${new Date(a.scannedAt).toLocaleTimeString()}` : ''}</span>
			<button class="h-8 rounded-md px-3.5 text-[13px] hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => space.close()}>Close</button>
			<button class="h-8 rounded-md bg-(--vscode-button-background) px-3.5 text-[13px] font-medium text-(--vscode-button-foreground) hover:opacity-90 disabled:opacity-40" disabled={!adeTasks.views.length} onclick={cleanUp}>Clean Up Tasks…</button>
		</footer>
	</div>
</div>
