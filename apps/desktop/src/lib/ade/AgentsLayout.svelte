<script lang="ts">
	// Agents layout body (VS Code's Agents window): sessions side bar | the active session (task
	// timeline and follow-ups) | changes panel (the task's review: files, commit, PR, merge).
	import Icon from '#lib/workbench/Icon.svelte';
	import Sash from '#lib/workbench/Sash.svelte';
	import { SIDEBAR_MIN } from '#lib/workbench/layout.svelte.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import AgentsView from './AgentsView.svelte';
	import TaskPage from './TaskPage.svelte';
	import { newSession } from './agentsMode.svelte';
	import { adeTasks } from './tasks.svelte';
	import { BUTTON } from './ui';

	let body: HTMLDivElement | undefined = $state();
	const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
	const maxSide = () => (body?.clientWidth ?? 1200) * 0.45;
	const slug = $derived(appMode.activeSession && adeTasks.find(appMode.activeSession) ? appMode.activeSession : null);
</script>

<div bind:this={body} class="flex min-h-0 flex-1 bg-(--vscode-agentsBackground) text-(--vscode-foreground)">
	{#if appMode.sessionsVisible}
		<aside aria-label="Sessions" class="flex shrink-0 flex-col bg-(--vscode-agentsBackground)" style:width="{appMode.sessionsWidth}px">
			<div class="flex h-(--kg-part-title-height) shrink-0 items-center pl-4 text-[11px] text-(--vscode-sideBarTitle-foreground) uppercase">Sessions</div>
			{#key workspace.root}
				<AgentsView filter={appMode.filter} onClearFilter={() => (appMode.filter = 'all')} />
			{/key}
		</aside>
		<Sash
			orientation="vertical"
			onDrag={(d) => (appMode.sessionsWidth = clamp(appMode.sessionsWidth + d, SIDEBAR_MIN, maxSide()))}
			onReset={() => (appMode.sessionsWidth = 300)}
		/>
	{/if}

	<main class="min-w-0 flex-1 overflow-hidden border-x border-(--vscode-widget-border) bg-(--vscode-editor-background)">
		{#if slug}
			{#key slug}<TaskPage {slug} sections="timeline" />{/key}
		{:else}
			<div class="grid h-full place-items-center p-6 text-center text-sm text-(--vscode-descriptionForeground)">
				<div class="space-y-3">
					<Icon name="agent" size={32} stroke={1.2} />
					<p>{workspace.root ? 'เลือก session จากรายการ หรือเริ่มงานใหม่ให้ agent' : 'เปิดโฟลเดอร์ที่เป็น git repository ก่อน'}</p>
					{#if workspace.root}<button class={BUTTON} onclick={newSession}><Icon name="plus" size={14} /> New Session</button>{/if}
				</div>
			</div>
		{/if}
	</main>

	{#if appMode.panelVisible && slug}
		<Sash
			orientation="vertical"
			onDrag={(d) => (appMode.panelWidth = clamp(appMode.panelWidth - d, 280, maxSide()))}
			onReset={() => (appMode.panelWidth = 420)}
		/>
		<aside aria-label="Changes" class="shrink-0 overflow-hidden" style:width="{appMode.panelWidth}px">
			{#key slug}<TaskPage {slug} sections="review" />{/key}
		</aside>
	{/if}
</div>
