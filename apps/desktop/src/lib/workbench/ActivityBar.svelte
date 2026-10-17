<script lang="ts">
	import Icon, { type IconName } from './Icon.svelte';
	import { layout, type SideView } from './layout.svelte';
	import { keyLabel } from './keys';

	const views: { view: SideView; label: string; icon: IconName; key: string }[] = [
		{ view: 'explorer', label: 'Explorer', icon: 'files', key: 'cmd+shift+e' },
		{ view: 'search', label: 'Search', icon: 'search', key: 'cmd+shift+f' },
		{ view: 'scm', label: 'Source Control', icon: 'git', key: 'ctrl+shift+g' }
	];
</script>

<!-- 48px wide, 48px items, 24px icons, 2px active indicator on the left (VS Code activitybarPart). -->
<nav
	aria-label="Activity Bar"
	class="flex w-(--kg-activitybar-width) shrink-0 flex-col items-center border-r border-(--vscode-activityBar-border) bg-(--vscode-activityBar-background)"
>
	{#each views as v (v.view)}
		{@const on = layout.sidebarVisible && layout.sideView === v.view}
		<button
			aria-label="{v.label} ({keyLabel(v.key)})"
			aria-pressed={on}
			title="{v.label} ({keyLabel(v.key)})"
			class={[
				'relative grid size-12 place-items-center',
				on ? 'text-(--vscode-activityBar-foreground)' : 'text-(--vscode-activityBar-inactiveForeground) hover:text-(--vscode-activityBar-foreground)'
			]}
			onclick={() => layout.showView(v.view)}
		>
			{#if on}<span class="absolute inset-y-0 left-0 w-0.5 bg-(--vscode-activityBar-activeBorder)"></span>{/if}
			<Icon name={v.icon} size={24} stroke={1.5} />
		</button>
	{/each}
	<button
		aria-label="Agent ({keyLabel('cmd+alt+b')})"
		aria-pressed={layout.auxVisible}
		title="Agent ({keyLabel('cmd+alt+b')})"
		class={[
			'relative grid size-12 place-items-center',
			layout.auxVisible ? 'text-(--vscode-activityBar-foreground)' : 'text-(--vscode-activityBar-inactiveForeground) hover:text-(--vscode-activityBar-foreground)'
		]}
		onclick={() => (layout.auxVisible = !layout.auxVisible)}
	>
		<Icon name="agent" size={24} stroke={1.5} />
	</button>
	<div class="flex-1"></div>
	<button aria-label="Accounts" title="Accounts" class="grid size-12 place-items-center text-(--vscode-activityBar-inactiveForeground)">
		<Icon name="account" size={24} stroke={1.5} />
	</button>
	<button aria-label="Manage" title="Manage" class="grid size-12 place-items-center text-(--vscode-activityBar-inactiveForeground)">
		<Icon name="settings" size={24} stroke={1.5} />
	</button>
</nav>
