<script lang="ts">
	// Agents layout title bar (VS Code's Agents window title bar): 44px (35px compact) on
	// `agentsBackground`. Left: sessions side bar toggle, New Session while it is hidden.
	// Center `[1fr auto 1fr]`: session back/forward, the session pill (workspace · branch, or
	// "N sessions require input"), Open in Editor and Commit. Right: changes panel, account + cost.
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '#lib/workbench/Icon.svelte';
	import { commands, keyOf } from '#lib/workbench/commands.svelte.ts';
	import { isMac, keyLabel } from '#lib/workbench/keys.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { sessionsAttentionLabel, titleBarHeight } from '#lib/workbench/titlebar.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { team } from '#lib/team/team.svelte.ts';
	import { newSession, openEditor, pickSession } from './agentsMode.svelte';
	import { runtime } from './runtime.svelte';
	import { adeTasks } from './tasks.svelte';

	let { focused }: { focused: boolean } = $props();

	const hint = (command: string) => {
		const cmd = commands.get(command);
		const k = cmd && keyOf(cmd);
		return k ? ` (${keyLabel(k)})` : '';
	};

	const height = $derived(titleBarHeight('agents', { commandCenter: true, compactAgents: settings.get<string>('kingu.agentsLayout.density') === 'compact' }));
	$effect(() => document.documentElement.style.setProperty('--kg-titlebar-height', `${height}px`));

	const view = $derived(appMode.activeSession ? adeTasks.find(appMode.activeSession) : undefined);
	const attention = $derived(sessionsAttentionLabel(adeTasks.counts.needsInput));
	const branch = $derived(view ? `kingu/${view.meta.slug}` : status.branch);
	const canCommit = $derived(!!view?.stat?.dirty && !view.runtime?.working);

	/** Cost of this folder's sessions (the live run's cumulative result, else the saved last run). */
	const cost = $derived(
		adeTasks.views.reduce((sum, v) => sum + (runtime.run(v.meta.slug)?.result?.total_cost_usd ?? v.meta.last_run?.cost_usd ?? 0), 0)
	);
	const accountTitle = $derived(`${team.label?.tooltip ?? 'ทีม: ยังไม่ได้ตั้งค่า (kingu.team.serverUrl)'}\nค่าใช้จ่าย agent ในโฟลเดอร์นี้: $${cost.toFixed(2)}`);

	/** Commit…: the changes panel with its commit message focused. */
	function commit() {
		appMode.panelVisible = true;
		const slug = view?.meta.slug;
		if (slug) setTimeout(() => document.getElementById(`commit-${slug}`)?.focus());
	}

	const onBarItself = (e: MouseEvent) => !(e.target as Element).closest('button, a, input');
	function onMouseUp(e: MouseEvent) {
		if (!isMac || e.button !== 0 || e.detail !== 2 || !onBarItself(e)) return;
		e.stopPropagation();
		void invoke('window_titlebar_double_click').catch(() => {});
	}

	const ACTION = 'grid size-6 shrink-0 place-items-center rounded-[5px] enabled:hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
	const TEXT_ACTION = 'flex h-[22px] shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-xs whitespace-nowrap enabled:hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (double-click zoom is a pointer convenience, like the native title bar) -->
<header
	data-tauri-drag-region="deep"
	onmouseup={onMouseUp}
	style:height="{height}px"
	class={[
		'agents-titlebar relative flex shrink-0 items-center gap-1 border-b border-(--vscode-titleBar-border) bg-(--vscode-agentsBackground) pr-1.5 text-(--vscode-foreground) select-none',
		!focused && 'inactive [&>*]:opacity-60'
	]}
