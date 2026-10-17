<script lang="ts">
	// Agents layout body, laid out like Orca: side bar (search, Tasks, Projects → worktrees) | the
	// selected worktree's active tab (the agent session, the new-task composer for the folder
	// itself, or a terminal in that worktree; Tasks shows the board) | right side bar (Files or
	// Changes of that worktree). Terminals stay mounted while hidden so their shells keep running.
	import Icon from '#lib/workbench/Icon.svelte';
	import Sash from '#lib/workbench/Sash.svelte';
	import ScmView from '#lib/workbench/ScmView.svelte';
	import { SIDEBAR_MIN } from '#lib/workbench/layout.svelte.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import Terminal from '#lib/terminal/Terminal.svelte';
	import Composer from '#lib/agent/Composer.svelte';
	import { taskTitleFromPrompt } from '#lib/agent/composerText.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import AdeSidebar from './AdeSidebar.svelte';
	import Board from './Board.svelte';
	import TaskPage from './TaskPage.svelte';
	import WorktreeFiles from './WorktreeFiles.svelte';
	import { adeLayout, PRIMARY } from './adeLayout.svelte';
	import { adeTasks } from './tasks.svelte';

	let body: HTMLDivElement | undefined = $state();
	const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
	const maxSide = () => (body?.clientWidth ?? 1200) * 0.45;
	const key = $derived(adeLayout.key);
	const slug = $derived(key && adeTasks.find(key) ? key : null);
	const activeTab = $derived(adeLayout.activeTab(key));

	// The folder's "new task" composer (Orca: a new worktree with an agent).
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

	// A removed task's terminals close with it.
	$effect(() => {
		if (!adeTasks.loaded) return;
		for (const k of Object.keys(adeLayout.terminals)) if (k !== PRIMARY && !adeTasks.find(k)) adeLayout.drop(k);
	});

	async function start(text: string) {
		busy = true;
		try {
			const created = await adeTasks.create({ title: taskTitleFromPrompt(text), prompt: text, base });
			if (created) {
				draft = '';
				adeLayout.show(created);
			}
		} finally {
			busy = false;
		}
	}
</script>

<div bind:this={body} class="flex min-h-0 flex-1 bg-(--vscode-editor-background) text-(--vscode-foreground)">
	{#if appMode.sessionsVisible}
		<aside aria-label="Side Bar" class="flex shrink-0 flex-col border-r border-(--vscode-sideBar-border) bg-(--vscode-sideBar-background)" style:width="{appMode.sessionsWidth}px">
			{#key workspace.root}<AdeSidebar />{/key}
		</aside>
		<Sash
			orientation="vertical"
			onDrag={(d) => (appMode.sessionsWidth = clamp(appMode.sessionsWidth + d, SIDEBAR_MIN, maxSide()))}
			onReset={() => (appMode.sessionsWidth = 280)}
		/>
	{/if}

	<main class="relative min-w-0 flex-1 overflow-hidden">
		{#if adeLayout.board}
			<Board />
		{:else if activeTab === 'main'}
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
		{/if}
		<!-- Every worktree's terminals, the active one shown. -->
		{#each Object.entries(adeLayout.terminals) as [k, list] (k)}
			{#each list as t (t.id)}
				<div class={['absolute inset-0 bg-(--vscode-terminal-background,var(--vscode-panel-background))', (adeLayout.board || k !== key || activeTab !== t.id) && 'hidden']}>
					<Terminal slug={k || undefined} />
				</div>
			{/each}
		{/each}
	</main>

	{#if appMode.panelVisible}
		<Sash
			orientation="vertical"
			onDrag={(d) => (appMode.panelWidth = clamp(appMode.panelWidth - d, 260, maxSide()))}
			onReset={() => (appMode.panelWidth = 360)}
		/>
		<aside aria-label={adeLayout.rightTab === 'files' ? 'Files' : 'Changes'} class="flex shrink-0 flex-col overflow-hidden border-l border-(--vscode-sideBar-border) bg-(--vscode-sideBar-background)" style:width="{appMode.panelWidth}px">
			{#if adeLayout.rightTab === 'files'}
				{#if workspace.root}{#key key}<WorktreeFiles slug={slug ?? ''} />{/key}{/if}
			{:else if slug}
				{#key slug}<TaskPage {slug} sections="review" />{/key}
			{:else if workspace.root}
				<div class="flex min-h-0 flex-1 flex-col pt-2"><ScmView /></div>
			{/if}
		</aside>
	{/if}
</div>
