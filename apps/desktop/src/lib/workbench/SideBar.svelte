<script lang="ts">
	import ExplorerView from './ExplorerView.svelte';
	import ScmView from './ScmView.svelte';
	import SearchView from './SearchView.svelte';
	import AgentsView from '#lib/ade/AgentsView.svelte';
	import ActivityBar from './ActivityBar.svelte';
	import { layout } from './layout.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';

	let { workspaceName }: { workspaceName: string } = $props();

	const titles = { explorer: 'Explorer', search: 'Search', scm: 'Source Control', agents: 'Agents' };
</script>

<aside aria-label={titles[layout.sideView]} class="flex h-full flex-col bg-(--vscode-sideBar-background) text-(--vscode-sideBar-foreground)">
	{#if settings.get('workbench.activityBar.location') === 'top'}
		<!-- `workbench.activityBar.location: top`: the view switcher is the side bar's header. -->
		<div class="flex h-(--kg-part-title-height) shrink-0 items-center px-1.5 text-(--vscode-sideBarTitle-foreground)">
			<ActivityBar orientation="horizontal" />
		</div>
		<div class="flex h-6 shrink-0 items-center pl-5 text-[11px] text-(--vscode-sideBarTitle-foreground) uppercase">{titles[layout.sideView]}</div>
	{:else}
		<div class="flex h-(--kg-part-title-height) shrink-0 items-center pl-5 text-[11px] text-(--vscode-sideBarTitle-foreground) uppercase">
			{titles[layout.sideView]}
		</div>
	{/if}

	{#if layout.sideView === 'explorer'}
		<ExplorerView {workspaceName} />
	{:else if layout.sideView === 'search'}
		<SearchView />
	{:else if layout.sideView === 'scm'}
		<ScmView />
	{:else if layout.sideView === 'agents'}
		<AgentsView />
	{/if}
</aside>
