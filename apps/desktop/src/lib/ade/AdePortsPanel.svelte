<script lang="ts">
	// Orca's Ports tab: the TCP ports listening on this machine, each attributed to the worktree
	// its process runs in (by working directory, `portOwner`). Scope This Worktree or All; a row
	// opens the server in the browser, copies its URL, jumps to its worktree, or stops it (only a
	// process Kingu started: Rust refuses any other). Scanned every 5 s while the tab shows.
	import Icon from '#lib/workbench/Icon.svelte';
	import { ask } from '#lib/workbench/messageBox.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { system, type Port } from '#lib/workbench/system.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { adeLayout } from './adeLayout.svelte.ts';
	import { portOwner } from './rightSidebar.ts';
	import { adeTasks } from './tasks.svelte.ts';

	/** '' for the folder itself, else a task slug. */
	let { slug }: { slug: string } = $props();

	const SCAN_MS = 5000;
	$effect(() => {
		void system.refreshPorts();
		const timer = setInterval(() => void system.refreshPorts(), SCAN_MS);
		const onFocus = () => void system.refreshPorts();
		window.addEventListener('focus', onFocus);
		return () => (clearInterval(timer), window.removeEventListener('focus', onFocus));
	});

	let scope = $state<'worktree' | 'all'>('worktree');
	type Row = Port & { owner: string | null };
	const all = $derived<Row[]>((system.ports ?? []).map((p) => ({ ...p, owner: portOwner(p.cwd, workspace.root) })));
	const rows = $derived(scope === 'all' ? all : all.filter((p) => p.owner === slug));
	const ownerLabel = (owner: string | null) => (owner === null ? 'External' : owner ? adeTasks.branchOf(owner) : (workspace.name ?? 'Folder'));
	const url = (p: Port) => `http://localhost:${p.port}`;

	async function copy(p: Port) {
		try {
			await navigator.clipboard.writeText(url(p));
			status.flash('URL copied', 2000);
		} catch {
			status.flash("Couldn't copy the URL", 3000);
		}
	}

	async function stop(p: Row) {
		const ok = await ask(`Stop ${p.name} (pid ${p.pid}) listening on port ${p.port}?`, { title: 'Stop process', kind: 'warning', okLabel: 'Stop', cancelLabel: 'Cancel' });
		if (ok) await system.kill(p.pid, `${p.name} :${p.port}`);
	}

	const MUTED = 'text-(--vscode-descriptionForeground)';
	const ICON_BTN = 'grid size-6 shrink-0 place-items-center rounded text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:opacity-40';
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="shrink-0 border-b border-(--vscode-widget-border) px-2.5 py-2">
		<div class="flex items-center gap-1.5">
			<div class="min-w-0 flex-1">
				<div class="truncate text-xs font-semibold">Ports</div>
				<div class="truncate text-[11px] {MUTED}">Servers listening on this machine</div>
			</div>
			<button class={ICON_BTN} aria-label="Refresh Ports" title="Refresh" disabled={system.scanning} onclick={() => system.refreshPorts()}><span class={['grid place-items-center', system.scanning && 'animate-spin']}><Icon name="refresh" size={12} /></span></button>
		</div>
		<div class="mt-2 grid h-7 grid-cols-2 rounded-md border border-(--vscode-widget-border) bg-(--vscode-list-inactiveSelectionBackground)/35 p-px" role="radiogroup" aria-label="Ports scope">
			{#each [['worktree', 'This Worktree'], ['all', 'All']] as const as [id, label] (id)}
				<button
					role="radio"
					aria-checked={scope === id}
					class={['rounded-[5px] text-[11px] font-medium', scope === id ? 'border border-(--vscode-foreground)/20 bg-(--vscode-foreground)/10' : 'hover:bg-(--vscode-list-hoverBackground)']}
					onclick={() => (scope = id)}>{label}</button
				>
			{/each}
		</div>
	</div>
	<div class="min-h-0 flex-1 overflow-auto py-1">
		{#each rows as p (`${p.pid}:${p.port}`)}
			<div class="group flex items-center gap-2 px-2.5 py-1.5 hover:bg-(--vscode-list-hoverBackground)">
				<span class={['size-1.5 shrink-0 rounded-full', p.ours ? 'bg-[#73C991]' : 'bg-(--vscode-descriptionForeground)/60']} title={p.ours ? 'Started under Kingu' : 'Started outside Kingu'}></span>
				<div class="min-w-0 flex-1">
					<div class="flex items-baseline gap-1.5 text-xs">
						<span class="font-mono font-semibold tabular-nums">{p.port}</span>
						<span class="min-w-0 truncate">{p.name}</span>
					</div>
					<div class="flex min-w-0 items-center gap-1 text-[11px] {MUTED}">
						<span class="shrink-0 tabular-nums">pid {p.pid}</span>
						<span class="opacity-55">·</span>
						{#if p.owner !== null && p.owner !== adeLayout.key}
							<button class="min-w-0 truncate hover:text-(--vscode-foreground) hover:underline" title="Jump to its worktree" onclick={() => adeLayout.show(p.owner ?? '')}>{ownerLabel(p.owner)}</button>
						{:else}
							<span class="min-w-0 truncate" title={p.cwd ?? ''}>{ownerLabel(p.owner)}</span>
						{/if}
					</div>
				</div>
				<button class={ICON_BTN} aria-label="Open in Browser" title="Open {url(p)}" onclick={() => system.openPort(p.port)}><Icon name="openExternal" size={14} /></button>
				<button class={ICON_BTN} aria-label="Copy URL" title="Copy URL" onclick={() => copy(p)}><Icon name="copy" size={14} /></button>
				<button class={ICON_BTN} aria-label="Stop Process" title={p.ours ? 'Stop process' : 'Only processes started under Kingu can be stopped here'} disabled={!p.ours} onclick={() => stop(p)}><Icon name="stopProcess" size={14} /></button>
			</div>
		{:else}
			<div class="flex h-full flex-col items-center justify-center px-4 text-center {MUTED}">
				<span class="mb-3 opacity-50"><Icon name="ports" size={28} /></span>
				{#if system.portsError}
					<p class="text-sm font-medium">Couldn't scan ports</p>
					<p class="mt-1 text-[11px] break-words">{system.portsError}</p>
				{:else if system.ports === null}
					<p class="text-sm font-medium">Scanning…</p>
				{:else}
					<p class="text-sm font-medium">{scope === 'all' ? 'No listening ports' : 'No servers running in this worktree'}</p>
					{#if scope === 'worktree' && all.length}<button class="mt-2 text-[11px] text-(--vscode-textLink-foreground) hover:underline" onclick={() => (scope = 'all')}>Show all {all.length}</button>{/if}
				{/if}
			</div>
		{/each}
	</div>
</div>
