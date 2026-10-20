<script lang="ts">
	// Run and Debug view (VS Code debugViewlet): the debug toolbar when `debug.toolBarLocation` is
	// `docked`, then the Variables, Watch, Call Stack and Breakpoints sections. The Call Stack shows
	// one node per session when several run (compounds, js-debug's child sessions); Breakpoints has
	// the exception filters, function and data breakpoints above the source ones.
	import Icon from '#lib/workbench/Icon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { commands, keyOf } from '#lib/workbench/commands.svelte.ts';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { keyLabel } from '#lib/workbench/keys.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { debug } from './debug.svelte.ts';
	import { breakpointMessage, exceptionRows } from './breakpoints.ts';
	import { breakpointRows, variableLabel } from './debugSettings.ts';
	import DebugToolbar from './DebugToolbar.svelte';
	import type { StackFrame, Variable } from './protocol.ts';

	type Section = 'variables' | 'watch' | 'stack' | 'breakpoints';
	let open = $state<Record<Section, boolean>>({ variables: true, watch: true, stack: true, breakpoints: true });
	/** Expanded variables, keyed by their path of names from the scope. */
	let expanded = $state<Record<string, boolean>>({});
	let watchInput = $state('');
	let addingWatch = $state(false);
	let menu = $state<{ x: number; y: number; items: MenuNode[]; run: (id: string) => void } | null>(null);

	const model = $derived(debug.model);
	const caps = $derived(debug.capabilities);
	const breakpointFiles = $derived(Object.entries(debug.breakpoints).sort(([a], [b]) => a.localeCompare(b)));
	// debug.breakpointsView.presentation: a flat list or a tree by file.
	const breakpointList = $derived(breakpointRows(breakpointFiles, settings.get<string>('debug.breakpointsView.presentation')));
	const exceptions = $derived(exceptionRows(debug.exceptions.filters, debug.exceptions.state));
	const anyBreakpoints = $derived(breakpointFiles.length > 0 || debug.functionBreakpoints.length > 0 || debug.dataBreakpoints.length > 0);
	let collapsedFiles = $state<Record<string, boolean>>({});
	// debug.showVariableTypes
	const showTypes = $derived(settings.get<boolean>('debug.showVariableTypes'));
	/** Sessions as a tree: VS Code shows session nodes once more than one runs. */
	const sessionRows = $derived(debug.sessions.map((s) => ({ ...s, depth: depthOf(s.key) })));
	const multi = $derived(debug.sessions.length > 1);

	function depthOf(key: number): number {
		let d = 0;
		let s = debug.sessions.find((x) => x.key === key);
		while (s?.parentKey != null) {
			d++;
			s = debug.sessions.find((x) => x.key === s!.parentKey);
		}
		return d;
	}

	const titled = (label: string, id: string) => {
		const cmd = commands.get(id);
		const key = cmd && keyOf(cmd);
		return key ? `${label} (${keyLabel(key)})` : label;
	};

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

	function showMenu(e: MouseEvent, items: MenuNode[], run: (id: string) => void) {
		e.preventDefault();
		menu = { x: e.clientX, y: e.clientY, items, run };
	}

	/** Variables context menu (VS Code: Set Value, Copy Value, Copy as Expression, Add to Watch, Break on Value Change). */
	function variableMenu(e: MouseEvent, v: Variable, parentRef: number) {
		const items = [
			menuItem('set', t('debugger.menu.setValue'), { enabled: !!caps.supportsSetVariable && debug.stopped }),
			menuItem('copy', t('debugger.menu.copyValue')),
			menuItem('copyExpr', t('debugger.menu.copyExpression'), { enabled: !!v.evaluateName }),
			menuSeparator,
			menuItem('watch', t('debugger.menu.addToWatch'), { enabled: !!(v.evaluateName ?? v.name) }),
			menuItem('data', t('debugger.menu.breakOnChange'), { enabled: debug.dataBreakpointsSupported })
		];
		showMenu(e, items, (id) => {
			if (id === 'set') void debug.setVariable(parentRef, v.name, v.value);
			else if (id === 'copy') void navigator.clipboard.writeText(v.value);
			else if (id === 'copyExpr' && v.evaluateName) void navigator.clipboard.writeText(v.evaluateName);
			else if (id === 'watch') debug.addWatch(v.evaluateName ?? v.name);
			else if (id === 'data') void debug.addDataBreakpoint(parentRef, v.name);
		});
	}

	function frameMenu(e: MouseEvent, f: StackFrame, sessionKey: number) {
		const items = [menuItem('restart', t('debugger.menu.restartFrame'), { enabled: !!caps.supportsRestartFrame && f.canRestart !== false && debug.focusedKey === sessionKey }), menuItem('copy', t('debugger.menu.copyStack'))];
		showMenu(e, items, (id) => {
			if (id === 'restart') void debug.restartFrame(f.id);
			else if (id === 'copy') void navigator.clipboard.writeText((debug.sessions.find((s) => s.key === sessionKey)?.model.frames ?? []).map((x) => `${x.name} (${x.source?.path ?? x.source?.name ?? '?'}:${x.line})`).join('\n'));
		});
	}

	function breakpointMenu(e: MouseEvent, rel: string, line: number) {
		const items = [
			menuItem('condition', t('debugger.menu.editCondition')),
			menuItem('hit', t('debugger.menu.editHitCount')),
			menuItem('log', t('debugger.menu.editLogMessage')),
			menuSeparator,
			menuItem('remove', t('debugger.menu.removeBreakpoint')),
			menuItem('removeAll', t('debugger.menu.removeAll')),
			menuItem('enableAll', t('debugger.menu.enableAll')),
			menuItem('disableAll', t('debugger.menu.disableAll'))
		];
		showMenu(e, items, (id) => {
			if (id === 'condition') void debug.editCondition(rel, line);
			else if (id === 'hit') void debug.editHitCondition(rel, line);
			else if (id === 'log') void debug.editLogMessage(rel, line);
			else if (id === 'remove') debug.removeBreakpoint(rel, line);
			else if (id === 'removeAll') debug.removeAllBreakpoints();
			else if (id === 'enableAll' || id === 'disableAll') debug.setAllBreakpointsEnabled(id === 'enableAll');
		});
	}

	const fileName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);
	const ROW = 'flex h-(--kg-row-height) items-center leading-(--kg-row-height) hover:bg-(--vscode-list-hoverBackground)';
	const ICON_BUTTON = 'grid size-5 shrink-0 place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground)';
	const BADGE = 'shrink-0 rounded-full bg-(--vscode-badge-background) px-1.5 text-[11px] leading-4 text-(--vscode-badge-foreground)';
	const DIM = 'truncate text-xs text-(--vscode-descriptionForeground)';
