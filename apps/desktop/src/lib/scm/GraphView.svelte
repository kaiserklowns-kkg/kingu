<script lang="ts">
	// The Source Control Graph section under the Source Control view (VS Code's SCMHistoryViewPane):
	// the active repository's commits with their lanes, branch and tag labels and the Incoming /
	// Outgoing Changes rows. A click expands a commit's files (a file opens its diff), a double click
	// opens all its changes on one page; the context menu has VS Code's commit actions. The title
	// picks the repository (several), every branch or only HEAD's, and runs Fetch, Pull, Push and
	// Refresh. `scm.graph.pageOnScroll` loads the next page at the end of the list, else "Load More".
	import { t } from '#lib/i18n/index.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import FileIcon from '#lib/workbench/FileIcon.svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { fileIcon } from '#lib/workbench/fileIcons.ts';
	import { decoration, splitPath } from '#lib/workbench/scm.ts';
	import { scm } from '#lib/workbench/scm.svelte.ts';
	import { graphWidth, type GraphRow } from './graph';
	import { copyCommitId, copyCommitMessage, graph, isVirtual, type ChangedFile } from './graph.svelte';

	const ROW = 22;
	const LANE = 11;
	const x = (i: number) => LANE * i + LANE / 2 + 1;
	const COLORS = [
		'var(--vscode-scmGraph-foreground1, #FFB000)',
		'var(--vscode-scmGraph-foreground2, #DC267F)',
		'var(--vscode-scmGraph-foreground3, #994F00)',
		'var(--vscode-scmGraph-foreground4, #40B0A6)',
		'var(--vscode-scmGraph-foreground5, #B66DFF)'
	];
	const REF_COLOR = 'var(--vscode-scmGraph-historyItemRefColor, #3794FF)';
	const REMOTE_COLOR = 'var(--vscode-scmGraph-historyItemRemoteRefColor, #B180D7)';
	const lane = (n: number) => COLORS[n % COLORS.length];
	/** The circle's color: HEAD's side blue and the upstream's purple, as VS Code colors the refs. */
	const dot = (row: GraphRow) => (row.side === 'outgoing' || row.head ? REF_COLOR : row.side === 'incoming' ? REMOTE_COLOR : lane(row.color));

	const width = $derived(Math.max(1, graphWidth(graph.rows)) * LANE + 2);
	const repoName = $derived(scm.repositories.length > 1 ? (graph.repository?.label.name ?? '') : '');

	let selected = $state<string | null>(null);
	let menu = $state<{ x: number; y: number; row: GraphRow } | null>(null);

	/** A line from (x1, y1) to (x2, y2), bending between lanes. */
	function path(x1: number, y1: number, x2: number, y2: number) {
		if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
		const mid = (y1 + y2) / 2;
		return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
	}

	function itemMenu(row: GraphRow): MenuNode[] {
		const open = menuItem('open', t('scmGraph.openChanges'));
		if (isVirtual(row)) return [open];
		const page = graph.page;
		return [
			open,
			menuSeparator,
			menuItem('checkout', t('scmGraph.checkoutDetached')),
			menuItem('branch', t('scmGraph.createBranch')),
			menuItem('tag', t('scmGraph.createTag')),
			menuItem('cherryPick', t('scmGraph.cherryPick'), { enabled: !row.head }),
			menuSeparator,
			menuItem('compare', t('scmGraph.compareWith')),
			menuItem('compareRemote', t('scmGraph.compareWithRemote'), { enabled: !!page?.upstream }),
			menuItem('compareBase', t('scmGraph.compareWithMergeBase'), { enabled: !!page?.merge_base }),
			menuSeparator,
			menuItem('copyId', t('scmGraph.copyCommitId')),
			menuItem('copyMessage', t('scmGraph.copyCommitMessage'))
		];
	}

	function runMenu(id: string, row: GraphRow) {
		if (id === 'open') graph.openChanges(row);
		else if (id === 'checkout') graph.checkout(row);
		else if (id === 'branch') graph.createBranch(row);
		else if (id === 'tag') graph.createTag(row);
		else if (id === 'cherryPick') graph.cherryPick(row);
		else if (id === 'compare') void graph.compareWith(row);
		else if (id === 'compareRemote') graph.compareWithRemote(row);
		else if (id === 'compareBase') graph.compareWithMergeBase(row);
		else if (id === 'copyId') void copyCommitId(row.commit);
		else if (id === 'copyMessage') void copyCommitMessage(row.commit);
	}

	async function pickRepository() {
		const r = await scm.pick();
		if (r) graph.picked = r.dir;
	}

	function onScroll(e: Event) {
		const el = e.currentTarget as HTMLElement;
		if (settings.get<boolean>('scm.graph.pageOnScroll') && el.scrollTop + el.clientHeight >= el.scrollHeight - 8) void graph.loadMore();
	}

	const fileLetter = (f: ChangedFile) => decoration(f.status);
	const titleActions = $derived([
		{ icon: 'filter' as const, label: graph.all ? t('scmGraph.showCurrent') : t('scmGraph.showAll'), run: () => (graph.all = !graph.all), pressed: graph.all },
		{ icon: 'sync' as const, label: t('scmGraph.fetch'), run: () => graph.repository?.fetch(), hidden: !graph.repository?.repo?.remotes.length },
		{ icon: 'arrowDown' as const, label: t('scmGraph.pull'), run: () => graph.repository?.pull(), hidden: !graph.repository?.repo?.upstream },
		{ icon: 'arrowUp' as const, label: t('scmGraph.push'), run: () => graph.repository?.push(), hidden: !graph.repository?.repo?.branch },
		{ icon: 'refresh' as const, label: t('scmGraph.refresh'), run: () => graph.refresh(true) }
	]);
