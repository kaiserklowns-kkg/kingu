<script lang="ts">
	import DebugConsole from '#lib/debug/DebugConsole.svelte';
	import ProblemsView from '#lib/lsp/ProblemsView.svelte';
	import { lsp } from '#lib/lsp/lsp.svelte.ts';
	import Terminal from '#lib/terminal/Terminal.svelte';
	import { terminals } from '#lib/terminal/terminals.svelte.ts';
	import PaneSplitView from '#lib/terminal/PaneSplitView.svelte';
	import { leaves } from '#lib/terminal/paneLayout.ts';
	import { focusTerminal } from '#lib/terminal/registry.ts';
	import Icon from './Icon.svelte';
	import { editors } from './editors.svelte';
	import { isMac, keyLabel } from './keys';
	import { layout, type PanelTab } from './layout.svelte';

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

	const activeGroup = $derived(terminals.groupOf(terminals.active));
	const splitKey = keyLabel(isMac ? 'cmd+\\' : 'ctrl+shift+5');

	/** A terminal's context menu items beyond copy/paste/clear (VS Code: Split, Rename, Kill). */
	function terminalAction(id: number, action: string) {
		if (action === 'split') terminals.split(id);
		else if (action === 'rename') void terminals.rename(id);
		else if (action === 'kill') void terminals.kill(id);
	}

	/** A followed file link opens pinned at its position, like VS Code's terminal link opener. */
	function openFile(rel: string, line?: number, column?: number) {
		editors.open(rel, { preview: false, reveal: line ? { line, column: column ?? 1, focus: true } : undefined });
	}

	const tabs: { id: PanelTab; label: string }[] = [
		{ id: 'problems', label: 'Problems' },
		{ id: 'output', label: 'Output' },
		{ id: 'debugConsole', label: 'Debug Console' },
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
		{#if layout.panelTab === 'terminal'}
			<button aria-label="New Terminal" title="New Terminal" class="grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => terminals.open()}>
				<Icon name="plus" size={16} />
			</button>
			<button aria-label="Split Terminal" title="Split Terminal ({splitKey})" class="grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => terminals.split()}>
				<Icon name="layout" size={15} />
			</button>
			<button aria-label="Kill Terminal" title="Kill Terminal" class="grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => terminals.kill(terminals.active)}>
				<Icon name="trash" size={15} />
			</button>
		{/if}
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
		<div class={['absolute inset-0 flex bg-(--vscode-terminal-background)', layout.panelTab !== 'terminal' && 'invisible']}>
			<!-- Each folder has its own terminals; another folder's keep running in the background. -->
			{#if terminals.tag}
				{#key terminals.tag}
					<div class="relative min-w-0 flex-1">
						<!-- VS Code's terminal groups: the active terminal's group shows, split side by side. -->
						{#each terminals.groups as group, g (leaves(group)[0])}
							<div class={['absolute inset-0', g !== activeGroup && 'invisible']}>
								<PaneSplitView tree={group} onresize={(path, ratio) => terminals.resize(g, path, ratio)}>
									{#snippet pane(id)}
										{@const t = terminals.get(Number(id))}
										{#if t}
											<Terminal
												key={terminals.key(t.id)}
												run={t.run}
												cwdFrom={t.cwdFrom}
												flavor="ide"
												keyLabels={{ split: splitKey }}
												onfocus={() => (terminals.active = t.id)}
												onaction={(a) => terminalAction(t.id, a)}
												onopenfile={openFile}
											/>
										{/if}
									{/snippet}
								</PaneSplitView>
							</div>
						{/each}
					</div>
				{/key}
			{/if}
			{#if terminals.list.length > 1}
				<!-- VS Code's terminal tabs list, on the right once there is more than one; a split group is drawn with tree lines. -->
				<ul aria-label="Terminals" class="w-44 shrink-0 overflow-y-auto border-l border-(--vscode-panel-border) py-1 text-[13px]">
					{#each terminals.groups as group (leaves(group)[0])}
						{@const ids = leaves(group).map(Number)}
						{#each ids as id, i (id)}
							{@const t = terminals.get(id)}
							{#if t}
								<li>
									<button
										class={['group flex h-[22px] w-full items-center gap-1.5 px-2 text-left', t.id === terminals.active ? 'bg-(--vscode-list-inactiveSelectionBackground)' : 'hover:bg-(--vscode-list-hoverBackground)']}
										onclick={() => ((terminals.active = t.id), focusTerminal(terminals.key(t.id)))}
										ondblclick={() => terminals.rename(t.id)}
									>
										{#if ids.length > 1}<span class="w-2 shrink-0 font-mono text-(--vscode-descriptionForeground)" aria-hidden="true">{i === 0 ? '┌' : i === ids.length - 1 ? '└' : '├'}</span>{/if}
										<Icon name="terminal" size={14} />
										<span class="min-w-0 flex-1 truncate" title={t.run?.join(' ') ?? t.title}>{t.title}</span>
										<span
											role="button"
											tabindex="-1"
											aria-label="Kill {t.title}"
											class="invisible grid size-4 place-items-center rounded group-hover:visible hover:bg-(--vscode-toolbar-hoverBackground)"
											onclick={(e) => (e.stopPropagation(), void terminals.kill(t.id))}
											onkeydown={() => {}}><Icon name="close" size={12} /></span
										>
									</button>
								</li>
							{/if}
						{/each}
					{/each}
				</ul>
			{/if}
		</div>
		{#if layout.panelTab === 'problems'}
			<div class="absolute inset-0"><ProblemsView /></div>
		{:else if layout.panelTab === 'debugConsole'}
			<div class="absolute inset-0"><DebugConsole /></div>
		{:else if layout.panelTab === 'output'}
			<!-- Language server output for now; task output joins it later. -->
			<pre class="absolute inset-0 overflow-auto px-5 py-1 font-mono text-xs whitespace-pre-wrap text-(--vscode-descriptionForeground)">{lsp.log.length ? lsp.log.join('\n') : 'No output yet. Language servers log here once a Rust, TypeScript or Go file is opened.'}</pre>
		{/if}
	</div>
</section>
