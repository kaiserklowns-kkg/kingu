<script lang="ts">
	// Agents layout title bar, laid out like Orca's: three columns that line up with the parts
	// below. Left (side bar width): traffic-light inset, the app name, side bar toggle, worktree
	// back/forward. Center: the selected worktree's tabs (agent session or new task, terminals) and
	// "+" for a terminal; at its end "N รอคุณ" and Open in Editor (the way back to the IDE, ⇧⌘A).
	// Right (right side bar width): Files / Changes tabs and the right side bar toggle.
	// Same 35px height as the workbench title bar, so switching modes does not shift the window.
	import { invoke } from '@tauri-apps/api/core';
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { commands, keyOf } from '#lib/workbench/commands.svelte.ts';
	import { isMac, keyLabel } from '#lib/workbench/keys.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { sessionsAttentionLabel, titleBarHeight } from '#lib/workbench/titlebar.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { adeLayout, type RightTab } from './adeLayout.svelte';
	import { openEditor, pickSession } from './agentsMode.svelte';
	import { STATUS_LABEL } from './model';
	import { adeTasks } from './tasks.svelte';
	import { STATUS_DOT } from './ui';

	let { focused }: { focused: boolean } = $props();

	const hint = (command: string) => {
		const cmd = commands.get(command);
		const k = cmd && keyOf(cmd);
		return k ? ` (${keyLabel(k)})` : '';
	};

	const height = $derived(titleBarHeight('workbench', { commandCenter: true, compactAgents: false }));
	$effect(() => document.documentElement.style.setProperty('--kg-titlebar-height', `${height}px`));

	const key = $derived(adeLayout.key);
	const view = $derived(key ? adeTasks.find(key) : undefined);
	const tabs = $derived(adeLayout.tabs(key));
	const activeTab = $derived(adeLayout.activeTab(key));
	const attention = $derived(sessionsAttentionLabel(adeTasks.counts.needsInput));

	const RIGHT_TABS: { id: RightTab; label: string; icon: IconName }[] = [
		{ id: 'files', label: 'Files', icon: 'files' },
		{ id: 'changes', label: 'Changes (Source Control)', icon: 'git' }
	];
	function showRight(id: RightTab) {
		if (appMode.panelVisible && adeLayout.rightTab === id) appMode.panelVisible = false;
		else {
			adeLayout.rightTab = id;
			appMode.panelVisible = true;
		}
	}

	const onBarItself = (e: MouseEvent) => !(e.target as Element).closest('button, a, input, [role="tab"]');
	function onMouseUp(e: MouseEvent) {
		if (!isMac || e.button !== 0 || e.detail !== 2 || !onBarItself(e)) return;
		e.stopPropagation();
		void invoke('window_titlebar_double_click').catch(() => {});
	}

	const ACTION = 'grid size-6 shrink-0 place-items-center rounded-md enabled:hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-35';
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (double-click zoom is a pointer convenience, like the native title bar) -->
<header
	data-tauri-drag-region="deep"
	onmouseup={onMouseUp}
	style:height="{height}px"
	class={[
		'agents-titlebar relative flex shrink-0 items-stretch border-b border-(--vscode-titleBar-border) bg-(--vscode-titleBar-activeBackground) text-(--vscode-titleBar-activeForeground) select-none',
		!focused && 'inactive [&>*]:opacity-60'
	]}