</script>

{#snippet header(id: Section, title: string)}
	<div class="group/header flex h-(--kg-row-height) shrink-0 items-center pr-2 text-[11px] font-bold text-(--vscode-sideBarTitle-foreground) uppercase hover:bg-(--vscode-list-hoverBackground)">
		<button class="flex h-full min-w-0 flex-1 items-center gap-0.5 pl-0.5 text-left" aria-expanded={open[id]} onclick={() => (open[id] = !open[id])}>
			<Icon name={open[id] ? 'chevronDown' : 'chevronRight'} size={16} />
			<span class="truncate">{title}</span>
		</button>
		{#if id === 'watch'}
			<button aria-label="Add Expression" title="Add Expression" class={ICON_BUTTON} onclick={() => ((open.watch = true), (addingWatch = true))}><Icon name="plus" size={14} /></button>
			{#if debug.watches.length}
				<button aria-label="Remove All Expressions" title="Remove All Expressions" class={ICON_BUTTON} onclick={() => debug.removeAllWatches()}><Icon name="clearAll" size={14} /></button>
			{/if}
		{:else if id === 'breakpoints'}
			<button aria-label="Add Function Breakpoint" title="Add Function Breakpoint" class={ICON_BUTTON} onclick={() => ((open.breakpoints = true), void debug.addFunctionBreakpoint())}><Icon name="plus" size={14} /></button>
			<button
				aria-label="Toggle Activate Breakpoints"
				aria-pressed={!debug.breakpointsActivated}
				title={debug.breakpointsActivated ? t('debugger.deactivate') : t('debugger.activate')}
				class={[ICON_BUTTON, !debug.breakpointsActivated && 'bg-(--vscode-inputOption-activeBackground)']}
				onclick={() => debug.toggleBreakpointsActivated()}><Icon name="breakpoint" size={14} /></button
			>
			{#if anyBreakpoints}
				<button aria-label="Remove All Breakpoints" title="Remove All Breakpoints" class={ICON_BUTTON} onclick={() => debug.removeAllBreakpoints()}><Icon name="trash" size={14} /></button>
			{/if}
		{/if}
	</div>
{/snippet}

{#snippet variables(list: Variable[], depth: number, path: string, parentRef: number)}
	{#each list as v (v.name)}
		{@const key = `${path}/${v.name}`}
		{@const children = v.variablesReference > 0 && expanded[key] ? model?.variables[v.variablesReference] : undefined}
		<div class={ROW} style:padding-left="{depth * 8 + 4}px" title={v.type ? `${v.name}: ${v.type}` : v.name} role="treeitem" aria-selected="false" tabindex="-1" oncontextmenu={(e) => variableMenu(e, v, parentRef)}>
			{#if v.variablesReference > 0}
				<button aria-label={expanded[key] ? 'Collapse' : 'Expand'} class="grid size-4 shrink-0 place-items-center" onclick={() => toggleVar(key, v.variablesReference)}>
					<Icon name={expanded[key] ? 'chevronDown' : 'chevronRight'} size={14} />
				</button>
			{:else}
				<span class="w-4 shrink-0"></span>
			{/if}
			<span class="shrink-0 text-(--vscode-debugTokenExpression-name,var(--vscode-foreground))">{variableLabel(v, showTypes)}</span>
			<span class="shrink-0 pr-1">:</span>
			<span
				class="truncate font-mono text-xs text-(--vscode-descriptionForeground)"
				role="button"
				tabindex="-1"
				ondblclick={() => caps.supportsSetVariable && void debug.setVariable(parentRef, v.name, v.value)}>{v.value}</span
			>
		</div>
		{#if children}{@render variables(children, depth + 1, key, v.variablesReference)}{/if}
	{/each}
{/snippet}

<section class="flex min-h-0 flex-1 flex-col">
	<div class="flex shrink-0 flex-col gap-1.5 px-2 pt-1 pb-2">
		{#if debug.active}
			<DebugToolbar placement="docked" />
		{:else}
			<button
				class="flex h-[26px] items-center justify-center gap-1 rounded-sm bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:brightness-110"
				title={titled('Start Debugging', 'workbench.action.debug.start')}
				onclick={() => commands.run('workbench.action.debug.start')}
			>
				<Icon name="play" size={16} />Run and Debug
			</button>
			<div class="flex gap-3">
				<button class="text-left text-(--vscode-textLink-foreground) hover:underline" onclick={() => commands.run('workbench.action.debug.configure')}>Open launch.json</button>
				<button class="text-left text-(--vscode-textLink-foreground) hover:underline" onclick={() => commands.run('debug.addConfiguration')}>{t('debugger.addConfiguration')}</button>
			</div>
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
				{#if isOpen && model.variables[s.variablesReference]}{@render variables(model.variables[s.variablesReference], 1, key, s.variablesReference)}{/if}
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
		{#if open.stack}
			{#each sessionRows as s (s.key)}
				{@const m = s.model}
				{@const indent = multi ? 12 + s.depth * 8 : 0}
				{#if multi}
					<button
						class={[ROW, 'w-full gap-1 pr-2 text-left', debug.focusedKey === s.key && 'bg-(--vscode-list-inactiveSelectionBackground)']}
						style:padding-left="{4 + s.depth * 8}px"
						title={s.name}
						onclick={() => debug.focusSession(s.key)}
					>
						<Icon name="bug" size={13} />
						<span class="truncate">{s.name}</span>
						<span class="ml-auto shrink-0 text-[11px] text-(--vscode-descriptionForeground) uppercase">{m.state === 'stopped' ? t('debugger.paused') : m.state === 'running' ? 'running' : ''}</span>
					</button>
				{/if}
				{#each m.threads as th (th.id)}
					{@const isStopped = m.stopped?.threadId === th.id}
					<div class={[ROW]} style:padding-left="{indent + 12}px">
						<span class="truncate">{th.name}</span>
						<span class="ml-auto shrink-0 pr-2 text-[11px] text-(--vscode-descriptionForeground) uppercase">{isStopped ? `paused on ${m.stopped?.reason}` : m.state === 'running' ? 'running' : ''}</span>
					</div>
					{#if isStopped}
						{#each m.frames as f (f.id)}
							<button
								class={[ROW, 'w-full gap-2 pr-2 text-left', f.id === m.frameId && debug.focusedKey === s.key && 'bg-(--vscode-list-inactiveSelectionBackground)', (!f.source?.path || f.presentationHint === 'subtle') && 'opacity-60']}
								style:padding-left="{indent + 24}px"
								title={f.source?.path ? `${f.source.path}:${f.line}` : f.name}
								onclick={() => debug.selectFrame(f.id, s.key)}
								oncontextmenu={(e) => frameMenu(e, f, s.key)}
							>
								<span class="min-w-0 flex-1 truncate">{f.name}</span>
								{#if f.source?.name || f.source?.path}<span class="shrink-0 text-xs text-(--vscode-descriptionForeground)">{f.source.name ?? fileName(f.source.path ?? '')}:{f.line}</span>{/if}
							</button>
						{/each}
					{/if}
				{/each}
			{/each}
		{/if}

		{@render header('breakpoints', 'Breakpoints')}
		{#if open.breakpoints}
			<!-- Exception filters (VS Code shows the last session's filters before a session starts). -->
			{#each exceptions as row (row.filter.filter)}
				<div class={['group/row', ROW, 'gap-1.5 pr-2 pl-4']} title={row.filter.description ?? row.filter.label}>
					<input type="checkbox" aria-label={row.filter.label} checked={row.enabled} onchange={(e) => debug.setExceptionFilter(row.filter.filter, e.currentTarget.checked)} />
					<span class="min-w-0 flex-1 truncate">{row.filter.label}</span>
					{#if row.condition}<span class="truncate font-mono text-xs text-(--vscode-descriptionForeground)">{row.condition}</span>{/if}
					{#if row.filter.supportsCondition}
						<button aria-label={t('debugger.menu.editCondition')} title={t('debugger.menu.editCondition')} class={[ICON_BUTTON, 'invisible group-hover/row:visible']} onclick={() => debug.editExceptionCondition(row.filter.filter)}><Icon name="edit" size={12} /></button>
					{/if}
				</div>
			{/each}
			{#each debug.functionBreakpoints as f (f.name)}
				{@const answer = debug.functionVerified(f.name)}
				{@const unsupported = debug.active && !caps.supportsFunctionBreakpoints}
				<div
					class={['group/row', ROW, 'gap-1.5 pr-2 pl-4', (unsupported || answer === null || answer?.verified === false) && 'opacity-60']}
					title={unsupported ? t('debugger.bp.functionUnsupported') : (answer?.message ?? (f.condition ? t('debugger.bp.condition', { condition: f.condition }) : t('debugger.bp.function')))}
					role="listitem"
				>
					<input type="checkbox" aria-label={t('debugger.bp.function')} checked={f.enabled} onchange={(e) => debug.setFunctionBreakpointEnabled(f.name, e.currentTarget.checked)} />
					<Icon name="code" size={12} />
					<span class="min-w-0 flex-1 truncate font-mono text-xs">{f.name}</span>
					{#if f.condition}<span class={DIM}>{f.condition}</span>{/if}
					<button aria-label={t('debugger.menu.editCondition')} title={t('debugger.menu.editCondition')} class={[ICON_BUTTON, 'invisible group-hover/row:visible']} onclick={() => debug.editFunctionCondition(f.name)}><Icon name="edit" size={12} /></button>
					<button aria-label="Remove Breakpoint" title="Remove Breakpoint" class={[ICON_BUTTON, 'invisible group-hover/row:visible']} onclick={() => debug.removeFunctionBreakpoint(f.name)}><Icon name="close" size={12} /></button>
				</div>
			{/each}
			{#each debug.dataBreakpoints as d (d.dataId + d.accessType)}
				<div class={['group/row', ROW, 'gap-1.5 pr-2 pl-4']} title={t('debugger.bp.data')}>
					<input type="checkbox" aria-label={t('debugger.bp.data')} checked={d.enabled} onchange={(e) => debug.setDataBreakpointEnabled(d.dataId, e.currentTarget.checked)} />
					<Icon name="crosshair" size={12} />
					<span class="min-w-0 flex-1 truncate">{d.description}</span>
					<span class={DIM}>{d.accessType}</span>
					<button aria-label="Remove Breakpoint" title="Remove Breakpoint" class={[ICON_BUTTON, 'invisible group-hover/row:visible']} onclick={() => debug.removeDataBreakpoint(d.dataId)}><Icon name="close" size={12} /></button>
				</div>
			{/each}
			{#each breakpointList as row (row.kind === 'file' ? `f:${row.rel}` : `b:${row.rel}:${row.item.line}`)}
				{#if row.kind === 'file'}
					{@const isOpen = !collapsedFiles[row.rel]}
					<button class={[ROW, 'w-full gap-1 pr-2 pl-1 text-left']} aria-expanded={isOpen} title={row.rel} onclick={() => (collapsedFiles[row.rel] = isOpen)}>
						<Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} />
						<span class="truncate">{fileName(row.rel)}</span>
						<span class={DIM}>{row.rel.includes('/') ? row.rel.slice(0, row.rel.lastIndexOf('/')) : ''}</span>
						<span class={['ml-auto', BADGE]}>{row.count}</span>
					</button>
				{:else if !collapsedFiles[row.rel] || row.depth === 0}
					{@const rel = row.rel}
					{@const b = row.item}
					{@const tree = row.depth > 0}
					{@const detail = breakpointMessage(b)}
					<div class={['group/row', ROW, 'gap-1.5 pr-2', tree ? 'pl-8' : 'pl-4', !debug.breakpointsActivated && 'opacity-60']} role="listitem" oncontextmenu={(e) => breakpointMenu(e, rel, b.line)}>
						<input type="checkbox" aria-label="Enable breakpoint" checked={b.enabled} onchange={(e) => debug.setBreakpointEnabled(rel, b.line, e.currentTarget.checked)} />
						<button class="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={detail ? `${rel}:${b.line}\n${detail}` : `${rel}:${b.line}`} onclick={() => editors.openAt(rel, b.line)}>
							{#if !tree}
								<span class="truncate">{fileName(rel)}</span>
								<span class={DIM}>{rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''}</span>
							{:else}
								<span class="truncate">Line {b.line}</span>
							{/if}
							{#if b.logMessage}<span class="truncate font-mono text-xs text-(--vscode-descriptionForeground)">log {b.logMessage}</span>
							{:else if b.condition}<span class="truncate font-mono text-xs text-(--vscode-descriptionForeground)">{b.condition}</span>{/if}
							{#if b.hitCondition}<span class="truncate font-mono text-xs text-(--vscode-descriptionForeground)">#{b.hitCondition}</span>{/if}
						</button>
						{#if !tree}<span class={BADGE}>{b.line}</span>{/if}
						<button aria-label="Edit Breakpoint" title="Edit Breakpoint" class={[ICON_BUTTON, 'invisible group-hover/row:visible']} onclick={() => debug.editBreakpoint(rel, b.line)}><Icon name="edit" size={12} /></button>
						<button aria-label="Remove Breakpoint" title="Remove Breakpoint" class={[ICON_BUTTON, 'invisible group-hover/row:visible']} onclick={() => debug.removeBreakpoint(rel, b.line)}><Icon name="close" size={12} /></button>
					</div>
				{/if}
			{/each}
		{/if}
	</div>
</section>

{#if menu}
	{@const current = menu}
	<PopupMenu items={current.items} label="Debug" x={current.x} y={current.y} onRun={(node) => node.type === 'item' && current.run(node.id)} onClose={() => (menu = null)} />
{/if}
