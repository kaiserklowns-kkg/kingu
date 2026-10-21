<script lang="ts">
	import { onMount } from 'svelte';
	// System settings: one page for the IDE and the ADE, over the content area of either mode
	// (the title bar and status bar stay). Left, laid out like Orca's settings sidebar: Back, the
	// search, then the table of contents by section (AI Capabilities / System / IDE / ADE / Snaps)
	// and group, and Projects. Right: an Orca pane for the AI and ADE groups and the open folder's
	// project, the VS Code settings editor for the others, or a dedicated page. Back or Escape closes it.
	import Icon from '#lib/workbench/Icon.svelte';
	import SnapsView from '#lib/snaps/SnapsView.svelte';
	import AccountsView from '#lib/accounts/AccountsView.svelte';
	import { snaps } from '#lib/snaps/snaps.svelte.ts';
	import { settingsInView, SNAPS_SECTION_ID, subgroupsOf, tocKey } from './registry';
	import { COMMONLY_USED, COMMONLY_USED_ID, nodeGroups, tocChildren, VS_PREFIX, VSCODE_TOC } from './vscodeToc';
	import { AGENT_CATALOG_IDS, isPane, ORCA_NAV, ORCA_SECTION_IDS, PAGE_BADGES, PANES, PROJECT_GROUPS, PROJECT_PANE } from './panes';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { settingSchemas } from './schemas.svelte';
	import SettingsEditor from './SettingsEditor.svelte';
	import AgentCatalog from './pages/AgentCatalog.svelte';
	import OrcaPane from './OrcaPane.svelte';
	import { ORCA_PANES, PANE_SETTING_IDS, PROJECT, paneMatches } from './orcaPane';
	import ShortcutsPage from './pages/ShortcutsPage.svelte';
	import AboutPage from './pages/AboutPage.svelte';
	import ArkaiPage from './pages/ArkaiPage.svelte';
	import TerminalPage from './pages/TerminalPage.svelte';
	import AccountPage from './pages/AccountPage.svelte';
	import UsagePage from './pages/UsagePage.svelte';
	import McpPage from '#lib/mcp/McpPage.svelte';
	import SkillsPage from '#lib/skills/SkillsPage.svelte';
	import MemoriesPage from '#lib/agent/MemoriesPage.svelte';
	import VoicePage from './pages/VoicePage.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { settings } from './settings.svelte';
	import type { IconName } from '#lib/workbench/Icon.svelte';
	import type { SettingsPageId } from './systemSettings.svelte';

	// Dedicated pages (ORCA_NAV places them) and About at the bottom.
	const PAGES: { id: SettingsPageId; label: string; icon: IconName }[] = [
		{ id: 'appearance', label: 'Appearance', icon: 'layout' },
		{ id: 'arkai', label: 'Arkai', icon: 'agent' },
		{ id: 'terminal', label: 'Terminal', icon: 'terminal' },
		{ id: 'account', label: 'บัญชีและทีม', icon: 'account' },
		{
			id: 'accounts',
			get label() {
				return t('settings.page.aiAccounts');
			},
			icon: 'key'
		},
		{ id: 'usage', label: 'Stats & Usage', icon: 'usage' },
		{
			id: 'mcp',
			get label() {
				return t('mcp.title');
			},
			icon: 'sliders'
		},
		{
			id: 'skills',
			get label() {
				return t('skills.title');
			},
			icon: 'sparkle'
		},
		{
			id: 'memories',
			get label() {
				return t('chatExtras.memories.title');
			},
			icon: 'bookmark'
		},
		{
			id: 'voice',
			get label() {
				return t('voice.title');
			},
			icon: 'mic'
		},
		{
			id: 'shortcuts',
			get label() {
				return t('panes.shortcuts.title');
			},
			icon: 'keyboard'
		}
	];
	import { systemSettings } from './systemSettings.svelte';
	import type { SettingsSection } from './registry';

	const sectionLabel = (sec: SettingsSection | undefined) => (sec ? (sec.labelKey ? t(sec.labelKey) : sec.label) : '');

	let query = $state('');
	const searching = $derived(query.trim() !== '');
	const tocHidden = $derived(searching && settings.get<string>('workbench.settings.settingsSearchTocBehavior') === 'hide');
	const isModified = (id: string) => settings.inspect(id, 'user') !== undefined || settings.inspect(id, 'workspace') !== undefined;
	/** Settings per group: all of them, or while searching the ones that match (Orca lists only matching panes). */
	const counts = $derived.by(() => {
		const out = new Map<string, number>();
		for (const s of searching ? settingsInView(query, null, settingSchemas.all, isModified) : settingSchemas.all) out.set(s.group, (out.get(s.group) ?? 0) + 1);
		return out;
	});
	const shownGroup = (g: string) => (counts.get(g) ?? 0) > 0;
	/** Pages have no settings to search: while searching they show when their name matches. */
	const shownPage = (p: { label: string }) => !searching || (!query.trim().startsWith('@') && p.label.toLowerCase().includes(query.trim().toLowerCase()));
	const pageShown = (id: string) => PAGES.some((p) => p.id === id && shownPage(p));
	const pagesOf = (sec: SettingsSection) => (sec.pages ?? []).flatMap((id) => PAGES.filter((p) => p.id === id && shownPage(p)));

	const projectName = $derived(workspace.root?.split(/[\\/]/).filter(Boolean).pop() ?? '');
	const projectShown = $derived(!searching || PROJECT_GROUPS.some(shownGroup));

	/** The selection is a group or `Group/Sub-group` (VS Code's TOC: Text Editor › Cursor, Workbench › Breadcrumbs …). */
	const groupOf = (selection: string | null) => selection?.split('/')[0] ?? null;
	const subOf = (selection: string | null) => (selection?.includes('/') ? selection.slice(selection.indexOf('/') + 1) : null);
	const showSnaps = $derived(systemSettings.snaps);
	const page = $derived(systemSettings.page);
	const selected = $derived(page || showSnaps ? null : systemSettings.group);
	const paneGroup = $derived(isPane(groupOf(selected)) ? groupOf(selected) : null);
	const projectPane = $derived(selected === PROJECT_PANE && !!workspace.root);
	/** An Orca pane drawn from its spec: the selection `@pane:<id>`. */
	const PANE_PREFIX = '@pane:';
	/** The VS Code part: Commonly Used (its settings) or a node (its groups), else a group / sub-group. */
	const VSCODE_SECTION_IDS = new Set(['system', 'ide']);
	const vsNode = $derived(selected?.startsWith(VS_PREFIX) ? (VSCODE_TOC.find((n) => VS_PREFIX + n.id === selected) ?? null) : null);
	const commonlyUsed = $derived(selected === VS_PREFIX + COMMONLY_USED_ID);
	const orcaPane = $derived(selected?.startsWith(PANE_PREFIX) ? (ORCA_PANES[selected.slice(PANE_PREFIX.length)] ?? null) : null);
	const modifiedCount = $derived(settingSchemas.all.filter((s) => isModified(s.id)).length);
	/** The breadcrumb over the VS Code settings editor (Orca panes and pages carry their own title). */
	const crumbs = $derived.by(() => {
		if (showSnaps) return ['Snaps', t('settings.page.manageSnaps')];
		if (commonlyUsed) return ['VS Code', 'Commonly Used'];
		if (vsNode) return ['VS Code', vsNode.label];
		const group = groupOf(selected);
		if (!group) return [searching ? t('settings.page.searchResults') : t('settings.page.allIdeAde')];
		const sub = subOf(selected);
		return [sectionLabel(settingSchemas.sections.find((s) => s.groups.includes(group))), group, ...(sub && !searching ? [sub] : [])];
	});

	/** Picking an entry keeps the search: the content narrows to it, like Orca's settings search. */
	function select(group: string | null) {
		systemSettings.show(group);
	}

	function openPage(id: SettingsPageId) {
		systemSettings.showPage(id);
	}

	function search(next: string) {
		// Starting a search shows the results of every group; refining it keeps what was picked.
		if (!searching && next.trim() && (page || showSnaps || systemSettings.group)) select(null);
		query = next;
	}

	let searchInput = $state<HTMLInputElement>();
	let navList = $state<HTMLDivElement>();
	// Opening Settings starts the table of contents at the top (AI Capabilities first, like Orca);
	// without this it could open scrolled past the first items.
	onMount(() => {
		const id = requestAnimationFrame(() => navList?.scrollTo({ top: 0 }));
		return () => cancelAnimationFrame(id);
	});
	const MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

	function onkeydown(e: KeyboardEvent) {
		// ⌘F / Ctrl+F: the settings search (Orca's settings.search).
		if (e.key.toLowerCase() === 'f' && (MAC ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) {
			searchInput?.focus();
			searchInput?.select();
			e.preventDefault();
			return;
		}
		if (e.key !== 'Escape') return;
		if (query) query = '';
		else systemSettings.close();
		e.preventDefault();
		e.stopPropagation();
	}

	// Orca's settings sidebar: dimmed items that brighten on hover, the current one on an accent fill.
	const ITEM = 'flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[13px] text-(--vscode-foreground)/60 outline-none transition-colors duration-150 hover:bg-(--vscode-list-hoverBackground) hover:text-(--vscode-foreground) focus-visible:ring-2 focus-visible:ring-(--vscode-focusBorder)/50';
	const SELECTED = 'bg-(--vscode-list-inactiveSelectionBackground) font-medium text-(--vscode-foreground)! ring-1 ring-(--vscode-foreground)/10';
	const HEADING = 'px-3 pb-2 text-[11px] font-medium tracking-[0.18em] text-(--vscode-descriptionForeground) uppercase';
	const COUNT = 'text-[11px] font-normal text-(--vscode-descriptionForeground)';
	const BADGE = 'rounded-full bg-(--vscode-badge-background) px-1.5 py-0.5 text-[9px] font-medium tracking-wider text-(--vscode-badge-foreground) uppercase';
</script>

{#snippet pageItem(p: (typeof PAGES)[number])}
	{@const badge = PAGE_BADGES[p.id]}
	<button class={[ITEM, page === p.id && SELECTED]} aria-current={page === p.id ? 'page' : undefined} onclick={() => openPage(p.id)}>
		<Icon name={p.icon} size={15} /><span class="flex-1 truncate">{p.label}</span>
		{#if badge}<span class={BADGE}>{t(badge)}</span>{/if}
	</button>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape closes the page from anywhere inside it) -->
<section aria-label={t('settings.page.title')} class="flex min-h-0 flex-1 bg-(--vscode-editor-background) text-(--vscode-foreground)" {onkeydown}>
	<nav aria-label={t('settings.page.title')} class="flex w-[280px] shrink-0 flex-col border-r border-(--vscode-sideBar-border) bg-(--vscode-sideBar-background)">
		<div class="shrink-0 border-b border-(--vscode-sideBar-border) px-3 py-3">
			<button class={[ITEM, 'text-(--vscode-descriptionForeground)']} onclick={() => systemSettings.close()} title={t('settings.page.back') + ' (Escape)'}>
				<Icon name="arrowLeft" size={15} />{t('settings.page.back')}
			</button>
		</div>
		<div class="shrink-0 border-b border-(--vscode-sideBar-border) px-3 py-3">
			<label class="relative flex items-center">
				<span class="pointer-events-none absolute left-3 text-(--vscode-input-placeholderForeground)"><Icon name="search" size={16} /></span>
				<!-- Orca and VS Code focus the search when Settings opens. -->
				<!-- svelte-ignore a11y_autofocus -->
				<input
					bind:this={searchInput}
					value={query}
					oninput={(e) => search(e.currentTarget.value)}
					autofocus
					aria-label={t('settings.page.search')}
					placeholder={t('settings.page.search')}
					class="h-9 w-full min-w-0 rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) pr-14 pl-9 text-[13px] text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground) focus:border-(--vscode-focusBorder)"
				/>
				{#if !query}
					<span class="pointer-events-none absolute right-2 flex items-center gap-0.5" aria-hidden="true">
						{#each MAC ? ['⌘', 'F'] : ['Ctrl', 'F'] as k (k)}<kbd class="grid h-5 min-w-5 place-items-center rounded border border-(--vscode-widget-border) px-1 font-sans text-[10px] text-(--vscode-descriptionForeground)">{k}</kbd>{/each}
					</span>
				{/if}
			</label>
		</div>
		<div bind:this={navList} class="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-4">
			<!-- workbench.settings.settingsSearchTocBehavior `hide`: no table of contents while searching. -->
			{#if !tocHidden}
			{#each ORCA_NAV as sec (sec.id)}
				{@const items = sec.items.filter((it) => ('page' in it ? pageShown(it.page) : 'pane' in it ? paneMatches(ORCA_PANES[it.pane], query, (k) => t(k)) : !searching || shownGroup(it.group)))}
				{#if items.length}
					<div class="space-y-1">
						<div class={HEADING}>{t(sec.label)}</div>
						{#each items as it ('page' in it ? it.page : 'pane' in it ? it.pane : it.group)}
							{#if 'page' in it}
								{@const p = PAGES.find((x) => x.id === it.page)}
								{#if p}{@render pageItem(p)}{/if}
							{:else if 'pane' in it}
								{@const spec = ORCA_PANES[it.pane]}
								{@const sel = PANE_PREFIX + it.pane}
								<button class={[ITEM, selected === sel && SELECTED]} aria-current={selected === sel ? 'page' : undefined} onclick={() => select(sel)}>
									<Icon name={spec.icon} size={15} /><span class="flex-1 truncate">{t(spec.title)}</span>
								</button>
							{:else}
								{@const g = it.group}
								<button class={[ITEM, selected === g && SELECTED]} aria-current={selected === g ? 'page' : undefined} onclick={() => select(g)}>
									<Icon name={PANES[g].icon} size={15} /><span class="flex-1 truncate">{PANES[g].title ?? g}</span>
									{#if searching}<span class={COUNT}>{counts.get(g)}</span>{/if}
								</button>
							{/if}
						{/each}
					</div>
				{/if}
			{/each}
			<div class="space-y-1">
				<div class={HEADING}>{t('settings.page.allSettings')}</div>
				<button class={[ITEM, selected === null && !page && !showSnaps && query.trim() !== '@modified' && SELECTED]} onclick={() => select(null)}>{t('settings.page.all')}</button>
				<button class={[ITEM, query.trim() === '@modified' && SELECTED]} onclick={() => (select(null), (query = '@modified'))}>
					<span class="flex-1 truncate">{t('settings.page.modified')}</span>
					<span class={COUNT}>{modifiedCount}</span>
				</button>
			</div>
			<!-- VS Code's settings table of contents (vscodeToc.ts): Commonly Used, then the nodes; the
			     picked node opens to its children. -->
			<div class="space-y-1">
				<div class={HEADING}>VS Code</div>
				{#if !searching}
					<button class={[ITEM, selected === VS_PREFIX + COMMONLY_USED_ID && SELECTED]} onclick={() => select(VS_PREFIX + COMMONLY_USED_ID)}>Commonly Used</button>
				{/if}
				{#each VSCODE_TOC as node (node.id)}
					{@const groups = nodeGroups(node, settingSchemas.all).filter((g) => !searching || shownGroup(g))}
					{@const key = VS_PREFIX + node.id}
					{@const inNode = selected === key || groups.some((g) => groupOf(selected) === g)}
					{#if groups.length}
						<button class={[ITEM, selected === key && SELECTED]} aria-current={selected === key ? 'page' : undefined} aria-expanded={inNode} onclick={() => select(key)}>
							<span class={['grid place-items-center transition-transform', inNode && 'rotate-90']}><Icon name="chevronRight" size={12} /></span>
							<span class="flex-1 truncate">{node.label}</span>
							{#if searching}<span class={COUNT}>{groups.reduce((n, g) => n + (counts.get(g) ?? 0), 0)}</span>{/if}
						</button>
						{#if inNode && !searching}
							{#each tocChildren(node, settingSchemas.all) as child (child.key)}
								<button class={[ITEM, 'pl-9', selected === child.key && SELECTED]} aria-current={selected === child.key ? 'page' : undefined} onclick={() => select(child.key)}>
									<span class="flex-1 truncate">{child.label}</span>
								</button>
							{/each}
						{/if}
					{/if}
				{/each}
			</div>
			{#each settingSchemas.sections.filter((sec) => !ORCA_SECTION_IDS.has(sec.id) && !VSCODE_SECTION_IDS.has(sec.id)) as sec (sec.id)}
				{@const groups = sec.groups.filter((g) => !searching || shownGroup(g))}
				{@const pages = pagesOf(sec)}
				{@const snapsItem = sec.id === SNAPS_SECTION_ID && !searching}
				{#if groups.length || pages.length || snapsItem}
					<div class="space-y-1">
						<div class={HEADING}>{sectionLabel(sec)}</div>
						{#each pages as p (p.id)}{@render pageItem(p)}{/each}
						{#if snapsItem}
							<button class={[ITEM, showSnaps && SELECTED]} aria-current={showSnaps ? 'page' : undefined} onclick={() => systemSettings.showSnaps()}>
								<span class="flex-1 truncate">{t('settings.page.manageSnaps')}</span>
								<span class={COUNT}>{snaps.list.length}</span>
							</button>
						{/if}
						{#each groups as g (g)}
							{@const current = selected === g}
							{#if isPane(g)}
								<!-- An Orca pane: icon and name, a count only while searching. -->
								<button class={[ITEM, current && SELECTED]} aria-current={current ? 'page' : undefined} onclick={() => select(g)}>
									<Icon name={PANES[g].icon} size={15} /><span class="flex-1 truncate">{PANES[g].title ?? g}</span>
									{#if searching}<span class={COUNT}>{counts.get(g)}</span>{/if}
								</button>
							{:else}
								<button class={[ITEM, current && SELECTED]} aria-current={current ? 'page' : undefined} onclick={() => select(g)}>
									<span class="flex-1 truncate">{g}</span>
									{#if searching}<span class={COUNT}>{counts.get(g)}</span>{/if}
								</button>
								{#if groupOf(selected) === g && !searching}
									{#each subgroupsOf(g, settingSchemas.all) as sub (sub)}
										{@const key = tocKey(g, sub)}
										<button class={[ITEM, 'pl-6', selected === key && SELECTED]} aria-current={selected === key ? 'page' : undefined} onclick={() => select(key)}>
											<span class="flex-1 truncate">{sub}</span>
										</button>
									{/each}
								{/if}
							{/if}
						{/each}
					</div>
				{/if}
			{/each}
			{#if projectShown}
				<div class="space-y-1">
					<div class={HEADING}>{t('settings.page.projects')}</div>
					{#if workspace.root}
						<button class={[ITEM, projectPane && SELECTED]} aria-current={projectPane ? 'page' : undefined} onclick={() => select(PROJECT_PANE)} title={workspace.root}>
							<Icon name="folder" size={15} /><span class="flex-1 truncate">{projectName}</span>
						</button>
					{:else}
						<p class="px-2.5 text-xs text-(--vscode-descriptionForeground)">{t('settings.page.noProject')}</p>
					{/if}
				</div>
			{/if}
			{/if}
		</div>
		<div class="shrink-0 border-t border-(--vscode-sideBar-border) p-2">
			<button class={[ITEM, page === 'about' && SELECTED]} aria-current={page === 'about' ? 'page' : undefined} onclick={() => openPage('about')}>
				<Icon name="info" size={15} /><span class="flex-1 truncate">About Kingu</span>
			</button>
		</div>
	</nav>
	<div class="flex min-w-0 flex-1 flex-col">
		{#if !page && !paneGroup && !projectPane && !orcaPane}
			<div class="flex h-[35px] shrink-0 items-center gap-2 border-b border-(--vscode-widget-border) pr-2 pl-6 text-[13px]">
				{#each crumbs as c, i (i)}
					{#if i}<span class="text-(--vscode-descriptionForeground)">›</span>{/if}
					<span class={i < crumbs.length - 1 ? 'text-(--vscode-descriptionForeground)' : undefined}>{c}</span>
				{/each}
			</div>
		{/if}
		<div class="min-h-0 flex-1">
			{#if page === 'appearance'}<OrcaPane spec={ORCA_PANES.appearance} {query} />
			{:else if page === 'shortcuts'}<ShortcutsPage />
			{:else if page === 'arkai'}<ArkaiPage />
			{:else if page === 'terminal'}<TerminalPage />
			{:else if page === 'account'}<AccountPage />
			{:else if page === 'accounts'}<AccountsView />
			{:else if page === 'usage'}<UsagePage />
			{:else if page === 'mcp'}<McpPage />
			{:else if page === 'skills'}<SkillsPage />
			{:else if page === 'memories'}<MemoriesPage />
			{:else if page === 'voice'}<VoicePage />
			{:else if page === 'about'}<AboutPage />
			{:else if showSnaps}<SnapsView />
			{:else if orcaPane}<OrcaPane spec={orcaPane} {query} />
			{:else if paneGroup === 'Agent'}
				<SettingsEditor pane={{ title: 'Agents', description: t('settings.agents.pane'), groups: ['Agent'], scope: 'user', exclude: [...AGENT_CATALOG_IDS, ...PANE_SETTING_IDS] }} bind:query>
					{#snippet lead()}<AgentCatalog />{/snippet}
				</SettingsEditor>
			{:else if paneGroup}<SettingsEditor pane={{ title: paneGroup, description: t(PANES[paneGroup].description), groups: [paneGroup], scope: 'user' }} bind:query />
			{:else if projectPane}<OrcaPane spec={PROJECT} scope="repo" title={projectName} description={t('settings.pane.project', { name: projectName })} {query} />
			{:else if commonlyUsed}<SettingsEditor ids={COMMONLY_USED} heading="Commonly Used" bind:query hideSearch />
			{:else if vsNode}<SettingsEditor groups={nodeGroups(vsNode, settingSchemas.all)} bind:query hideSearch />
			{:else}<SettingsEditor group={selected} bind:query hideSearch />{/if}
		</div>
	</div>
</section>