>
	<!-- Left: lines up with the side bar. -->
	<div
		class={['flex shrink-0 items-center gap-0.5 pr-1.5', appMode.sessionsVisible && 'border-r border-(--vscode-sideBar-border)']}
		style:width={appMode.sessionsVisible ? `${appMode.sessionsWidth}px` : undefined}
	>
		{#if isMac}<div class="h-full w-[74px] shrink-0"></div>{:else}<div class="grid h-full w-[35px] shrink-0 place-items-center" aria-hidden="true"><Icon name="kingu" size={16} /></div>{/if}
		<span class="truncate pr-1 text-[13px] font-semibold">Kingu</span>
		<button
			class={ACTION}
			aria-label="Toggle Side Bar"
			aria-pressed={appMode.sessionsVisible}
			title="Toggle Side Bar{hint('workbench.action.toggleSidebarVisibility')}"
			onclick={() => (appMode.sessionsVisible = !appMode.sessionsVisible)}
		>
			<Icon name="sidebarLeft" size={16} />
		</button>
		<span class="flex-1"></span>
		<button class={ACTION} aria-label="Previous Worktree" title="ย้อนกลับ (worktree ก่อนหน้า)" disabled={!appMode.canGoBack} onclick={() => appMode.back()}><Icon name="arrowLeft" size={15} /></button>
		<button class={ACTION} aria-label="Next Worktree" title="ไปข้างหน้า" disabled={!appMode.canGoForward} onclick={() => appMode.forward()}><Icon name="arrowRight" size={15} /></button>
	</div>

	<!-- Center: the worktree's tabs. -->
	<div class="flex min-w-0 flex-1 items-stretch">
		{#if adeLayout.board}
			<div class="flex items-center gap-2 border-r border-(--vscode-editorGroupHeader-tabsBorder,var(--vscode-widget-border)) bg-(--vscode-tab-activeBackground) px-3 text-[13px]">
				<Icon name="tasks" size={14} /> Tasks
				<button class="grid size-5 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="ปิด Tasks" onclick={() => (adeLayout.board = false)}><Icon name="close" size={13} /></button>
			</div>
		{:else}
			<div class="flex min-w-0 items-stretch overflow-x-auto" role="tablist" aria-label="แท็บของ worktree">
				{#each tabs as t (t.id)}
					{@const active = t.id === activeTab}
					<div
						role="tab"
						tabindex="0"
						aria-selected={active}
						class={[
							'group flex max-w-60 min-w-0 shrink-0 cursor-default items-center gap-1.5 border-r border-(--vscode-editorGroupHeader-tabsBorder,var(--vscode-widget-border)) pr-1.5 pl-3 text-[13px]',
							active ? 'bg-(--vscode-tab-activeBackground) text-(--vscode-tab-activeForeground)' : 'text-(--vscode-tab-inactiveForeground) hover:bg-(--vscode-tab-hoverBackground)'
						]}
						onclick={() => adeLayout.select(key, t.id)}
						onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), adeLayout.select(key, t.id))}
						onauxclick={(e) => e.button === 1 && t.kind === 'terminal' && adeLayout.closeTerminal(key, t.id)}
					>
						{#if t.kind === 'agent' && view}
							<span class={['size-2 shrink-0 rounded-full', STATUS_DOT[view.status]]} title={STATUS_LABEL[view.status]}></span>
							<span class="truncate" title={view.meta.title}>{view.meta.title}</span>
						{:else if t.kind === 'compose'}
							<Icon name="agent" size={14} /><span class="truncate">{t.label}</span>
						{:else}
							<Icon name="terminal" size={14} /><span class="truncate">{t.label}</span>
						{/if}
						{#if t.kind === 'terminal'}
							<button
								class={['grid size-5 shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)', !active && 'invisible group-hover:visible']}
								aria-label="ปิด {t.label}"
								title="ปิด"
								onclick={(e) => (e.stopPropagation(), adeLayout.closeTerminal(key, t.id))}><Icon name="close" size={13} /></button
							>
						{:else}
							<span class="w-1"></span>
						{/if}
					</div>
				{/each}
			</div>
			<div class="flex items-center px-1">
				<button class={ACTION} aria-label="Terminal ใหม่ใน worktree นี้" title="Terminal ใหม่ใน worktree นี้" disabled={!workspace.root} onclick={() => adeLayout.newTerminal(key)}>
					<Icon name="plus" size={16} />
				</button>
			</div>
		{/if}
		<span class="min-w-4 flex-1"></span>
		<div class="flex shrink-0 items-center gap-1 pr-2">
			{#if attention}
				<button
					class="needs-input flex h-[22px] items-center gap-1.5 rounded-md px-2 text-xs text-(--vscode-editorWarning-foreground) hover:bg-(--vscode-toolbar-hoverBackground)"
					title="{attention} — เลือก session"
					onclick={pickSession}
				>
					<span class="size-2 rounded-full bg-(--vscode-editorWarning-foreground)"></span>{attention}
				</button>
			{/if}
			<button
				class="flex h-[22px] items-center gap-1.5 rounded-md px-2 text-[13px] hover:bg-(--vscode-toolbar-hoverBackground)"
				title="Open in Editor{hint('workbench.action.toggleAgentsMode')}"
				onclick={openEditor}
			>
				<Icon name="code" size={15} /> Open in Editor
			</button>
		</div>
	</div>

	<!-- Right: lines up with the right side bar. -->
	<div
		class={['flex shrink-0 items-center gap-0.5 px-1.5', appMode.panelVisible && 'border-l border-(--vscode-sideBar-border)']}
		style:width={appMode.panelVisible ? `${appMode.panelWidth}px` : undefined}
	>
		{#if appMode.panelVisible}
			{#each RIGHT_TABS as t (t.id)}
				{@const on = adeLayout.rightTab === t.id}
				<button
					class={['relative grid h-full w-8 place-items-center', on ? 'text-(--vscode-foreground)' : 'text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)']}
					aria-label={t.label}
					aria-pressed={on}
					title={t.label}
					onclick={() => showRight(t.id)}
				>
					<Icon name={t.icon} size={17} />
					{#if on}<span class="absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-(--vscode-foreground)"></span>{/if}
				</button>
			{/each}
			<span class="flex-1"></span>
		{/if}
		<button
			class={ACTION}
			aria-label="Toggle Right Side Bar"
			aria-pressed={appMode.panelVisible}
			title="Toggle Right Side Bar{hint('workbench.action.togglePanel')}"
			onclick={() => (appMode.panelVisible = !appMode.panelVisible)}
		>
			<Icon name="sidebarRight" size={16} />
		</button>
	</div>
</header>

<style>
	/* "N sessions require input": a gentle blink, off when the user asks for less motion. */
	.needs-input {
		animation: kg-attention 2s ease-in-out infinite;
	}
	@keyframes kg-attention {
		50% {
			opacity: 0.55;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.needs-input {
			animation: none;
		}
	}
</style>
