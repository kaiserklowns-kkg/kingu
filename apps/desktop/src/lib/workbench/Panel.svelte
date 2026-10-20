<script lang="ts">
	import DebugConsole from '#lib/debug/DebugConsole.svelte';
	import ProblemsView from '#lib/lsp/ProblemsView.svelte';
	import Terminal from '#lib/terminal/Terminal.svelte';
	import { terminals } from '#lib/terminal/terminals.svelte.ts';
	import PaneSplitView from '#lib/terminal/PaneSplitView.svelte';
	import { leaves } from '#lib/terminal/paneLayout.ts';
	import { focusTerminal } from '#lib/terminal/registry.ts';
	import { showTabsList } from '#lib/terminal/behaviour.ts';
	import Icon, { type IconName } from './Icon.svelte';
	import { editors } from './editors.svelte';
	import { isMac, keyLabel } from './keys';
	import { layout, type PanelTab } from './layout.svelte';
	import { panelOpensMaximized } from './workbenchOptions';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { onMount, tick, untrack } from 'svelte';
	import { t } from '#lib/i18n/index.ts';
	import OutputView from '#lib/output/OutputView.svelte';
	import { output } from '#lib/output/output.svelte.ts';
	import { LINE_LEVELS, type LineLevel } from '#lib/output/output.ts';
	import { installOutputCommands } from '#lib/output/outputCommands.svelte.ts';
	import { problemsView } from '#lib/lsp/problemsViewState.svelte.ts';
	import PopupMenu, { menuItem, menuSeparator } from './PopupMenu.svelte';
	import type { MenuNode } from './menus';
	import { panelSize } from './panelSize.svelte';

	// View: Maximize Panel Size (panelSize.svelte.ts, shared with workbench.action.toggleMaximizedPanel).
	const maximized = $derived(panelSize.maximized);
	const toggleMaximize = () => panelSize.toggle();
	onMount(() => installOutputCommands());

	// workbench.panel.opensMaximized: when the panel is shown again, maximize it (always), restore
	// it (never) or keep the state it had when it was hidden (preserve).
	let wasVisible = untrack(() => layout.panelVisible);
	let maximizedWhenHidden = false;
	$effect(() => {
		const visible = layout.panelVisible;
		untrack(() => {
			if (visible === wasVisible) return;
			wasVisible = visible;
			if (!visible) {
				maximizedWhenHidden = maximized;
				return;
			}
			if (panelOpensMaximized(settings.get<string>('workbench.panel.opensMaximized'), maximizedWhenHidden) !== maximized) toggleMaximize();
		});
	});

	// The Problems view's filter toggles (VS Code's More Filters… menu).
	let filterMenu = $state<{ x: number; y: number } | null>(null);
	// The Output view's level filter for a log channel (VS Code: the Output filter's level checkboxes).
	let levelMenu = $state<{ x: number; y: number } | null>(null);
	const levelItems = $derived(LINE_LEVELS.map((l) => menuItem(l, t(`output.logLevel.${l}`), { checked: !output.hiddenLevels.includes(l) })));
	function runLevel(node: MenuNode) {
		if (node.type !== 'item') return;
		const l = node.id as LineLevel;
		output.hiddenLevels = output.hiddenLevels.includes(l) ? output.hiddenLevels.filter((x) => x !== l) : [...output.hiddenLevels, l];
	}
	const filterItems = $derived([
		menuItem('errors', t('problems.showErrors'), { checked: problemsView.showErrors }),
		menuItem('warnings', t('problems.showWarnings'), { checked: problemsView.showWarnings }),
		menuItem('infos', t('problems.showInfos'), { checked: problemsView.showInfos }),
		menuSeparator,
		menuItem('activeFile', t('problems.activeFile'), { checked: problemsView.activeFile }),
		menuItem('excludedFiles', t('problems.excludedFiles'), { checked: problemsView.excludedFiles })
	]);
	function runFilter(node: MenuNode) {
		if (node.type !== 'item') return;
		const v = problemsView;
		if (node.id === 'errors') v.showErrors = !v.showErrors;
		else if (node.id === 'warnings') v.showWarnings = !v.showWarnings;
		else if (node.id === 'infos') v.showInfos = !v.showInfos;
		else if (node.id === 'activeFile') v.activeFile = !v.activeFile;
		else if (node.id === 'excludedFiles') v.excludedFiles = !v.excludedFiles;
	}
	const moreFiltersOn = $derived(!problemsView.showErrors || !problemsView.showWarnings || !problemsView.showInfos || problemsView.activeFile || problemsView.excludedFiles);
	let problemsFilterInput: HTMLInputElement | undefined = $state();
	$effect(() => {
		if (!problemsView.focusFilterRequested) return;
		problemsView.focusFilterRequested = false;
		void tick().then(() => (problemsFilterInput?.focus(), problemsFilterInput?.select()));
	});

	/** workbench.panel.showLabels: the panel's tabs as labels, or as icons with the label as a tooltip. */
	const showLabels = $derived(settings.get<boolean>('workbench.panel.showLabels'));

	const activeGroup = $derived(terminals.groupOf(terminals.active));
	// terminal.integrated.tabs.enabled / hideCondition / location / focusMode.
	const tabsShown = $derived(
		showTabsList(settings.get<boolean>('terminal.integrated.tabs.enabled'), settings.get<string>('terminal.integrated.tabs.hideCondition'), terminals.list.length, terminals.groups.length)
	);
	const tabsLeft = $derived(settings.get<string>('terminal.integrated.tabs.location') === 'left');
	const focusOnDoubleClick = $derived(settings.get<string>('terminal.integrated.tabs.focusMode') === 'doubleClick');
	const splitKey = keyLabel(isMac ? 'cmd+\\' : 'ctrl+shift+5');

	/** A terminal's context menu items beyond copy/paste/clear (VS Code: Split, Rename, Kill). */
	function terminalAction(id: number, action: string) {
		if (action === 'split') terminals.split(id);
		else if (action === 'rename') void terminals.rename(id);
		else if (action === 'kill') void terminals.kill(id);
	}

	/** A followed file link opens pinned at its position, like VS Code's terminal link opener. */
	function openFile(rel: string, line?: number, column?: number) {
		editors.open(rel, { preview: false, reveal: line ? { line, column: column ?? 1, focus: true } : undefined });
	}

	const tabs: { id: PanelTab; label: string; icon: IconName }[] = [
		{ id: 'problems', label: 'Problems', icon: 'warning' },
		{ id: 'output', label: 'Output', icon: 'note' },
		{ id: 'debugConsole', label: 'Debug Console', icon: 'bug' },
		{ id: 'terminal', label: 'Terminal', icon: 'terminal' }
	];
