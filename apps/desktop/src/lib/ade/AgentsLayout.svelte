<script lang="ts">
	// Agents layout body, laid out like Orca: side bar (search, Tasks, Projects → worktrees) | the
	// selected worktree's active tab (the agent session, the new-task composer for the folder
	// itself, a terminal in that worktree, or a file / task diff opened from the right side bar;
	// Tasks shows the board) | right side bar (Files or Changes of that worktree). Terminals stay
	// mounted while hidden so their shells keep running; a file tab's editor mounts when shown.
	import Icon from '#lib/workbench/Icon.svelte';
	import Sash from '#lib/workbench/Sash.svelte';
	import DiffHost from '#lib/workbench/DiffHost.svelte';
	import AdeEditor from './AdeEditor.svelte';
	import { keyOfTabId } from './adeTabs.ts';
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
	import AdeSourceControl from './AdeSourceControl.svelte';
	import AdeChecks from './AdeChecks.svelte';
	import AdeAgentsPanel from './AdeAgentsPanel.svelte';
	import { adeLayout, PRIMARY, type RightTab } from './adeLayout.svelte';
	import { adeTasks } from './tasks.svelte';
	import { untrack } from 'svelte';
	import { commands } from '#lib/workbench/commands.svelte.ts';
	import { cliName, cliOf, cliResume, type RunMode } from './agentCli';
	import { cliSessions } from './cliSessions.svelte';
	import { BUTTON, BUTTON_SECONDARY, STATUS_DOT } from './ui';
	import { STATUS_LABEL, timeAgo } from './model';

	let body: HTMLDivElement | undefined = $state();
	const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
	// Orca's right side bar shortcuts in the Agents layout: ⌘L toggles it, ⇧⌘E / ⇧⌘G open a tab.
	$effect(() => {
		const open = (tab: RightTab) => ((adeLayout.rightTab = tab), (appMode.panelVisible = true));
		const off = untrack(() => [
			commands.register({ id: 'kingu.agents.toggleRightSidebar', title: 'Toggle Right Sidebar', category: 'Agents', key: 'cmd+l', when: () => appMode.isAgents, run: () => (appMode.panelVisible = !appMode.panelVisible) }),
			commands.register({ id: 'kingu.agents.showExplorer', title: 'Show Explorer', category: 'Agents', key: 'cmd+shift+e', when: () => appMode.isAgents, run: () => open('files') }),
			commands.register({ id: 'kingu.agents.showSourceControl', title: 'Show Source Control', category: 'Agents', key: 'cmd+shift+g', when: () => appMode.isAgents, run: () => open('changes') })
		]);
		return () => off.forEach((u) => u());
	});
	const maxSide = () => (body?.clientWidth ?? 1200) * 0.45;
	const key = $derived(adeLayout.key);
	const slug = $derived(key && adeTasks.find(key) ? key : null);
	// Orca's right side bar tabs: icon only, the title and shortcut in the tooltip. Review (accept,
	// merge, PR) is Kingu's own and only exists for a task.
	const RIGHT_TABS = $derived<{ id: RightTab; label: string; icon: IconName; key?: string }[]>([
		{ id: 'files', label: 'Explorer', icon: 'files', key: '⇧⌘E' },
		{ id: 'agents', label: 'Agents', icon: 'agentsLayout' },
		{ id: 'changes', label: 'Source Control', icon: 'git', key: '⇧⌘G' },
		{ id: 'checks', label: 'Checks', icon: 'listChecks' },
		...(slug ? [{ id: 'review' as const, label: 'Review', icon: 'pullRequest' as const }] : [])
	]);
	const rightTab = $derived(adeLayout.rightTab === 'review' && !slug ? 'changes' : adeLayout.rightTab);
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

	// The empty composer's helpers: starters fill the prompt (they never start a task), recent tasks reopen one.
	const STARTERS: { icon: IconName; label: string; text: string }[] = [
		{ icon: 'bug', label: 'แก้บั๊ก', text: 'แก้บั๊ก: ' },
		{ icon: 'check', label: 'เขียน test', text: 'เขียน test ให้ ' },
		{ icon: 'code', label: 'เพิ่มฟีเจอร์', text: 'เพิ่มฟีเจอร์ ' },
		{ icon: 'refresh', label: 'Refactor', text: 'Refactor ' }
	];
	const recent = $derived([...adeTasks.views].sort((a, b) => b.meta.updated_at - a.meta.updated_at).slice(0, 4));
	let nudge = $state(0);
	function starter(text: string) {
		draft = draft.trim() ? `${text}${draft}` : text;
		nudge++; // remounts the composer, which autofocuses
	}

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
	// VS Code's modern layout: each part is a softly rounded pane on the title bar's color, 4px apart.
	const FRAME = 'min-h-0 overflow-hidden rounded-[8px] border border-(--vscode-widget-border)';
</script>

