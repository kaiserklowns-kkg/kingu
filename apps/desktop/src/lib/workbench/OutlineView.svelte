<script lang="ts">
	// The Outline section of the Explorer (VS Code: contrib/outline/browser/outlinePane.ts): the
	// active editor's document symbols as a tree, following the cursor, filtered as you type,
	// sorted by position, name or category, with problem badges (outline.* settings).
	import { tick } from 'svelte';
	import { lsp } from '#lib/lsp/lsp.svelte.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import Icon from './Icon.svelte';
	import { editors } from './editors.svelte';
	import { outline } from './outline.svelte';
	import { providesOutline } from './editorKind.ts';
	import { symbolCodicon } from './breadcrumbs';
	import { applyMarkers, enclosingPath, filterKinds, filterText, outlineRows, outlineTree, parentIds, sortOutline, type OutlineRow } from './outlineModel';

	const get = <T,>(id: string) => settings.get<T>(id);
	// Editors without a symbol provider (the Search Editor, Output, Settings…) show "cannot provide".
	const rel = $derived(providesOutline(editors.active) ? editors.active : null);
	const name = $derived(rel?.split('/').pop() ?? '');
	const icons = $derived(settings.get<boolean>('outline.icons'));
	const expandByDefault = $derived(settings.get<string>('outline.collapseItems') !== 'alwaysCollapse');
	// outline.problems.*: overwritten by problems.visibility when it is off.
	const problemsOn = $derived(settings.get<boolean>('problems.visibility') !== false && settings.get<boolean>('outline.problems.enabled'));
	const problemColors = $derived(problemsOn && settings.get<boolean>('outline.problems.colors'));
	const problemBadges = $derived(problemsOn && settings.get<boolean>('outline.problems.badges'));

	let query = $state('');
	let selected = $state<string | null>(null);
	let menu = $state<{ x: number; y: number } | null>(null);
	let tree = $state<HTMLElement>();
	let filterBox = $state<HTMLInputElement>();

	const items = $derived.by(() => {
		let list = sortOutline(filterKinds(outlineTree(outline.symbolsOf(rel)), get), outline.sortBy);
		if (problemsOn && rel) {
			const diags = lsp.problems.find((f) => f.rel === rel)?.items ?? [];
			list = applyMarkers(list, diags.map((d) => ({ ...d.range, severity: d.severity ?? 1 })));
		}
		return list;
	});
	const filtered = $derived(filterText(items, query));
	const rows = $derived(outlineRows(filtered.items, (id) => !!rel && outline.isExpanded(rel, id, expandByDefault), query.trim() !== ''));
	// Follow Cursor: the element around the cursor (VS Code selects and reveals it).
	const active = $derived(outline.followCursor ? enclosingPath(items, { line: editors.cursor.line - 1, character: editors.cursor.column - 1 }) : []);
	const activeId = $derived(active.at(-1)?.id ?? null);

	$effect(() => {
		const path = active;
		const file = rel;
		if (!outline.followCursor || !file || !path.length || !outline.open) return;
		// Expand the ancestors, then scroll the element into view.
		const ancestors = path.slice(0, -1).map((i) => i.id).filter((id) => !outline.isExpanded(file, id, expandByDefault));
		if (ancestors.length) outline.setExpanded(file, ancestors, true, expandByDefault);
		const id = path.at(-1)!.id;
		void tick().then(() => tree?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' }));
	});

	// A new file clears the filter, like the tree's find widget.
	$effect(() => {
		void rel;
		query = '';
		selected = null;
	});

	function reveal(row: OutlineRow, focus: boolean) {
		selected = row.item.id;
		const at = row.item.selectionRange.start;
		if (focus) editors.gotoLine(at.line + 1, at.character + 1);
		else editors.peek(at.line + 1, at.character + 1);
	}

	function toggle(row: OutlineRow) {
		if (rel && row.hasChildren) outline.toggle(rel, row.item.id);
	}

	function collapseAll() {
		if (rel) outline.setExpanded(rel, parentIds(items), false, expandByDefault);
	}

	function onKey(e: KeyboardEvent) {
		const i = rows.findIndex((r) => r.item.id === selected);
		const row = rows[i];
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
			if (next) reveal(next, false);
		} else if (e.key === 'ArrowRight' && row?.hasChildren && !row.expanded) toggle(row);
		else if (e.key === 'ArrowLeft' && row?.expanded) toggle(row);
		else if (e.key === 'Enter' && row) reveal(row, true);
		else if (e.key === 'Escape' && query) query = '';
		else if (outline.filterOnType && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
			query += e.key;
			void tick().then(() => filterBox?.focus());
		} else return;
		e.preventDefault();
		e.stopPropagation();
		void tick().then(() => tree?.querySelector<HTMLElement>(`[data-id="${CSS.escape(selected ?? '')}"]`)?.scrollIntoView({ block: 'nearest' }));
	}

	const sevColor = (sev: number) => (sev === 1 ? 'var(--vscode-list-errorForeground, #F88070)' : 'var(--vscode-list-warningForeground, #CCA700)');
	const menuItems = $derived([
		{ label: t('language.outline.followCursor'), checked: outline.followCursor, run: () => (outline.followCursor = !outline.followCursor) },
		{ label: t('language.outline.filterOnType'), checked: outline.filterOnType, run: () => (outline.filterOnType = !outline.filterOnType) },
		'sep' as const,
		{ label: t('language.outline.sortByPosition'), checked: outline.sortBy === 'position', run: () => (outline.sortBy = 'position') },
		{ label: t('language.outline.sortByName'), checked: outline.sortBy === 'name', run: () => (outline.sortBy = 'name') },
		{ label: t('language.outline.sortByKind'), checked: outline.sortBy === 'kind', run: () => (outline.sortBy = 'kind') }
	]);
