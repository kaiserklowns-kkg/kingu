<script lang="ts">
	import ExplorerView from './ExplorerView.svelte';
	import ScmView from './ScmView.svelte';
	import SearchView from './SearchView.svelte';
	import { layout } from './layout.svelte';

	let { workspaceName }: { workspaceName: string } = $props();

	const titles = { explorer: 'Explorer', search: 'Search', scm: 'Source Control', agents: 'Agents' };
</script>

<aside aria-label={titles[layout.sideView]} class="flex h-full flex-col bg-(--vscode-sideBar-background) text-(--vscode-sideBar-foreground)">
	<div class="flex h-(--kg-part-title-height) shrink-0 items-center pl-5 text-[11px] text-(--vscode-sideBarTitle-foreground) uppercase">
		{titles[layout.sideView]}
	</div>

	{#if layout.sideView === 'explorer'}
		<ExplorerView {workspaceName} />
	{:else if layout.sideView === 'search'}
		<SearchView />
	{:else if layout.sideView === 'scm'}
		<ScmView />
	{/if}
</aside>
