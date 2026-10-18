<script lang="ts">
	// Run and Debug view (VS Code debugViewlet): the debug toolbar (VS Code floats it; here it heads
	// the view), then the Variables, Watch, Call Stack and Breakpoints sections.
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { commands, keyOf } from '#lib/workbench/commands.svelte.ts';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { keyLabel } from '#lib/workbench/keys.ts';
	import { debug } from './debug.svelte.ts';
	import type { Variable } from './protocol.ts';

	type Section = 'variables' | 'watch' | 'stack' | 'breakpoints';
	let open = $state<Record<Section, boolean>>({ variables: true, watch: true, stack: true, breakpoints: true });
	/** Expanded variables, keyed by their path of names from the scope. */
	let expanded = $state<Record<string, boolean>>({});
	let watchInput = $state('');
	let addingWatch = $state(false);

	const model = $derived(debug.model);
	const breakpointFiles = $derived(Object.entries(debug.breakpoints).sort(([a], [b]) => a.localeCompare(b)));

	const titled = (label: string, id: string) => {
		const cmd = commands.get(id);
		const key = cmd && keyOf(cmd);
		return key ? `${label} (${keyLabel(key)})` : label;
	};
	type Tool = { icon: IconName; label: string; command: string; show: boolean };
	const tools = $derived<Tool[]>([
		{ icon: 'play', label: 'Continue', command: 'workbench.action.debug.start', show: debug.stopped },
		{ icon: 'pause', label: 'Pause', command: 'workbench.action.debug.pause', show: debug.running },
		{ icon: 'stepOver', label: 'Step Over', command: 'workbench.action.debug.stepOver', show: true },
		{ icon: 'stepInto', label: 'Step Into', command: 'workbench.action.debug.stepInto', show: true },
		{ icon: 'stepOut', label: 'Step Out', command: 'workbench.action.debug.stepOut', show: true },
		{ icon: 'refresh', label: 'Restart', command: 'workbench.action.debug.restart', show: true },
		{ icon: 'stop', label: 'Stop', command: 'workbench.action.debug.stop', show: true }
	]);

	function toggleVar(key: string, ref: number) {
		expanded[key] = !expanded[key];
		if (expanded[key]) void debug.expand(ref);
	}

	// Scopes start expanded unless the adapter says they are expensive (VS Code: Registers).
	const scopeOpen = (key: string, expensive: boolean) => expanded[key] ?? !expensive;

	function addWatch() {
		debug.addWatch(watchInput);
		watchInput = '';
		addingWatch = false;
	}

	const fileName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);
	const ROW = 'flex h-(--kg-row-height) items-center leading-(--kg-row-height) hover:bg-(--vscode-list-hoverBackground)';
	const ICON_BUTTON = 'grid size-5 shrink-0 place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground)';
</script>

