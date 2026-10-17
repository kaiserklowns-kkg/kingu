<script lang="ts">
	// Agents layout body, laid out like Orca: side bar (search, Tasks, Projects → worktrees) | the
	// selected worktree's active tab (the agent session, the new-task composer for the folder
	// itself, a terminal in that worktree, or a file / task diff opened from the right side bar;
	// Tasks shows the board) | right side bar (Files or Changes of that worktree). Terminals stay
	// mounted while hidden so their shells keep running; a file tab's editor mounts when shown.
	import Icon from '#lib/workbench/Icon.svelte';
	import Sash from '#lib/workbench/Sash.svelte';
	import ScmView from '#lib/workbench/ScmView.svelte';
	import DiffHost from '#lib/workbench/DiffHost.svelte';
	import AdeEditor from './AdeEditor.svelte';
	import { keyOfTabId } from './adeTabs.ts';
	import { SIDEBAR_MIN } from '#lib/workbench/layout.svelte.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { isDiffKey } from '#lib/workbench/scm.ts';
	import Terminal from '#lib/terminal/Terminal.svelte';
	import Composer from '#lib/agent/Composer.svelte';
	import { taskTitleFromPrompt } from '#lib/agent/composerText.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import AdeSidebar from './AdeSidebar.svelte';
	import AdeTabBar from './AdeTabBar.svelte';
	import type { IconName } from '#lib/workbench/Icon.svelte';
	import Board from './Board.svelte';
	import TaskPage from './TaskPage.svelte';
	import WorktreeFiles from './WorktreeFiles.svelte';
	import { adeLayout, PRIMARY, type RightTab } from './adeLayout.svelte';
	import { adeTasks } from './tasks.svelte';
	import { untrack } from 'svelte';
	import { cliName, cliOf, cliResume, type RunMode } from './agentCli';
	import { cliSessions } from './cliSessions.svelte';
	import { BUTTON, BUTTON_SECONDARY } from './ui';

	let body: HTMLDivElement | undefined = $state();
	const RIGHT_TABS: { id: RightTab; label: string; icon: IconName }[] = [
		{ id: 'files', label: 'Files', icon: 'files' },
		{ id: 'changes', label: 'Changes', icon: 'git' }
	];
	const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
	const maxSide = () => (body?.clientWidth ?? 1200) * 0.45;
	const key = $derived(adeLayout.key);
	const slug = $derived(key && adeTasks.find(key) ? key : null);
	const activeTab = $derived(adeLayout.activeTab(key));
	const activeFile = $derived(keyOfTabId(activeTab));
	/** The selected task runs its agent CLI in a terminal (the Orca way). */
	const cli = $derived(slug ? cliOf(adeTasks.find(slug)?.meta.agent ?? '') : null);
	const resume = $derived(cli ? cliResume(cli) : null);

	// The folder's "new task" composer (Orca: a new worktree with an agent).
	let draft = $state('');
	let base = $state('');
	let busy = $state(false);
	let focusKey = $derived(appMode.composeRequest);
	const model = $derived(settings.get<string>('kingu.agent.model') ?? '');
	const cliSetting = $derived(settings.get<string>('kingu.agent.cli') ?? '');
	let mode = $state<RunMode>(untrack(() => (settings.get<string>('kingu.agent.runMode') === 'timeline' ? 'timeline' : 'terminal')));

	$effect(() => {
		if (!workspace.root || slug) return;
		void adeTasks.refreshBranches().then(() => {
			if (!base || !adeTasks.branches.includes(base)) base = status.branch && adeTasks.branches.includes(status.branch) ? status.branch : (adeTasks.branches[0] ?? '');
		});
	});

	// A removed task's terminals close with it.
	$effect(() => {
		if (!adeTasks.loaded) return;
		for (const k of new Set([...Object.keys(adeLayout.terminals), ...Object.keys(adeLayout.files)])) if (k !== PRIMARY && !adeTasks.find(k)) adeLayout.drop(k);
	});

	// Another folder: the old folder's file tabs close, like the IDE's editors.
	let lastRoot = untrack(() => workspace.root);
	$effect(() => {
		const root = workspace.root;
		if (root !== lastRoot) untrack(() => adeLayout.closeAllFiles());
		lastRoot = root;
	});

	async function start(text: string) {
		busy = true;
		try {
			const created = await adeTasks.create({ title: taskTitleFromPrompt(text), prompt: text, base, mode });
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

	<main class="flex min-w-0 flex-1 flex-col overflow-hidden">
		<AdeTabBar />
		<div class="relative min-h-0 flex-1">
		{#if adeLayout.board}
			<Board />
		{:else if activeFile !== null}
			{#if isDiffKey(activeFile)}
				<div class="absolute inset-0">
					<DiffHost active={activeFile} onfail={(k) => adeLayout.closeFile(key, k)} />
				</div>
			{:else}
				{#key activeFile}
					<div class="absolute inset-0">
						<AdeEditor
							path={activeFile}
							onedit={() => adeLayout.pin(key, activeFile)}
							onfail={(e) => (status.flash(`เปิดไฟล์ไม่ได้: ${e}`), adeLayout.closeFile(key, activeFile))}
						/>
					</div>
				{/key}
			{/if}
		{:else if activeTab === 'main'}
			{#if slug && cli}
				{#if !cliSessions.has(slug)}
					<!-- After a restart the CLI is not running: continue its session or start fresh (never on its own). -->
					<div class="grid h-full place-items-center p-6">
						<div class="max-w-md space-y-3 text-center">
							<div class="flex justify-center text-(--vscode-descriptionForeground)"><Icon name="terminal" size={28} stroke={1.3} /></div>
							<p>{cliName(cli)} ของงานนี้ไม่ได้รันอยู่</p>
							<p class="text-xs text-(--vscode-descriptionForeground)">งานรันใน terminal ของ worktree <span class="font-mono">kingu/{slug}</span></p>
							<div class="flex justify-center gap-2">
								{#if resume}<button class={BUTTON} onclick={() => adeTasks.resumeCli(slug)}>ทำงานต่อ ({resume.join(' ')})</button>{/if}
								<button class={resume ? BUTTON_SECONDARY : BUTTON} onclick={() => adeTasks.resumeCli(slug, true)}>เริ่ม {cli.join(' ')} ใหม่</button>
							</div>
						</div>
					</div>
				{/if}
			{:else if slug}
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
										<label class="inline-flex shrink-0 items-center gap-1 rounded-sm border border-(--vscode-widget-border) px-1.5 py-0.5 hover:bg-(--vscode-toolbar-hoverBackground)" title="วิธีรัน agent">
											<Icon name={mode === 'terminal' ? 'terminal' : 'agent'} size={12} />
											<span class="sr-only">วิธีรัน agent</span>
											<select class="bg-transparent outline-none focus-visible:outline-none" bind:value={mode} disabled={busy}>
												<option value="terminal">Terminal · {cliSetting || 'claude'}</option>
												<option value="timeline">Timeline</option>
											</select>
										</label>
										<label class="inline-flex shrink-0 items-center gap-1 rounded-sm border border-(--vscode-widget-border) px-1.5 py-0.5 hover:bg-(--vscode-toolbar-hoverBackground)" title="แตกจาก branch">
											<Icon name="branch" size={12} />
											<span class="sr-only">แตกจาก branch</span>
											<select class="max-w-48 bg-transparent outline-none focus-visible:outline-none" bind:value={base} disabled={busy}>
												{#each adeTasks.branches as b (b)}<option value={b}>{b}</option>{/each}
												{#if !adeTasks.branches.length}<option value="">HEAD</option>{/if}
											</select>
										</label>
										{#if mode === 'timeline'}<span class="truncate">{model}</span>{/if}
									{/snippet}
								</Composer>
							{/key}
							<p class="text-xs text-(--vscode-descriptionForeground)">สร้าง worktree ใหม่บน branch <span class="font-mono">kingu/…</span> แล้วเริ่ม {mode === 'terminal' ? `${cliSetting || 'claude'} ใน terminal ของ worktree` : 'agent (timeline)'} · Enter เพื่อเริ่ม · Shift+Enter ขึ้นบรรทัดใหม่</p>
						</div>
					{:else}
						<p class="text-sm text-(--vscode-descriptionForeground)">เปิดโฟลเดอร์ที่เป็น git repository ก่อน</p>
					{/if}
				</div>
			{/if}
		{/if}
		<!-- Agent CLIs (each task's main tab when it runs the Orca way), then every worktree's terminals. -->
		{#each Object.entries(cliSessions.sessions) as [s, sess] (s + sess.startedAt)}
			<div class={['absolute inset-0 bg-(--vscode-terminal-background,var(--vscode-panel-background))', (adeLayout.board || s !== key || activeTab !== 'main') && 'hidden']}>
				<Terminal slug={s} run={sess.run} onoutput={() => cliSessions.output(s)} />
			</div>
		{/each}
		{#each Object.entries(adeLayout.terminals) as [k, list] (k)}
			{#each list as t (t.id)}
				<div class={['absolute inset-0 bg-(--vscode-terminal-background,var(--vscode-panel-background))', (adeLayout.board || k !== key || activeTab !== t.id) && 'hidden']}>
					<Terminal slug={k || undefined} run={t.run} />
				</div>
			{/each}
		{/each}
		</div>
	</main>

	{#if appMode.panelVisible}
		<Sash
			orientation="vertical"
			onDrag={(d) => (appMode.panelWidth = clamp(appMode.panelWidth - d, 260, maxSide()))}
			onReset={() => (appMode.panelWidth = 360)}
		/>
		<aside aria-label={adeLayout.rightTab === 'files' ? 'Files' : 'Changes'} class="flex shrink-0 flex-col overflow-hidden border-l border-(--vscode-sideBar-border) bg-(--vscode-sideBar-background)" style:width="{appMode.panelWidth}px">
			<!-- Orca's right side bar tabs. -->
			<div class="flex h-[35px] shrink-0 items-stretch gap-0.5 border-b border-(--vscode-sideBar-border) px-1.5" role="tablist" aria-label="Right Side Bar">
				{#each RIGHT_TABS as t (t.id)}
					{@const on = adeLayout.rightTab === t.id}
					<button
						role="tab"
						aria-selected={on}
						class={['relative flex items-center gap-1.5 px-2 text-[13px]', on ? 'text-(--vscode-foreground)' : 'text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)']}
						title={t.label}
						onclick={() => (adeLayout.rightTab = t.id)}
					>
						<Icon name={t.icon} size={15} />{t.label}
						{#if on}<span class="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-(--vscode-focusBorder)"></span>{/if}
					</button>
				{/each}
				<span class="flex-1"></span>
				<button class="my-auto grid size-6 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="ซ่อน side bar ขวา" title="ซ่อน (⌥⌘B)" onclick={() => (appMode.panelVisible = false)}>
					<Icon name="close" size={14} />
				</button>
			</div>
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