</script>

{#snippet lanes(row: GraphRow)}
	<svg class="shrink-0" {width} height={ROW} aria-hidden="true">
		{#each row.through as l, i (i)}
			<path d={path(x(l.from), 0, x(l.to), ROW)} stroke={lane(l.color)} stroke-width="1.5" fill="none" />
		{/each}
		{#each row.joins as j, i (i)}
			<path d={path(x(j.from), 0, x(row.column), ROW / 2)} stroke={lane(j.color)} stroke-width="1.5" fill="none" />
		{/each}
		{#each row.parents as p, i (i)}
			<path d={path(x(row.column), ROW / 2, x(p.to), ROW)} stroke={lane(p.color)} stroke-width="1.5" fill="none" />
		{/each}
		{#if isVirtual(row)}
			<circle cx={x(row.column)} cy={ROW / 2} r="4" fill="var(--vscode-sideBar-background)" stroke={dot(row)} stroke-width="1.5" stroke-dasharray="2 1.5" />
		{:else if row.head}
			<circle cx={x(row.column)} cy={ROW / 2} r="5" fill="var(--vscode-sideBar-background)" stroke={dot(row)} stroke-width="2" />
			<circle cx={x(row.column)} cy={ROW / 2} r="2" fill={dot(row)} />
		{:else if row.commit.parents.length > 1}
			<circle cx={x(row.column)} cy={ROW / 2} r="4" fill="var(--vscode-sideBar-background)" stroke={dot(row)} stroke-width="1.5" />
			<circle cx={x(row.column)} cy={ROW / 2} r="1.5" fill={dot(row)} />
		{:else}
			<circle cx={x(row.column)} cy={ROW / 2} r="4" fill={dot(row)} />
		{/if}
	</svg>
{/snippet}

{#snippet continuation(row: GraphRow)}
	<!-- The lanes going on below an expanded commit, past its files. -->
	<svg class="shrink-0" {width} height={ROW} aria-hidden="true">
		{#each row.lanesOut as l, i (i)}
			<path d={path(x(i), 0, x(i), ROW)} stroke={lane(l.color)} stroke-width="1.5" fill="none" />
		{/each}
	</svg>
{/snippet}

<section class={['flex min-h-0 flex-col border-t border-(--vscode-sideBarSectionHeader-border,transparent)', graph.open ? 'h-[40%] shrink-0' : 'shrink-0']}>
	<div class="group flex h-(--kg-row-height) shrink-0 items-center pr-1">
		<button
			class="flex h-full min-w-0 flex-1 items-center gap-0.5 px-0.5 text-[11px] font-bold uppercase text-(--vscode-sideBarTitle-foreground)"
			aria-expanded={graph.open}
			onclick={() => (graph.open = !graph.open)}
		>
			<Icon name={graph.open ? 'chevronDown' : 'chevronRight'} size={16} />
			<span class="truncate">{t('scmGraph.title')}</span>
		</button>
		{#if graph.open}
			{#if repoName}
				<button
					class="flex max-w-[45%] shrink-0 items-center gap-0.5 truncate rounded px-1 text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground)"
					title={t('scmGraph.pickRepository')}
					onclick={pickRepository}><Icon name="git" size={14} /><span class="truncate">{repoName}</span></button
				>
			{/if}
			{#each titleActions as a (a.label)}
				{#if !a.hidden}
					<button
						class={[
							'kg-view-actions grid size-[22px] place-items-center rounded text-(--vscode-icon-foreground) opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-(--vscode-toolbar-hoverBackground)',
							a.pressed && 'bg-(--vscode-inputOption-activeBackground) opacity-100'
						]}
						aria-label={a.label}
						aria-pressed={a.pressed}
						title={a.label}
						disabled={!!scm.op && a.icon !== 'refresh' && a.icon !== 'filter'}
						onclick={() => void a.run()}><Icon name={a.icon} size={16} /></button
					>
				{/if}
			{/each}
		{/if}
	</div>
	{#if graph.open}
		<div class="min-h-0 flex-1 overflow-y-auto" role="tree" aria-label={t('scmGraph.title')} onscroll={onScroll}>
			{#if !graph.repository?.repo}
				<p class="px-5 py-1 text-(--vscode-descriptionForeground)">{t('scmGraph.noRepository')}</p>
			{:else if graph.error}
				<p class="px-5 py-1 text-(--vscode-errorForeground)">{graph.error}</p>
			{:else if !graph.rows.length}
				<p class="px-5 py-1 text-(--vscode-descriptionForeground)">{graph.loading ? t('scmGraph.loading') : t('scmGraph.empty')}</p>
			{:else}
				{#each graph.rows as row (row.commit.hash)}
					{@const c = row.commit}
					{@const files = graph.expanded[c.hash]}
					{@const open = c.hash in graph.expanded}
					<button
						class={[
							'flex h-[22px] w-full min-w-0 items-center gap-1 pr-2 pl-1 text-left',
							selected === c.hash ? 'bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)' : 'hover:bg-(--vscode-list-hoverBackground)'
						]}
						role="treeitem"
						aria-expanded={open}
						aria-selected={selected === c.hash}
						title={graph.hover(row)}
						onclick={() => ((selected = c.hash), void graph.toggle(row))}
						ondblclick={() => graph.openChanges(row)}
						oncontextmenu={(e) => {
							e.preventDefault();
							selected = c.hash;
							menu = { x: e.clientX, y: e.clientY, row };
						}}
					>
						{@render lanes(row)}
						<span class={['min-w-0 shrink truncate', isVirtual(row) && 'italic']}>{c.subject}</span>
						{#each graph.badges(row) as b (b.kind + b.name)}
							<span
								class="flex max-w-28 shrink-0 items-center gap-0.5 truncate rounded-full px-1.5 text-[11px] leading-4"
								style:background={b.kind === 'tag' ? 'var(--vscode-badge-background)' : b.kind === 'remote' ? REMOTE_COLOR : REF_COLOR}
								style:color={b.kind === 'tag' ? 'var(--vscode-badge-foreground)' : 'white'}
								title={b.kind === 'tag' ? `tag: ${b.name}` : b.name}
							>
								<Icon name={b.kind === 'tag' ? 'pin' : b.kind === 'remote' ? 'publish' : 'branch'} size={10} /><span class="truncate">{b.name}</span>
							</span>
						{/each}
						<span class="min-w-0 flex-1 truncate text-[0.9em] text-(--vscode-descriptionForeground)">{isVirtual(row) ? '' : c.author}</span>
						{#if !isVirtual(row)}<span class="shrink-0 text-[0.9em] text-(--vscode-descriptionForeground)">{graph.when(c)}</span>{/if}
					</button>
					{#if open}
						{#if files === null}
							<div class="flex h-[22px] items-center gap-1 pl-1 text-(--vscode-descriptionForeground)">{@render continuation(row)}<span class="pl-4">{t('scmGraph.loading')}</span></div>
						{:else if files && !files.length}
							<div class="flex h-[22px] items-center gap-1 pl-1 text-(--vscode-descriptionForeground)">{@render continuation(row)}<span class="pl-4">{t('scmGraph.noFiles')}</span></div>
						{:else if files}
							{#each files as f (f.path)}
								{@const [name, dir] = splitPath(f.path)}
								{@const d = fileLetter(f)}
								<button
									class="flex h-[22px] w-full min-w-0 items-center gap-1.5 pr-2 pl-1 text-left hover:bg-(--vscode-list-hoverBackground)"
									role="treeitem"
									aria-selected="false"
									title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}
									onclick={() => graph.openFile(row, f)}
									ondblclick={() => graph.openFile(row, f, false)}
								>
									{@render continuation(row)}
									<span class="w-3 shrink-0"></span>
									<FileIcon icon={fileIcon(name)} />
									<span class={['shrink-0 truncate', f.status === 'D' && 'line-through']}>{name}</span>
									{#if dir}<span class="min-w-0 flex-1 truncate text-[0.9em] text-(--vscode-descriptionForeground)">{dir}</span>{:else}<span class="flex-1"></span>{/if}
									<span class="w-4 shrink-0 text-center text-xs font-semibold" style:color={d.color}>{d.letter}</span>
								</button>
							{/each}
						{/if}
					{/if}
				{/each}
				{#if graph.more && !settings.get<boolean>('scm.graph.pageOnScroll')}
					<button class="w-full px-4 py-1 text-left text-(--vscode-textLink-foreground) hover:underline" onclick={() => graph.loadMore()}>{t('scmGraph.loadMore')}</button>
				{:else if graph.loading && graph.rows.length}
					<p class="px-4 py-1 text-(--vscode-descriptionForeground)">{t('scmGraph.loading')}</p>
				{/if}
			{/if}
		</div>
	{/if}
</section>

{#if menu}
	{@const row = menu.row}
	<PopupMenu
		items={itemMenu(row)}
		label={t('scmGraph.title')}
		x={menu.x}
		y={menu.y}
		onRun={(node) => {
			if (node.type === 'item') runMenu(node.id, row);
		}}
		onClose={() => (menu = null)}
	/>
{/if}