<div bind:this={body} class="relative flex min-h-0 flex-1 bg-(--vscode-titleBar-activeBackground) px-[4px] pb-[4px] text-(--vscode-foreground)">
	{#if appMode.sessionsVisible}
		<aside aria-label="Side Bar" class={[FRAME, 'flex shrink-0 flex-col bg-(--vscode-sideBar-background)']} style:width="{appMode.sessionsWidth}px">
			{#key workspace.root}<AdeSidebar />{/key}
		</aside>
		<Sash
				gap
			orientation="vertical"
			onDrag={(d) => (appMode.sessionsWidth = clamp(appMode.sessionsWidth + d, 220, Math.min(500, maxSide())))}
			onReset={() => (appMode.sessionsWidth = 280)}
		/>
	{/if}

	<main class={[FRAME, 'flex min-w-0 flex-1 flex-col bg-(--vscode-editor-background)']}>
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
							onfail={(e) => (status.error(`เปิดไฟล์ไม่ได้: ${e}`), adeLayout.closeFile(key, activeFile))}
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
							<div class="flex justify-center text-(--vscode-descriptionForeground)"><Icon name="terminal" size={28} /></div>
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
							<div class="mb-5 flex flex-col items-center gap-2 text-center">
								<Icon name="agent" size={44} />
								<h1 class="text-lg font-semibold text-(--vscode-foreground)">อยากให้ Arkai ทำอะไร</h1>
								<p class="text-[13px] text-(--vscode-descriptionForeground)">แต่ละงานได้ worktree ของตัวเอง ทำหลายงานพร้อมกันได้โดยไม่ชนกัน</p>
							</div>
							{#key `${focusKey}:${nudge}`}
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
							<div class="flex flex-wrap gap-1.5">
								{#each STARTERS as s (s.label)}
									<button class="flex h-7 items-center gap-1.5 rounded-full border border-(--vscode-widget-border) px-3 text-xs text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)" disabled={busy} onclick={() => starter(s.text)}>
										<Icon name={s.icon} size={13} />{s.label}
									</button>
								{/each}
							</div>
							<p class="text-xs text-(--vscode-descriptionForeground)">สร้าง worktree ใหม่บน branch <span class="font-mono">kingu/…</span> แล้วเริ่ม {mode === 'terminal' ? `${cliSetting || 'claude'} ใน terminal ของ worktree` : 'agent (timeline)'} · Enter เพื่อเริ่ม · Shift+Enter ขึ้นบรรทัดใหม่</p>
							{#if recent.length}
								<section class="pt-5" aria-label="งานล่าสุด">
									<h2 class="mb-2 text-xs font-medium text-(--vscode-descriptionForeground)">งานล่าสุด</h2>
									<div class="grid grid-cols-2 gap-2">
										{#each recent as v (v.meta.slug)}
											<button class="min-w-0 rounded-lg border border-(--vscode-widget-border) px-3 py-2.5 text-left hover:bg-(--vscode-list-hoverBackground)" onclick={() => adeLayout.show(v.meta.slug)}>
												<span class="flex items-center gap-2">
													<span class={['size-2 shrink-0 rounded-full', STATUS_DOT[v.status]]} title={STATUS_LABEL[v.status]}></span>
													<span class="min-w-0 flex-1 truncate text-[13px]">{v.meta.title}</span>
												</span>
												<span class="mt-1 flex gap-2 pl-4 text-xs text-(--vscode-descriptionForeground)">
													<span class="min-w-0 flex-1 truncate font-mono">kingu/{v.meta.slug}</span>
													<span class="shrink-0">{timeAgo(v.meta.updated_at, adeTasks.now)}</span>
												</span>
											</button>
										{/each}
									</div>
								</section>
							{/if}
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
				gap
			orientation="vertical"
			onDrag={(d) => (appMode.panelWidth = clamp(appMode.panelWidth - d, 220, Math.max(220, window.innerWidth - 320)))}
			onReset={() => (appMode.panelWidth = 350)}
		/>
		<aside aria-label={RIGHT_TABS.find((t) => t.id === rightTab)?.label} class={[FRAME, 'flex shrink-0 flex-col bg-(--vscode-sideBar-background)']} style:width="{appMode.panelWidth}px">
			<!-- Orca's right side bar header: 36px, icon tabs with an underline (the title bar holds the toggle). -->
			<div class="flex h-[36px] min-h-[36px] shrink-0 items-center overflow-hidden border-b border-(--vscode-widget-border)">
				<div class="flex min-w-0 flex-1 items-center overflow-hidden pl-2" role="tablist" aria-label="Right Side Bar">
					{#each RIGHT_TABS as t (t.id)}
						{@const on = rightTab === t.id}
						<button
							role="tab"
							aria-selected={on}
							aria-label={t.label}
							title={t.key ? `${t.label} (${t.key})` : t.label}
							class={['relative flex h-[36px] w-9 shrink-0 items-center justify-center transition-colors', on ? 'text-(--vscode-foreground)' : 'text-(--vscode-descriptionForeground)/60 hover:text-(--vscode-descriptionForeground)']}
							onclick={() => (adeLayout.rightTab = t.id)}
						>
							<Icon name={t.icon} size={16} filled={on} />
							{#if on}<span class="absolute right-[25%] bottom-0 left-[25%] h-[2px] rounded-t bg-(--vscode-foreground)"></span>{/if}
						</button>
					{/each}
				</div>
			</div>
			{#if rightTab === 'files'}
				{#if workspace.root}{#key key}<WorktreeFiles slug={slug ?? ''} />{/key}{/if}
			{:else if rightTab === 'changes'}
				{#key key}<AdeSourceControl slug={slug ?? ''} />{/key}
			{:else if rightTab === 'agents'}
				<AdeAgentsPanel slug={slug ?? ''} />
			{:else if rightTab === 'checks'}
				{#key key}<AdeChecks slug={slug ?? ''} />{/key}
			{:else if slug}
				{#key slug}<TaskPage {slug} sections="review" />{/key}
			{/if}
		</aside>
	{/if}
</div>
