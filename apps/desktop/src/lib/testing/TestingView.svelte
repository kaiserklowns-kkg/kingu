<script lang="ts">
	// The Testing view (VS Code's Test Explorer): the tests of every project as a tree (runner and
	// project, file, suite, test) with each one's last result, Run and Debug on every row, the
	// failure messages under a failed test, a filter, and the run toolbar.
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import PopupMenu, { menuItem } from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { commands, keyOf } from '#lib/workbench/commands.svelte.ts';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { keyLabel } from '#lib/workbench/keys.ts';
	import { t } from '#lib/i18n/index.ts';
	import { testing } from './testing.svelte.ts';
	import type { TestItem, TestState } from './model.ts';

	$effect(() => void testing.ensureLoaded());

	let collapsed = $state<Record<string, boolean>>({});
	let filter = $state('');
	let menu = $state<{ x: number; y: number; items: MenuNode[]; item: TestItem } | null>(null);
	let scroller: HTMLDivElement | undefined = $state();

	type Row = { item: TestItem; depth: number; open: boolean };
	const rows = $derived.by(() => {
		const out: Row[] = [];
		const q = filter.trim().toLowerCase();
		const matches = (i: TestItem): boolean => !q || i.label.toLowerCase().includes(q) || i.children.some(matches);
		const visit = (items: TestItem[], depth: number) => {
			for (const item of items) {
				if (!matches(item)) continue;
				// Files and below start expanded; a filter opens everything it matches.
				const open = q ? true : !(collapsed[item.id] ?? false);
				out.push({ item, depth, open });
				if (open && item.children.length) visit(item.children, depth + 1);
			}
		};
		visit(testing.items, 0);
		return out;
	});

	// testing.followRunningTest: the test whose state changed is opened and scrolled to.
	$effect(() => {
		const id = testing.revealId;
		if (!id) return;
		for (const a of testing.ancestorsOf(id)) collapsed[a.id] = false;
		queueMicrotask(() => scroller?.querySelector(`[data-test-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' }));
	});

	const ICONS: Record<TestState, { icon: IconName; color: string; spin?: boolean }> = {
		unset: { icon: 'circleDashed', color: 'text-(--vscode-testing-iconUnset,var(--vscode-descriptionForeground))' },
		queued: { icon: 'clock', color: 'text-(--vscode-testing-iconQueued,#cca700)' },
		running: { icon: 'sync', color: 'text-(--vscode-testing-iconQueued,#cca700)', spin: true },
		passed: { icon: 'checkCircle', color: 'text-(--vscode-testing-iconPassed,#73c991)' },
		failed: { icon: 'error', color: 'text-(--vscode-testing-iconFailed,#f14c4c)' },
		errored: { icon: 'error', color: 'text-(--vscode-testing-iconErrored,#f14c4c)' },
		skipped: { icon: 'minus', color: 'text-(--vscode-testing-iconSkipped,#848484)' }
	};

	const titled = (label: string, id: string) => {
		const cmd = commands.get(id);
		const key = cmd && keyOf(cmd);
		return key ? `${label} (${keyLabel(key)})` : label;
	};

	function open(item: TestItem) {
		if (item.rel) editors.openAt(item.rel, item.line ?? 1);
	}

	function contextMenu(e: MouseEvent, item: TestItem) {
		e.preventDefault();
		const state = testing.stateOf(item);
		const items = [
			menuItem('run', t('testing.menu.run')),
			menuItem('debug', t('testing.menu.debug'), { enabled: item.runner !== 'bun' && item.kind !== 'project' }),
			menuItem('goto', t('testing.menu.goto'), { enabled: !!item.rel }),
			...(state === 'failed' || state === 'errored' ? [menuItem('peek', t('testing.menu.peek'))] : [])
		];
		menu = { x: e.clientX, y: e.clientY, items, item };
	}

	const duration = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
	const ROW = 'group/row flex h-(--kg-row-height) items-center gap-1 pr-2 leading-(--kg-row-height) hover:bg-(--vscode-list-hoverBackground)';
	const ICON_BUTTON = 'grid size-5 shrink-0 place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
</script>

<section class="flex min-h-0 flex-1 flex-col">
	<div class="flex shrink-0 items-center gap-0.5 px-2 pb-1">
		<button aria-label="Run All Tests" title={titled('Run All Tests', 'testing.runAll')} class={ICON_BUTTON} disabled={testing.running || !testing.items.length} onclick={() => testing.runAll()}><Icon name="play" size={15} /></button>
		<button aria-label="Rerun Failed Tests" title={titled('Rerun Failed Tests', 'testing.reRunFailTests')} class={ICON_BUTTON} disabled={testing.running || !testing.totals.failed} onclick={() => testing.reRunFailed()}><Icon name="refresh" size={14} /></button>
		{#if testing.running}
			<button aria-label="Cancel Test Run" title={titled('Cancel Test Run', 'testing.cancelRun')} class={ICON_BUTTON} onclick={() => testing.cancel()}><Icon name="stop" size={14} /></button>
		{/if}
		<button aria-label="Refresh Tests" title={titled('Refresh Tests', 'testing.refreshTests')} class={ICON_BUTTON} disabled={testing.discovering} onclick={() => testing.refresh(true)}><Icon name="sync" size={14} /></button>
		<button aria-label="Show Output" title={titled('Show Output', 'testing.showMostRecentOutput')} class={ICON_BUTTON} onclick={() => testing.showOutput()}><Icon name="terminal" size={14} /></button>
		<button aria-label="Clear All Results" title="Clear All Results" class={ICON_BUTTON} disabled={!testing.results.size} onclick={() => testing.clearResults()}><Icon name="clearAll" size={14} /></button>
		<button aria-label="Collapse All" title="Collapse All" class={ICON_BUTTON} onclick={() => (collapsed = Object.fromEntries(testing.items.map((i) => [i.id, true])))}><Icon name="collapseAll" size={14} /></button>
	</div>
	<div class="shrink-0 px-2 pb-1.5">
		<input
			aria-label={t('testing.filter')}
			placeholder={t('testing.filterPlaceholder')}
			bind:value={filter}
			class="block h-[24px] w-full rounded-sm border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) px-1.5 text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
		/>
	</div>
	{#if testing.totals.total}
		<p class="shrink-0 truncate px-3 pb-1 text-xs text-(--vscode-descriptionForeground)">
			{t('testing.summary', { passed: testing.totals.passed, failed: testing.totals.failed, skipped: testing.totals.skipped })}
		</p>
	{/if}
	<div bind:this={scroller} class="min-h-0 flex-1 overflow-y-auto" role="tree" aria-label="Test Explorer">
		{#if !testing.items.length}
			<p class="px-4 py-2 text-(--vscode-descriptionForeground)">{testing.discovering ? t('testing.discovering') : t('testing.none')}</p>
		{/if}
		{#each rows as row (row.item.id)}
			{@const item = row.item}
			{@const state = testing.stateOf(item)}
			{@const icon = ICONS[state]}
			{@const result = testing.results.get(item.id)}
			<div
				class={ROW}
				style:padding-left="{row.depth * 12 + 4}px"
				role="treeitem"
				aria-selected="false"
				aria-expanded={item.children.length ? row.open : undefined}
				tabindex="-1"
				data-test-id={item.id}
				title={item.rel ? `${item.rel}${item.line ? `:${item.line}` : ''}` : item.label}
				oncontextmenu={(e) => contextMenu(e, item)}
			>
				{#if item.children.length}
					<button aria-label={row.open ? 'Collapse' : 'Expand'} class="grid size-4 shrink-0 place-items-center" onclick={() => (collapsed[item.id] = row.open)}>
						<Icon name={row.open ? 'chevronDown' : 'chevronRight'} size={14} />
					</button>
				{:else}
					<span class="w-4 shrink-0"></span>
				{/if}
				<span class={['grid size-4 shrink-0 place-items-center', icon.color, icon.spin && 'animate-spin']} title={t(`testing.state.${state}`)}><Icon name={icon.icon} size={13} /></span>
				<button class="min-w-0 flex-1 truncate text-left" ondblclick={() => open(item)} onclick={() => item.kind !== 'project' && item.kind !== 'file' && open(item)}>{item.label}</button>
				{#if result?.duration !== undefined && item.kind === 'test'}<span class="shrink-0 text-xs text-(--vscode-descriptionForeground)">{duration(result.duration)}</span>{/if}
				<span class="hidden shrink-0 items-center gap-0.5 group-hover/row:flex">
					<button aria-label={t('testing.menu.run')} title={t('testing.menu.run')} class={ICON_BUTTON} disabled={testing.running} onclick={() => testing.run([item])}><Icon name="play" size={13} /></button>
					{#if item.runner !== 'bun' && item.kind !== 'project'}
						<button aria-label={t('testing.menu.debug')} title={t('testing.menu.debug')} class={ICON_BUTTON} disabled={testing.running} onclick={() => testing.run([item], { debug: true })}><Icon name="bug" size={13} /></button>
					{/if}
					{#if item.rel}
						<button aria-label={t('testing.menu.goto')} title={t('testing.menu.goto')} class={ICON_BUTTON} onclick={() => open(item)}><Icon name="goToFile" size={13} /></button>
					{/if}
				</span>
			</div>
			{#if (state === 'failed' || state === 'errored') && result?.messages.length && row.open}
				{#each result.messages as m, i (i)}
					<button
						class="flex w-full items-start gap-1 py-0.5 pr-2 text-left font-mono text-xs text-(--vscode-errorForeground) hover:bg-(--vscode-list-hoverBackground)"
						style:padding-left="{row.depth * 12 + 40}px"
						title={m.message}
						onclick={() => testing.openPeek(item.id, i)}
					>
						<span class="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap">{m.message}</span>
						{#if m.location}<span class="shrink-0 text-(--vscode-descriptionForeground)">{m.location.rel.slice(m.location.rel.lastIndexOf('/') + 1)}:{m.location.line}</span>{/if}
					</button>
				{/each}
			{/if}
		{/each}
	</div>
</section>

{#if menu}
	{@const current = menu}
	<PopupMenu
		items={current.items}
		label="Test"
		x={current.x}
		y={current.y}
		onRun={(node) => {
			if (node.type !== 'item') return;
			if (node.id === 'run') void testing.run([current.item]);
			else if (node.id === 'debug') void testing.run([current.item], { debug: true });
			else if (node.id === 'goto') open(current.item);
			else if (node.id === 'peek') testing.openPeek(current.item.id);
		}}
		onClose={() => (menu = null)}
	/>
{/if}