</script>

<section aria-label="Panel" class="flex h-full flex-col border-t border-(--vscode-panel-border) bg-(--vscode-panel-background)">
	<div role="tablist" aria-label="Panel" class="flex h-(--kg-part-title-height) shrink-0 items-center gap-1 px-2">
		{#each tabs as t (t.id)}
			<button
				role="tab"
				aria-selected={layout.panelTab === t.id}
				class={[
					'h-full border-b px-2 text-[11px] uppercase',
					layout.panelTab === t.id
						? 'border-(--vscode-panelTitle-activeBorder) text-(--vscode-panelTitle-activeForeground)'
						: 'border-transparent text-(--vscode-panelTitle-inactiveForeground) hover:text-(--vscode-panelTitle-activeForeground)'
				]}
				aria-label={t.label}
				title={showLabels ? undefined : t.label}
				onclick={() => (layout.panelTab = t.id)}>{#if showLabels}{t.label}{:else}<Icon name={t.icon} size={16} />{/if}</button
			>
		{/each}
		<div class="flex-1"></div>
		{#if layout.panelTab === 'output'}
			<!-- VS Code's Output view title: filter, channel dropdown, clear, scroll lock, open in editor. -->
			<input
				type="search"
				aria-label={t('output.filter')}
				placeholder={t('output.filter')}
				bind:value={output.filter}
				class="h-[22px] w-44 min-w-0 rounded-sm border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) px-1.5 text-xs text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground) focus:border-(--vscode-focusBorder)"
			/>
			{#if output.isLog(output.active)}
				<button
					aria-label={t('output.logLevel.filter')}
					title={t('output.logLevel.filter')}
					class={['grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)', output.hiddenLevels.length && 'bg-(--vscode-inputOption-activeBackground)']}
					onclick={(e) => {
						const r = e.currentTarget.getBoundingClientRect();
						levelMenu = { x: r.left, y: r.bottom + 2 };
					}}><Icon name="filter" size={15} /></button
				>
			{/if}
			<select
				aria-label={t('output.channel')}
				title={t('output.channel')}
				value={output.active}
				onchange={(e) => (output.active = e.currentTarget.value)}
				class="h-[22px] max-w-56 rounded-sm border border-(--vscode-dropdown-border,transparent) bg-(--vscode-dropdown-background) px-1 text-xs text-(--vscode-dropdown-foreground) outline-none focus:border-(--vscode-focusBorder)"
			>
				{#each output.channels as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
			</select>
			<button aria-label={t('output.clear')} title={t('output.clear')} class="grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => output.clear()}>
				<Icon name="clearAll" size={15} />
			</button>
			<button
				aria-label={output.locked ? t('output.unlockScroll') : t('output.lockScroll')}
				aria-pressed={output.locked}
				title={output.locked ? t('output.unlockScroll') : t('output.lockScroll')}
				class={['grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)', output.locked && 'bg-(--vscode-inputOption-activeBackground) outline outline-(--vscode-inputOption-activeBorder)']}
				onclick={() => (output.locked = !output.locked)}
			>
				<Icon name="arrowDown" size={15} />
			</button>
			<button aria-label={t('output.openInEditor')} title={t('output.openInEditor')} class="grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => output.openInEditor()}>
				<Icon name="openExternal" size={15} />
			</button>
		{:else if layout.panelTab === 'problems'}
			<!-- VS Code's Problems view title: the filter box (Showing X of Y, More Filters…), tree/table, collapse all. -->
			<div data-problems-filter class="flex h-[22px] w-72 min-w-0 items-center rounded-sm border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) focus-within:border-(--vscode-focusBorder)">
				<input
					bind:this={problemsFilterInput}
					type="text"
					aria-label={t('problems.filterLabel')}
					placeholder={t('problems.filter')}
					bind:value={problemsView.text}
					onkeydown={(e) => problemsView.filterKeydown(e)}
					class="h-full min-w-0 flex-1 bg-transparent px-1.5 text-xs text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground)"
				/>
				{#if problemsView.filtering}
					<span class="mr-1 shrink-0 rounded-sm bg-(--vscode-badge-background) px-1 text-[11px] leading-4 whitespace-nowrap text-(--vscode-badge-foreground)">{t('problems.showing', { shown: problemsView.result.shown, total: problemsView.result.total })}</span>
				{/if}
				<button
					aria-label={t('problems.moreFilters')}
					title={t('problems.moreFilters')}
					aria-pressed={moreFiltersOn}
					class={['mr-0.5 grid size-5 shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)', moreFiltersOn && 'bg-(--vscode-inputOption-activeBackground) text-(--vscode-inputOption-activeForeground)']}
					onclick={(e) => {
						const r = e.currentTarget.getBoundingClientRect();
						filterMenu = { x: r.left, y: r.bottom + 2 };
					}}
				>
					<Icon name="sliders" size={14} />
				</button>
			</div>
			<button
				aria-label={problemsView.mode === 'tree' ? t('problems.viewAsTable') : t('problems.viewAsTree')}
				title={problemsView.mode === 'tree' ? t('problems.viewAsTable') : t('problems.viewAsTree')}
				class="grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)"
				onclick={() => (problemsView.mode = problemsView.mode === 'tree' ? 'table' : 'tree')}
			>
				<Icon name={problemsView.mode === 'tree' ? 'rows' : 'listChecks'} size={15} />
			</button>
			{#if problemsView.mode === 'tree'}
				<button aria-label={t('problems.collapseAll')} title={t('problems.collapseAll')} class="grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => problemsView.collapseAll()}>
					<Icon name="collapseAll" size={15} />
				</button>
			{/if}
		{:else if layout.panelTab === 'terminal'}
			<button aria-label="New Terminal" title="New Terminal" class="grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => terminals.open()}>
				<Icon name="plus" size={16} />
			</button>
			<button aria-label="Split Terminal" title="Split Terminal ({splitKey})" class="grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => terminals.split()}>
				<Icon name="layout" size={15} />
			</button>
			<button aria-label="Kill Terminal" title="Kill Terminal" class="grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => terminals.kill(terminals.active)}>
				<Icon name="trash" size={15} />
			</button>
		{/if}
		<button
			aria-label={maximized ? t('panel.restore') : t('panel.maximize')}
			title={maximized ? t('panel.restore') : t('panel.maximize')}
			class="grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)"
			onclick={toggleMaximize}
		>
			<Icon name={maximized ? 'chevronDown' : 'chevronUp'} size={16} />
		</button>
		<button aria-label={t('panel.hide')} title={t('panel.hide')} class="grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => (layout.panelVisible = false)}>
			<Icon name="close" size={14} />
		</button>
	</div>
	<div class="relative min-h-0 flex-1">
		<!-- The terminal stays mounted so its shell survives tab switches, like VS Code's pty host. -->
		<div class={['absolute inset-0 flex bg-(--vscode-terminal-background)', layout.panelTab !== 'terminal' && 'invisible']}>
			<!-- Each folder has its own terminals; another folder's keep running in the background. -->
			{#if terminals.tag}
				{#key terminals.tag}
					<div class="relative min-w-0 flex-1">
						<!-- VS Code's terminal groups: the active terminal's group shows, split side by side. -->
						{#each terminals.groups as group, g (leaves(group)[0])}
							<div class={['absolute inset-0', g !== activeGroup && 'invisible']}>
								<PaneSplitView tree={group} onresize={(path, ratio) => terminals.resize(g, path, ratio)}>
									{#snippet pane(id)}
										{@const t = terminals.get(Number(id))}
										{#if t}
											<Terminal
												key={terminals.key(t.id)}
												run={t.run}
												task={t.task}
												cwdFrom={t.cwdFrom}
												flavor="ide"
												keyLabels={{ split: splitKey }}
												onfocus={() => (terminals.active = t.id)}
												onaction={(a) => terminalAction(t.id, a)}
												onopenfile={openFile}
											/>
										{/if}
									{/snippet}
								</PaneSplitView>
							</div>
						{/each}
					</div>
				{/key}
			{/if}
			{#if tabsShown}
				<!-- VS Code's terminal tabs list (by default on the right once there is more than one); a split group is drawn with tree lines. -->
				<ul aria-label="Terminals" class={['w-44 shrink-0 overflow-y-auto border-(--vscode-panel-border) py-1 text-[13px]', tabsLeft ? '-order-1 border-r' : 'border-l']}>
					{#each terminals.groups as group (leaves(group)[0])}
						{@const ids = leaves(group).map(Number)}
						{#each ids as id, i (id)}
							{@const t = terminals.get(id)}
							{#if t}
								<li>
									<button
										class={['group flex h-[22px] w-full items-center gap-1.5 px-2 text-left', t.id === terminals.active ? 'bg-(--vscode-list-inactiveSelectionBackground)' : 'hover:bg-(--vscode-list-hoverBackground)']}
										onclick={() => ((terminals.active = t.id), !focusOnDoubleClick && focusTerminal(terminals.key(t.id)))}
										ondblclick={() => (focusOnDoubleClick ? focusTerminal(terminals.key(t.id)) : terminals.rename(t.id))}
									>
										{#if ids.length > 1}<span class="w-2 shrink-0 font-mono text-(--vscode-descriptionForeground)" aria-hidden="true">{i === 0 ? '┌' : i === ids.length - 1 ? '└' : '├'}</span>{/if}
										<Icon name="terminal" size={14} />
										<span class="min-w-0 flex-1 truncate" title={t.run?.join(' ') ?? t.title}>{t.title}</span>
										<span
											role="button"
											tabindex="-1"
											aria-label="Kill {t.title}"
											class="invisible grid size-4 place-items-center rounded group-hover:visible hover:bg-(--vscode-toolbar-hoverBackground)"
											onclick={(e) => (e.stopPropagation(), void terminals.kill(t.id))}
											onkeydown={() => {}}><Icon name="close" size={12} /></span
										>
									</button>
								</li>
							{/if}
						{/each}
					{/each}
				</ul>
			{/if}
		</div>
		{#if layout.panelTab === 'problems'}
			<div class="absolute inset-0"><ProblemsView /></div>
		{:else if layout.panelTab === 'debugConsole'}
			<div class="absolute inset-0"><DebugConsole /></div>
		{:else if layout.panelTab === 'output'}
			<!-- The active Output channel (Tasks, Git, Kingu, each language server). -->
			<OutputView />
		{/if}
	</div>
</section>
{#if levelMenu}
	<PopupMenu items={levelItems} label={t('output.logLevel.filter')} x={levelMenu.x} y={levelMenu.y} onRun={runLevel} onClose={() => (levelMenu = null)} />
{/if}
{#if filterMenu}
	<PopupMenu items={filterItems} label={t('problems.moreFilters')} x={filterMenu.x} y={filterMenu.y} onRun={runFilter} onClose={() => (filterMenu = null)} />
{/if}