>
	<div class="flex h-full shrink-0 items-center gap-0.5">
		{#if isMac}
			<div class="h-full w-[70px] shrink-0"></div>
		{:else}
			<div class="grid h-full w-[35px] shrink-0 place-items-center" aria-hidden="true"><Icon name="kingu" size={16} /></div>
		{/if}
		<button
			class={ACTION}
			aria-label="Toggle Sessions Side Bar"
			aria-pressed={appMode.sessionsVisible}
			title="Toggle Sessions Side Bar{hint('workbench.action.toggleSidebarVisibility')}"
			onclick={() => (appMode.sessionsVisible = !appMode.sessionsVisible)}
		>
			<Icon name="sidebarLeft" size={16} />
		</button>
		{#if !appMode.sessionsVisible}
			<button class={ACTION} aria-label="New Session" title="New Session" disabled={!workspace.root} onclick={newSession}><Icon name="plus" size={16} /></button>
		{/if}
	</div>

	<div class="grid h-full min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1">
		<div class="flex min-w-0 justify-end gap-0.5">
			<button class={ACTION} aria-label="Previous Session" title="Previous Session" disabled={!appMode.canGoBack} onclick={() => appMode.back()}><Icon name="arrowLeft" size={16} /></button>
			<button class={ACTION} aria-label="Next Session" title="Next Session" disabled={!appMode.canGoForward} onclick={() => appMode.forward()}><Icon name="arrowRight" size={16} /></button>
		</div>

		<button
			class={[
				'agent-sessions-titlebar-pill flex h-[22px] w-[min(600px,31vw)] min-w-0 items-center justify-center gap-1.5 rounded-md border border-transparent bg-transparent px-2 text-xs hover:border-(--vscode-commandCenter-border) hover:bg-(--vscode-commandCenter-activeBackground)',
				attention && 'needs-input text-(--vscode-editorWarning-foreground)'
			]}
			title={attention ? `${attention} — เลือก session` : `สลับ session${hint('kingu.agents.pickSession')}`}
			aria-label={attention ?? `Session: ${view?.meta.title ?? workspace.name}`}
			onclick={pickSession}
		>
			{#if attention}
				<span class="size-2 shrink-0 rounded-full bg-(--vscode-editorWarning-foreground)"></span>
				<span class="truncate">{attention}</span>
			{:else}
				<span class="flex min-w-0 items-center gap-1.5 opacity-60">
					<span class="shrink-0"><Icon name="folder" size={14} /></span>
					<span class="truncate">{workspace.name || 'ไม่มีโฟลเดอร์'}</span>
					{#if view}<span class="truncate">· {view.meta.title}</span>{/if}
					{#if branch}
						<span class="shrink-0"><Icon name="branch" size={14} /></span>
						<span class="truncate font-mono">{branch}</span>
					{/if}
				</span>
			{/if}
		</button>

		<div class="flex min-w-0 justify-start gap-0.5">
			<button class={TEXT_ACTION} title="Open in Editor{hint('workbench.action.toggleAgentsMode')}" onclick={openEditor}>
				<Icon name="code" size={14} /> Open in Editor
			</button>
			{#if view?.stat?.dirty}
				<button class={TEXT_ACTION} disabled={!canCommit} title="Commit การเปลี่ยนแปลงใน kingu/{view.meta.slug}" onclick={commit}>
					<Icon name="commit" size={14} /> Commit
				</button>
			{/if}
		</div>
	</div>

	<div class="flex h-full shrink-0 items-center gap-1">
		<button
			class={ACTION}
			aria-label="Toggle Changes Panel"
			aria-pressed={appMode.panelVisible}
			title="Toggle Changes Panel{hint('workbench.action.togglePanel')}"
			onclick={() => (appMode.panelVisible = !appMode.panelVisible)}
		>
			<Icon name="sidebarRight" size={16} />
		</button>
		<button class="flex h-[22px] items-center gap-1 rounded-[5px] px-1.5 text-xs hover:bg-(--vscode-toolbar-hoverBackground)" title={accountTitle} aria-label={accountTitle} onclick={() => team.showMenu()}>
			<Icon name="account" size={16} />
			{#if cost > 0}<span class="tabular-nums opacity-80">${cost.toFixed(2)}</span>{/if}
			{#if team.status?.signed_in}<span class="size-1.5 rounded-full bg-(--vscode-activityBarBadge-background)"></span>{/if}
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