</script>

<svelte:window onkeydown={(e) => menu && e.key === 'Escape' && (menu = null)} onblur={() => (menu = null)} />

<section class={['flex min-h-0 flex-col border-t border-(--vscode-sideBarSectionHeader-border)', outline.open ? 'flex-1' : 'shrink-0']} aria-label={t('language.outline.title')} data-view="outline">
	<div class="group flex h-(--kg-row-height) shrink-0 items-center pr-1">
		<button
			class="flex h-full min-w-0 flex-1 items-center gap-0.5 px-0.5 text-[11px] font-bold uppercase text-(--vscode-sideBarTitle-foreground)"
			aria-expanded={outline.open}
			onclick={() => (outline.open = !outline.open)}
		>
			<Icon name={outline.open ? 'chevronDown' : 'chevronRight'} size={16} />
			<span class="truncate">{t('language.outline.title')}</span>
		</button>
		{#if outline.open}
			<div class="flex items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
				<button class="grid size-[22px] place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={t('language.outline.collapseAll')} title={t('language.outline.collapseAll')} onclick={collapseAll}>
					<Icon name="collapseAll" size={16} />
				</button>
				<button
					class="grid size-[22px] place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground)"
					aria-label={t('language.outline.more')}
					title={t('language.outline.more')}
					onclick={(e) => {
						const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
						menu = { x: r.left, y: r.bottom + 2 };
					}}
				>
					<Icon name="more" size={16} />
				</button>
			</div>
		{/if}
	</div>

	{#if outline.open}
		{#if query}
			<div class="flex shrink-0 items-center gap-1 px-2 pb-1">
				<input
					bind:this={filterBox}
					bind:value={query}
					aria-label={t('language.outline.filter')}
					placeholder={t('language.outline.filter')}
					spellcheck="false"
					class="h-[22px] min-w-0 flex-1 border border-(--vscode-focusBorder) bg-(--vscode-input-background) px-1 text-(--vscode-input-foreground) outline-none"
					onkeydown={(e) => {
						if (e.key === 'Escape') {
							query = '';
							tree?.focus();
						} else if (e.key === 'ArrowDown' || e.key === 'Enter') {
							tree?.focus();
							onKey(e);
						}
					}}
				/>
			</div>
		{/if}
		<div
			bind:this={tree}
			role="tree"
			tabindex="0"
			aria-label={t('language.outline.title')}
			class="min-h-0 flex-1 overflow-y-auto outline-none"
			onkeydown={onKey}
		>
			{#if !rel}
				<p class="px-5 py-1 text-(--vscode-descriptionForeground)">{t('language.outline.noEditor')}</p>
			{:else if !items.length}
				<p class="px-5 py-1 text-(--vscode-descriptionForeground)">{t('language.outline.noSymbols', { name })}</p>
			{:else if !rows.length}
				<p class="px-5 py-1 text-(--vscode-descriptionForeground)">{t('language.outline.noMatches')}</p>
			{/if}
			{#each rows as row (row.item.id)}
				{@const m = row.item.marker}
				<button
					role="treeitem"
					aria-selected={selected === row.item.id || activeId === row.item.id}
					aria-expanded={row.hasChildren ? row.expanded : undefined}
					data-id={row.item.id}
					class={[
						'mx-1.5 flex h-(--kg-row-height) w-[calc(100%-12px)] items-center gap-1 rounded-md pr-2 text-left',
						selected === row.item.id ? 'bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)' : activeId === row.item.id ? 'bg-(--vscode-list-inactiveSelectionBackground)' : 'hover:bg-(--vscode-list-hoverBackground)'
					]}
					style:padding-left="{8 + row.depth * 8}px"
					title={row.item.detail ? `${row.item.name} ${row.item.detail}` : row.item.name}
					onclick={(e) => {
						if ((e.target as HTMLElement).closest('[data-twistie]')) toggle(row);
						else reveal(row, false);
					}}
					ondblclick={() => reveal(row, true)}
				>
					<span class="flex w-4 shrink-0 justify-center text-(--vscode-icon-foreground)" data-twistie>
						{#if row.hasChildren}<Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} size={16} />{/if}
					</span>
					{#if icons}<span class={['codicon shrink-0', symbolCodicon(row.item.kind)]} aria-hidden="true"></span>{/if}
					<span class={['min-w-0 truncate', filtered.matches.has(row.item.id) && 'font-semibold text-(--vscode-list-highlightForeground)']} style:color={problemColors && m ? sevColor(m.topSev) : undefined}>{row.item.name}</span>
					{#if row.item.detail}<span class="min-w-0 flex-1 truncate text-xs opacity-70">{row.item.detail}</span>{:else}<span class="flex-1"></span>{/if}
					{#if problemBadges && m}
						{#if m.count > 0}
							<span class="shrink-0 pl-2 text-[11px]" style:color={problemColors ? sevColor(m.topSev) : undefined} title={t('language.outline.problems', { count: m.count })}>{m.count > 9 ? '9+' : m.count}</span>
						{:else}
							<span class="shrink-0 pl-2 text-[11px]" style:color={problemColors ? sevColor(m.topSev) : undefined} title={t('language.outline.childProblems')}>●</span>
						{/if}
					{/if}
				</button>
			{/each}
		</div>
	{/if}
</section>

{#if menu}
	{@const at = menu}
	<div class="fixed inset-0 z-40" role="presentation" onpointerdown={() => (menu = null)}></div>
	<div
		role="menu"
		aria-label={t('language.outline.more')}
		class="fixed z-50 min-w-[200px] rounded-md border border-[color:var(--vscode-menu-border,#454545)] bg-[var(--vscode-menu-background,#1F1F1F)] py-1 text-[color:var(--vscode-menu-foreground,#CCCCCC)] shadow-[0_2px_8px_rgba(0,0,0,0.36)]"
		style:left="{at.x}px"
		style:top="{at.y}px"
	>
		{#each menuItems as it, i (i)}
			{#if it === 'sep'}
				<div role="separator" class="mx-2 my-1 h-px bg-[var(--vscode-menu-separatorBackground,#454545)]"></div>
			{:else}
				<button
					role="menuitemcheckbox"
					aria-checked={it.checked}
					class="mx-1 flex h-6 w-[calc(100%-8px)] items-center gap-2 rounded px-2 text-left hover:bg-[var(--vscode-menu-selectionBackground,#0078D4)] hover:text-[color:var(--vscode-menu-selectionForeground,#FFFFFF)]"
					onclick={() => {
						menu = null;
						it.run();
					}}
				>
					<span class="w-4">{#if it.checked}<Icon name="check" size={14} />{/if}</span>
					<span>{it.label}</span>
				</button>
			{/if}
		{/each}
	</div>
{/if}
