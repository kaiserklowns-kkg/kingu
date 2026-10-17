<script lang="ts">
	import Icon, { type IconName } from './Icon.svelte';
	import { layout } from './layout.svelte';
	import { quick } from './quick.svelte';
	import { editors } from './editors.svelte';
	import { keyLabel } from './keys';
	import { agents } from '#lib/agent/agents.svelte.ts';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';

	let { workspaceName }: { workspaceName: string } = $props();

	const toggles: { label: string; icon: IconName; key: string; on: () => boolean; flip: () => void }[] = [
		{ label: 'Toggle Primary Side Bar', icon: 'sidebarLeft', key: 'cmd+b', on: () => layout.sidebarVisible, flip: () => (layout.sidebarVisible = !layout.sidebarVisible) },
		{ label: 'Toggle Panel', icon: 'panelBottom', key: 'cmd+j', on: () => layout.panelVisible, flip: () => (layout.panelVisible = !layout.panelVisible) },
		{ label: 'Toggle Agent (Secondary Side Bar)', icon: 'sidebarRight', key: 'cmd+alt+b', on: () => layout.auxVisible, flip: () => (layout.auxVisible = !layout.auxVisible) }
	];

	const title = $derived(editors.active ? `${editors.active.split('/').pop()} — ${workspaceName}` : workspaceName);
</script>

<!-- Custom title bar, 35px with the command center (VS Code's default `window.titleBarStyle: custom`).
     The left inset clears the macOS traffic lights of the overlay title bar. -->
<header
	data-tauri-drag-region
	class="flex h-(--kg-titlebar-height) shrink-0 items-center border-b border-(--vscode-titleBar-border) bg-(--vscode-titleBar-activeBackground) pr-2 pl-[78px] text-(--vscode-titleBar-activeForeground)"
>
	<div data-tauri-drag-region class="flex flex-1 justify-center">
		<button
			class="flex h-[22px] w-[min(600px,38vw)] items-center justify-center gap-1.5 rounded-md border border-(--vscode-commandCenter-border) bg-(--vscode-commandCenter-background) text-xs hover:bg-(--vscode-toolbar-hoverBackground)"
			onclick={() => quick.show('')}
			title="ค้นหาไฟล์ ({keyLabel('cmd+p')}) · คำสั่ง ({keyLabel('cmd+shift+p')})"
		>
			<Icon name="search" size={14} />
			<span class="truncate">{title}</span>
		</button>
	</div>
	<div class="flex items-center gap-0.5">
		{#if adeTasks.attentionCount + agents.pendingCount}
			<button
				class="mr-1 flex h-[22px] items-center gap-1 rounded-full bg-(--vscode-activityBarBadge-background) px-2 text-xs text-(--vscode-activityBarBadge-foreground) hover:opacity-90"
				title="เปิดงานถัดไปที่รอคุณ"
				onclick={() => (adeTasks.attentionCount ? adeTasks.openNext() : (layout.auxVisible = true))}
			>
				รอคุณ {adeTasks.attentionCount + agents.pendingCount}
			</button>
		{/if}
		{#each toggles as t (t.label)}
			<button
				aria-label={t.label}
				aria-pressed={t.on()}
				title="{t.label} ({keyLabel(t.key)})"
				class={['grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)', t.on() ? 'opacity-100' : 'opacity-50']}
				onclick={t.flip}
			>
				<Icon name={t.icon} size={16} />
			</button>
		{/each}
	</div>
</header>