{#snippet header(id: Section, title: string)}
	<div class="group/header flex h-(--kg-row-height) shrink-0 items-center pr-2 text-[11px] font-bold text-(--vscode-sideBarTitle-foreground) uppercase hover:bg-(--vscode-list-hoverBackground)">
		<button class="flex h-full min-w-0 flex-1 items-center gap-0.5 pl-0.5 text-left" aria-expanded={open[id]} onclick={() => (open[id] = !open[id])}>
			<Icon name={open[id] ? 'chevronDown' : 'chevronRight'} size={16} />
			<span class="truncate">{title}</span>
		</button>
		{#if id === 'watch'}
			<button aria-label="Add Expression" title="Add Expression" class={ICON_BUTTON} onclick={() => ((open.watch = true), (addingWatch = true))}><Icon name="plus" size={14} /></button>
		{:else if id === 'breakpoints' && breakpointFiles.length}
			<button aria-label="Remove All Breakpoints" title="Remove All Breakpoints" class={ICON_BUTTON} onclick={() => debug.removeAllBreakpoints()}><Icon name="trash" size={14} /></button>
		{/if}
	</div>
{/snippet}

{#snippet variables(list: Variable[], depth: number, path: string)}
	{#each list as v (v.name)}
		{@const key = `${path}/${v.name}`}
		{@const children = v.variablesReference > 0 && expanded[key] ? model?.variables[v.variablesReference] : undefined}
		<div class={ROW} style:padding-left="{depth * 8 + 4}px" title={v.type ? `${v.name}: ${v.type}` : v.name}>
			{#if v.variablesReference > 0}
				<button aria-label={expanded[key] ? 'Collapse' : 'Expand'} class="grid size-4 shrink-0 place-items-center" onclick={() => toggleVar(key, v.variablesReference)}>
					<Icon name={expanded[key] ? 'chevronDown' : 'chevronRight'} size={14} />
				</button>
			{:else}
				<span class="w-4 shrink-0"></span>
			{/if}
			<span class="shrink-0 text-(--vscode-debugTokenExpression-name,var(--vscode-foreground))">{v.name}</span>
			<span class="shrink-0 pr-1">:</span>
			<span class="truncate font-mono text-xs text-(--vscode-descriptionForeground)">{v.value}</span>
		</div>
		{#if children}{@render variables(children, depth + 1, key)}{/if}
	{/each}
{/snippet}

<section class="flex min-h-0 flex-1 flex-col">
	<div class="flex shrink-0 flex-col gap-1.5 px-2 pt-1 pb-2">
		{#if debug.active}
			<div role="toolbar" aria-label="Debug" class="flex items-center gap-0.5">
				{#each tools as t (t.label)}
					{#if t.show}
						<button aria-label={t.label} title={titled(t.label, t.command)} disabled={!commands.enabled(t.command)} class={[ICON_BUTTON, 'size-6 disabled:opacity-40']} onclick={() => commands.run(t.command)}>
							<Icon name={t.icon} size={16} />
						</button>
					{/if}
				{/each}
			</div>
		{:else}
			<button
				class="flex h-[26px] items-center justify-center gap-1 rounded-sm bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:brightness-110"
				title={titled('Start Debugging', 'workbench.action.debug.start')}
				onclick={() => commands.run('workbench.action.debug.start')}
			>
				<Icon name="play" size={16} />Run and Debug
			</button>
			<button class="text-left text-(--vscode-textLink-foreground) hover:underline" onclick={() => commands.run('workbench.action.debug.configure')}>Open launch.json</button>
		{/if}
		{#if model}
			<p class="truncate text-(--vscode-descriptionForeground)" title={model.stopped?.description}>{debug.configName}: {debug.label}</p>
		{/if}
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto">
		{@render header('variables', 'Variables')}
		{#if open.variables && model?.state === 'stopped'}
			{#each model.scopes as s (s.name)}
				{@const key = `scope:${s.name}`}
				{@const isOpen = scopeOpen(key, s.expensive)}
				<button class={[ROW, 'w-full pl-1 text-left font-semibold']} onclick={() => ((expanded[key] = !isOpen), !isOpen && void debug.expand(s.variablesReference))}>
					<Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} />{s.name}
				</button>
				{#if isOpen && model.variables[s.variablesReference]}{@render variables(model.variables[s.variablesReference], 1, key)}{/if}
			{/each}
		{/if}

		{@render header('watch', 'Watch')}
		{#if open.watch}
			{#each debug.watches as w (w)}
				{@const r = debug.watchResults[w]}
				<div class={['group/row', ROW, 'pr-2 pl-5']}>
					<span class="shrink-0">{w}</span>
					<span class="shrink-0 pr-1">:</span>
					<span class={['min-w-0 flex-1 truncate font-mono text-xs', r?.error ? 'text-(--vscode-errorForeground)' : 'text-(--vscode-descriptionForeground)']}>{r ? r.value : debug.stopped ? '…' : 'not available'}</span>
					<button aria-label="Remove Expression" title="Remove Expression" class={[ICON_BUTTON, 'invisible group-hover/row:visible']} onclick={() => debug.removeWatch(w)}><Icon name="close" size={12} /></button>
				</div>
			{/each}
			{#if addingWatch}
				<!-- svelte-ignore a11y_autofocus -->
				<input
					autofocus
					aria-label="Watch expression"
					placeholder="Expression to watch"
					bind:value={watchInput}
					class="mx-2 my-0.5 block h-[22px] w-[calc(100%-1rem)] rounded-sm border border-(--vscode-focusBorder) bg-(--vscode-input-background) px-1.5 text-(--vscode-input-foreground) outline-none"
					onkeydown={(e) => (e.key === 'Enter' ? addWatch() : e.key === 'Escape' && ((addingWatch = false), (watchInput = '')))}
					onblur={() => (watchInput.trim() ? addWatch() : (addingWatch = false))}
				/>
			{/if}
		{/if}

		{@render header('stack', 'Call Stack')}
		{#if open.stack && model}
			{#each model.threads as t (t.id)}
				{@const isStopped = model.stopped?.threadId === t.id}
				<div class={[ROW, 'pl-3']}>
					<span class="truncate">{t.name}</span>
					<span class="ml-auto shrink-0 pr-2 text-[11px] text-(--vscode-descriptionForeground) uppercase">{isStopped ? `paused on ${model.stopped?.reason}` : model.state === 'running' ? 'running' : ''}</span>
				</div>
				{#if isStopped}
					{#each model.frames as f (f.id)}
						<button
							class={[ROW, 'w-full gap-2 pr-2 pl-6 text-left', f.id === model.frameId && 'bg-(--vscode-list-inactiveSelectionBackground)', !f.source?.path && 'opacity-60']}
							title={f.source?.path ? `${f.source.path}:${f.line}` : f.name}
							onclick={() => debug.selectFrame(f.id)}
						>
							<span class="min-w-0 flex-1 truncate">{f.name}</span>
							{#if f.source?.name || f.source?.path}<span class="shrink-0 text-xs text-(--vscode-descriptionForeground)">{f.source.name ?? fileName(f.source.path ?? '')}:{f.line}</span>{/if}
						</button>
					{/each}
				{/if}
			{/each}
		{/if}

		{@render header('breakpoints', 'Breakpoints')}
		{#if open.breakpoints}
			{#each breakpointFiles as [rel, list] (rel)}
				{#each list as b (b.line)}
					<div class={['group/row', ROW, 'gap-1.5 pr-2 pl-4']}>
						<input type="checkbox" aria-label="Enable breakpoint" checked={b.enabled} onchange={(e) => debug.setBreakpointEnabled(rel, b.line, e.currentTarget.checked)} />
						<button class="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={b.condition ? `${rel}:${b.line} — ${b.condition}` : `${rel}:${b.line}`} onclick={() => editors.openAt(rel, b.line)}>
							<span class="truncate">{fileName(rel)}</span>
							<span class="truncate text-xs text-(--vscode-descriptionForeground)">{rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''}</span>
							{#if b.condition}<span class="truncate font-mono text-xs text-(--vscode-descriptionForeground)">{b.condition}</span>{/if}
						</button>
						<span class="shrink-0 rounded-full bg-(--vscode-badge-background) px-1.5 text-[11px] leading-4 text-(--vscode-badge-foreground)">{b.line}</span>
						<button aria-label="Remove Breakpoint" title="Remove Breakpoint" class={[ICON_BUTTON, 'invisible group-hover/row:visible']} onclick={() => debug.removeBreakpoint(rel, b.line)}><Icon name="close" size={12} /></button>
					</div>
				{/each}
			{/each}
		{/if}
	</div>
</section>
