<script lang="ts">
	import ProblemsView from '#lib/lsp/ProblemsView.svelte';
	import { lsp } from '#lib/lsp/lsp.svelte.ts';
	import Terminal from '#lib/terminal/Terminal.svelte';
	import Icon from './Icon.svelte';
	import { layout, type PanelTab } from './layout.svelte';
	import { workspace } from './workspace.svelte';

	// VS Code's Maximize Panel Size: the panel takes the editor area; again restores the height.
	let restoreHeight: number | null = $state(null);
	const maximized = $derived(restoreHeight !== null);
	function toggleMaximize() {
		if (restoreHeight !== null) {
			layout.panelHeight = restoreHeight;
			restoreHeight = null;
		} else {
			restoreHeight = layout.panelHeight;
			layout.panelHeight = Math.max(160, window.innerHeight - 35 - 22 - 70);
		}
	}

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
		<button
			aria-label={maximized ? 'Restore Panel Size' : 'Maximize Panel Size'}
			title={maximized ? 'Restore Panel Size' : 'Maximize Panel Size'}
			class="grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)"
			onclick={toggleMaximize}
		>
			<Icon name={maximized ? 'chevronDown' : 'chevronUp'} size={16} />
		</button>
		<button aria-label="Hide Panel" title="Hide Panel" class="grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => (layout.panelVisible = false)}>
			<Icon name="close" size={14} />
		</button>
	</div>
	<div class="relative min-h-0 flex-1">
		<!-- The terminal stays mounted so its shell survives tab switches, like VS Code's pty host. -->
		<div class={['absolute inset-0 bg-(--vscode-terminal-background)', layout.panelTab !== 'terminal' && 'invisible']}>
			<!-- Open Folder restarts the shell in the new root (VS Code reloads the window). -->
			{#if workspace.ready}{#key workspace.root}<Terminal />{/key}{/if}
		</div>
		{#if layout.panelTab === 'problems'}
			<div class="absolute inset-0"><ProblemsView /></div>
		{:else if layout.panelTab === 'output'}
			<!-- Language server output for now; task output joins it later. -->
			<pre class="absolute inset-0 overflow-auto px-5 py-1 font-mono text-xs whitespace-pre-wrap text-(--vscode-descriptionForeground)">{lsp.log.length ? lsp.log.join('\n') : 'No output yet. Language servers log here once a Rust, TypeScript or Go file is opened.'}</pre>
		{/if}
	</div>
</section>
