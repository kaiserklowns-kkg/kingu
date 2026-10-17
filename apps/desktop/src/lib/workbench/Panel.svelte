<script lang="ts">
	import Terminal from '#lib/terminal/Terminal.svelte';
	import Icon from './Icon.svelte';
	import { layout, type PanelTab } from './layout.svelte';

	const tabs: { id: PanelTab; label: string }[] = [
		{ id: 'problems', label: 'Problems' },
		{ id: 'output', label: 'Output' },
		{ id: 'terminal', label: 'Terminal' }
	];
</script>

<section aria-label="Panel" class="flex h-full flex-col border-t border-(--vscode-panel-border) bg-(--vscode-panel-background)">
	<div role="tablist" aria-label="Panel" class="flex h-(--kg-part-title-height) shrink-0 items-center gap-1 px-2">
		{#each tabs as t (t.id)}
			<button
				role="tab"
				aria-selected={layout.panelTab === t.id}
				class={[
					'h-full border-b px-2 text-[11px] uppercase',
					layout.panelTab === t.id
						? 'border-(--vscode-panelTitle-activeBorder) text-(--vscode-panelTitle-activeForeground)'
						: 'border-transparent text-(--vscode-panelTitle-inactiveForeground) hover:text-(--vscode-panelTitle-activeForeground)'
				]}
				onclick={() => (layout.panelTab = t.id)}>{t.label}</button
			>
		{/each}
		<div class="flex-1"></div>
		<button aria-label="Hide Panel" title="Hide Panel" class="grid size-6 place-items-center rounded hover:bg-white/10" onclick={() => (layout.panelVisible = false)}>
			<Icon name="close" size={14} />
		</button>
	</div>
	<div class="relative min-h-0 flex-1">
		<!-- The terminal stays mounted so its shell survives tab switches, like VS Code's pty host. -->
		<div class={['absolute inset-0 bg-(--vscode-terminal-background)', layout.panelTab !== 'terminal' && 'invisible']}>
			<Terminal />
		</div>
		{#if layout.panelTab === 'problems'}
			<p class="absolute inset-0 px-5 py-1 text-(--vscode-descriptionForeground)">No problems have been detected in the workspace.</p>
		{:else if layout.panelTab === 'output'}
			<p class="absolute inset-0 px-5 py-1 font-mono text-xs text-(--vscode-descriptionForeground)">Language servers (LSP) และ output ของ task อยู่ใน P1</p>
		{/if}
	</div>
</section>
