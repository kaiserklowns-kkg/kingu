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
	import { adeTasks } from './tasks.svelte';
	import Composer from '#lib/agent/Composer.svelte';
	import { taskTitleFromPrompt } from '#lib/agent/composerText.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';

	let body: HTMLDivElement | undefined = $state();
	const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
	const maxSide = () => (body?.clientWidth ?? 1200) * 0.45;
	const slug = $derived(appMode.activeSession && adeTasks.find(appMode.activeSession) ? appMode.activeSession : null);

	// The centred "new session" composer (VS Code's Agents window opens on a chat input).
	let draft = $state('');
	let base = $state('');
	let busy = $state(false);
	let focusKey = $derived(appMode.composeRequest);
	const model = $derived(settings.get<string>('kingu.agent.model') ?? '');

	$effect(() => {
		if (!workspace.root || slug) return;
		void adeTasks.refreshBranches().then(() => {
			if (!base || !adeTasks.branches.includes(base)) base = status.branch && adeTasks.branches.includes(status.branch) ? status.branch : (adeTasks.branches[0] ?? '');
		});
	});

	async function start(text: string) {
		busy = true;
		try {
			const created = await adeTasks.create({ title: taskTitleFromPrompt(text), prompt: text, base });
			if (created) {
				draft = '';
				appMode.openSession(created);
			}
		} finally {
			busy = false;
		}
	}
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
			<div class="grid h-full place-items-center p-6">
				{#if workspace.root}
					<div class="w-full max-w-[640px] space-y-3">
						<div class="flex items-center gap-2 text-(--vscode-descriptionForeground)">
							<Icon name="agent" size={20} stroke={1.4} />
							<h1 class="text-base font-medium text-(--vscode-foreground)">อยากให้ agent ทำอะไร</h1>
						</div>
						{#key focusKey}
							<Composer bind:value={draft} size="lg" autofocus placeholder="อธิบายงาน เช่น เพิ่มปุ่ม export รายงานเป็น CSV…" {busy} onsubmit={start}>
								{#snippet chips()}
									<label class="inline-flex shrink-0 items-center gap-1 rounded-sm border border-(--vscode-widget-border) px-1.5 py-0.5 hover:bg-(--vscode-toolbar-hoverBackground)" title="แตกจาก branch">
										<Icon name="branch" size={12} />
										<span class="sr-only">แตกจาก branch</span>
										<select class="max-w-48 bg-transparent outline-none focus-visible:outline-none" bind:value={base} disabled={busy}>
											{#each adeTasks.branches as b (b)}<option value={b}>{b}</option>{/each}
											{#if !adeTasks.branches.length}<option value="">HEAD</option>{/if}
										</select>
									</label>
									<span class="truncate">{model}</span>
								{/snippet}
							</Composer>
						{/key}
						<p class="text-xs text-(--vscode-descriptionForeground)">สร้าง worktree ใหม่บน branch <span class="font-mono">kingu/…</span> แล้วเริ่ม agent · Enter เพื่อเริ่ม · Shift+Enter ขึ้นบรรทัดใหม่</p>
					</div>
				{:else}
					<p class="text-sm text-(--vscode-descriptionForeground)">เปิดโฟลเดอร์ที่เป็น git repository ก่อน</p>
				{/if}
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
