<script lang="ts">
	import ExplorerView from './ExplorerView.svelte';
	import ScmView from './ScmView.svelte';
	import SearchView from './SearchView.svelte';
	import AgentsView from '#lib/ade/AgentsView.svelte';
	import DebugView from '#lib/debug/DebugView.svelte';
	import SnapsSideView from '#lib/snaps/SnapsSideView.svelte';
	import VaultView from '#lib/vault/VaultView.svelte';
	import ArtifactsView from '#lib/artifacts/ArtifactsView.svelte';
	import { t } from '#lib/i18n/index.ts';
	import ActivityBar from './ActivityBar.svelte';
	import { layout } from './layout.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';

	let { workspaceName }: { workspaceName: string } = $props();

	const location = $derived(settings.get<string>('workbench.activityBar.location'));
	const titles = $derived({ explorer: 'Explorer', search: 'Search', scm: 'Source Control', debug: 'Run and Debug', snaps: 'Snaps', agents: 'Agents', vault: t('vault.title'), artifacts: t('artifacts.title') });
</script>

<aside aria-label={titles[layout.sideView]} class="flex h-full flex-col bg-(--vscode-sideBar-background) text-(--vscode-sideBar-foreground)">
	{#if location === 'top'}
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

	<div class="flex min-h-0 flex-1 flex-col">
	{#if layout.sideView === 'explorer'}
		<ExplorerView {workspaceName} />
	{:else if layout.sideView === 'search'}
		<SearchView />
	{:else if layout.sideView === 'scm'}
		<ScmView />
	{:else if layout.sideView === 'debug'}
		<DebugView />
	{:else if layout.sideView === 'snaps'}
		<SnapsSideView />
	{:else if layout.sideView === 'agents'}
		<AgentsView />
	{:else if layout.sideView === 'vault'}
		<VaultView />
	{:else if layout.sideView === 'artifacts'}
		<ArtifactsView />
	{/if}
	</div>
	{#if location === 'bottom'}
		<!-- `workbench.activityBar.location: bottom`: the view switcher at the foot of the side bar. -->
		<div class="flex h-(--kg-part-title-height) shrink-0 items-center border-t border-(--vscode-sideBarSectionHeader-border) px-1.5 text-(--vscode-sideBarTitle-foreground)">
			<ActivityBar orientation="horizontal" />
		</div>
	{/if}
</aside>
