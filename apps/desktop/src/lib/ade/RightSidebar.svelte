<script lang="ts">
	// The ADE's right side bar (Orca's right sidebar) for the selected worktree `key` ('' = the
	// folder itself): icon tabs Explorer, Agents, Source Control and Checks (the last two only in a
	// git repository), each worktree remembering its own tab, and the toggle on the far right.
	import Icon from '#lib/workbench/Icon.svelte';
	import { keyLabel } from '#lib/workbench/keys.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import AgentSessions from './AgentSessions.svelte';
	import PrChecks from './PrChecks.svelte';
	import { summarizeChecks } from './prChecks.ts';
	import { prStatuses } from './prStatus.svelte.ts';
	import { rightSidebar } from './rightSidebar.svelte.ts';
	import { visibleTabs } from './rightSidebar.ts';
	import WorktreeFiles from './WorktreeFiles.svelte';
	import WorktreeScm from './WorktreeScm.svelte';

	let { key }: { key: string } = $props();

	const shown = $derived(visibleTabs(rightSidebar.isGit(key), rightSidebar.tab(key)));
	const checks = $derived(summarizeChecks(prStatuses.bySlug[key]?.pr?.checks ?? []).overall);
	const DOT: Record<string, string> = {
		failure: 'bg-(--vscode-errorForeground)',
		pending: 'bg-(--vscode-editorInfo-foreground)',
		success: 'bg-[#73C991]'
	};
</script>

<div class="flex h-9 shrink-0 items-stretch gap-0.5 border-b border-(--vscode-sideBar-border) px-1.5" role="tablist" aria-label="Right Side Bar">
	{#each shown.tabs as t (t.id)}
		{@const on = shown.active === t.id}
		<button
			role="tab"
			aria-selected={on}
			aria-label={t.label}
			class={['relative grid w-8 place-items-center', on ? 'text-(--vscode-foreground)' : 'text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)']}
			title={t.key ? `${t.label} (${keyLabel(t.key)})` : t.label}
			onclick={() => rightSidebar.setTab(key, t.id)}
		>
			<Icon name={t.icon} size={16} />
			{#if t.id === 'checks' && DOT[checks]}<span class={['absolute top-1.5 right-1 size-1.5 rounded-full', DOT[checks]]}></span>{/if}
			{#if on}<span class="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-(--vscode-focusBorder)"></span>{/if}
		</button>
	{/each}
	<span class="flex-1"></span>
	<button class="my-auto grid size-6 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="Toggle right sidebar" title="Toggle right sidebar ({keyLabel('cmd+l')})" onclick={() => (appMode.panelVisible = false)}>
		<Icon name="sidebarRight" size={15} />
	</button>
</div>
<div class="min-h-0 flex-1" role="tabpanel">
	{#if shown.active === 'files'}
		{#key key}<WorktreeFiles slug={key} />{/key}
	{:else if shown.active === 'agents'}
		<AgentSessions current={key} />
	{:else if shown.active === 'changes'}
		{#key key}<WorktreeScm slug={key} />{/key}
	{:else}
		<div class="h-full overflow-y-auto px-3 py-2">{#key key}<PrChecks slug={key} />{/key}</div>
	{/if}
</div>
