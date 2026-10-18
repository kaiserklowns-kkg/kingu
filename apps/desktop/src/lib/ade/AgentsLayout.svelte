<script lang="ts">
	import type { Attachment } from '#lib/agent/attachments.ts';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	// Agents layout body, laid out like Orca: side bar (search, Tasks, Projects → worktrees) | the
	// selected worktree's active tab (the agent session, the new-task composer for the folder
	// itself, a terminal in that worktree, or a file / task diff opened from the right side bar;
	// Tasks shows the board, Automations its page) | right side bar (RightSidebar.svelte: Explorer, Agents, Source Control, Checks of that worktree). Terminals stay
	// mounted while hidden so their shells keep running; a file tab's editor mounts when shown.
	import Icon from '#lib/workbench/Icon.svelte';
	import Sash from '#lib/workbench/Sash.svelte';
	import DiffHost from '#lib/workbench/DiffHost.svelte';
	import AdeEditor from './AdeEditor.svelte';
	import { keyOfTabId } from './adeTabs.ts';
	import { SIDEBAR_MIN } from '#lib/workbench/layout.svelte.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { isDiffKey } from '#lib/workbench/scm.ts';
	import Terminal from '#lib/terminal/Terminal.svelte';
	import PaneSplitView from '#lib/terminal/PaneSplitView.svelte';
	import { leaf } from '#lib/terminal/paneLayout.ts';
	import { keyLabel, keyOf } from '#lib/workbench/keys.ts';
	import { tabPanes } from './adeTabs.ts';
	import { ADE_SHORTCUTS } from './adeShortcuts.ts';
	import RecentTabSwitcher from './RecentTabSwitcher.svelte';
	import Composer from '#lib/agent/Composer.svelte';
	import { taskTitleFromPrompt } from '#lib/agent/composerText.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import AdeSidebar from './AdeSidebar.svelte';
	import AdeTabBar from './AdeTabBar.svelte';
	import type { IconName } from '#lib/workbench/Icon.svelte';
	import Board from './Board.svelte';
	import AutomationsPage from './AutomationsPage.svelte';
	import IssuesPage from './IssuesPage.svelte';
	import TaskPage from './TaskPage.svelte';
	import RightSidebar from './RightSidebar.svelte';
	import { adeLayout, PRIMARY } from './adeLayout.svelte';
	import { adeTasks } from './tasks.svelte';
	import { recordQuickOpenVisit } from './quickOpen.svelte.ts';
	import { untrack } from 'svelte';
	import { cliName, cliOf, type RunMode } from './agentCli';
	import { profileOf } from '#lib/ade/agentProfiles.ts';
	import { cliSessions } from './cliSessions.svelte';
	import { BUTTON, BUTTON_SECONDARY, statusDot } from './ui';
	import { statusLabel, timeAgo } from './model';

	let body: HTMLDivElement | undefined = $state();
	const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
	const maxSide = () => (body?.clientWidth ?? 1200) * 0.45;
	const key = $derived(adeLayout.key);
	const slug = $derived(key && adeTasks.find(key) ? key : null);
	const activeTab = $derived(adeLayout.activeTab(key));
	const activeFile = $derived(keyOfTabId(activeTab));
	/** The selected task runs its agent CLI in a terminal (the Orca way). */
	const cli = $derived(slug ? cliOf(adeTasks.find(slug)?.meta.agent ?? '') : null);
	/** Resumes the task's own session when its id is saved, else the CLI's latest one, where the CLI can. */
	const resume = $derived(cli ? profileOf(cli).canResume : null);

	// The folder's "new task" composer (Orca: a new worktree with an agent).
	let draft = $state('');
	let draftFiles = $state<Attachment[]>([]);
	let base = $state('');
	let busy = $state(false);
	let focusKey = $derived(appMode.composeRequest);
	const model = $derived(settings.get<string>('kingu.agent.model') ?? '');
	const cliSetting = $derived(settings.get<string>('kingu.agent.cli') ?? '');
	let mode = $state<RunMode>(untrack(() => (settings.get<string>('kingu.agent.runMode') === 'timeline' ? 'timeline' : 'terminal')));

	$effect(() => {
		if (!workspace.root || slug) return;
		void adeTasks.refreshBranches().then(() => {
			if (!base || !adeTasks.branches.includes(base)) base = adeTasks.defaultBase();
		});
	});

	// A removed task's terminals and agent CLI close with it (also a task of the previous folder,
	// or one removed while the page was reloading).
	$effect(() => {
		if (!adeTasks.loaded) return;
		for (const k of new Set([...Object.keys(adeLayout.terminals), ...Object.keys(adeLayout.files)])) if (k !== PRIMARY && !adeTasks.find(k)) adeLayout.drop(k);
		for (const s of Object.keys(cliSessions.sessions)) if (!adeTasks.find(s)) untrack(() => cliSessions.end(s));
	});

	// A shown file tab is a visit: quick open lists it first next time (Orca's quick open history).
	$effect(() => {
		const file = activeFile;
		if (file !== null && !isDiffKey(file) && !adeLayout.board) untrack(() => recordQuickOpenVisit(key, file));
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

	async function start(text: string, attachments: Attachment[]) {
		busy = true;
		try {
			const created = await adeTasks.create({ title: taskTitleFromPrompt(text), prompt: text, base, mode, attachments });
			if (created) {
				draft = '';
				draftFiles = [];
				adeLayout.show(created);
			}
		} finally {
			busy = false;
		}
	}
	const FRAME = 'min-h-0 overflow-hidden rounded-[10px] border border-(--vscode-widget-border)';

	/** Shortcut labels in a pane's context menu (Orca shows them next to its items). */
	const label = (s: { key?: string; mac?: string }) => {
		const k = keyOf(s);
		return k ? keyLabel(k) : undefined;
	};
	const PANE_KEYS = {
		splitRight: label(ADE_SHORTCUTS.splitRight),
		splitDown: label(ADE_SHORTCUTS.splitDown),
		expand: label(ADE_SHORTCUTS.expandPane),
		rename: label(ADE_SHORTCUTS.rename),
		closePane: keyLabel('cmd+w')
	};

	/** A pane's context menu items beyond copy/paste/clear (Orca's TerminalContextMenu). */
	function paneAction(k: string, id: string, p: string, action: string) {
		adeLayout.focusPaneOf(k, id, p);
		if (action === 'splitRight') adeLayout.split(k, id, 'vertical');
		else if (action === 'splitDown') adeLayout.split(k, id, 'horizontal');
		else if (action === 'equalize') adeLayout.equalize(k, id);
		else if (action === 'expand') adeLayout.toggleExpand(k, id);
		else if (action === 'rename') void adeLayout.rename(k, id);
		else if (action === 'closePane') void adeLayout.closePane(k, id, p);
	}

	/** A followed file link opens in that worktree's editor tab, at its line (Orca's terminal file routing). */
	function openLinkedFile(k: string, rel: string, line?: number, column?: number) {
		adeLayout.openFile(k, rel, { preview: false, reveal: line ? { line, column: column ?? 1, focus: true } : undefined });
	}
</script>

<!-- Same framed parts as the IDE workbench: each zone has its own rounded frame, the sashes are the gaps. -->
<div bind:this={body} class="flex min-h-0 flex-1 bg-(--vscode-titleBar-activeBackground) px-1.5 pb-1.5 text-(--vscode-foreground)">
	{#if appMode.sessionsVisible}
		<aside aria-label="Side Bar" class={[FRAME, 'flex shrink-0 flex-col bg-(--vscode-sideBar-background)']} style:width="{appMode.sessionsWidth}px">
			{#key workspace.root}<AdeSidebar />{/key}
		</aside>
		<Sash
			orientation="vertical"
			onDrag={(d) => (appMode.sessionsWidth = clamp(appMode.sessionsWidth + d, SIDEBAR_MIN, maxSide()))}
			onReset={() => (appMode.sessionsWidth = 280)}
		/>
	{/if}

	<main class={[FRAME, 'flex min-w-0 flex-1 flex-col bg-(--vscode-editor-background)']}>
		<AdeTabBar />
		<div class="relative min-h-0 flex-1">
		<RecentTabSwitcher />
		{#if adeLayout.page === 'automations'}
			<AutomationsPage />
		{:else if adeLayout.page === 'issues'}
			<IssuesPage />
		{:else if adeLayout.board}
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
							onfail={(e) => (notifications.error(`เปิดไฟล์ไม่ได้: ${e}`), adeLayout.closeFile(key, activeFile))}
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
								{#if resume}<button class={BUTTON} onclick={() => adeTasks.resumeCli(slug)}>ทำงานต่อใน session เดิม</button>{/if}
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
								<Composer bind:value={draft} attach bind:attachments={draftFiles} size="lg" autofocus placeholder="อธิบายงาน เช่น เพิ่มปุ่ม export รายงานเป็น CSV…" {busy} onsubmit={start}>
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
													<span class={['size-2 shrink-0 rounded-full', statusDot(v)]} title={statusLabel(v)}></span>
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
				<Terminal
					key={cliSessions.ptyKey(s, sess.startedAt)}
					slug={s}
					run={cliSessions.runOf(s)}
					flavor="ade"
					menuState={() => ({ panes: false })}
					onoutput={() => cliSessions.output(s)}
					onopenfile={(rel, line, column) => openLinkedFile(s, rel, line, column)}
				/>
			</div>
		{/each}
		{#each Object.entries(adeLayout.terminals) as [k, list] (k)}
			{#each list as t (t.id)}
				<div class={['absolute inset-0 bg-(--vscode-terminal-background,var(--vscode-panel-background))', (adeLayout.board || k !== key || activeTab !== t.id) && 'hidden']}>
					<!-- Orca's pane splits: every pane is its own PTY (`t<n>` ids; the first pane's id is the tab's). -->
					<PaneSplitView tree={t.layout ?? leaf(t.id)} expanded={t.expanded ?? null} onresize={(path, ratio) => adeLayout.resizePane(k, t.id, path, ratio)}>
						{#snippet pane(p)}
							<Terminal
								key={adeLayout.ptyKey(k, p)}
								slug={k || undefined}
								run={p === t.id ? t.run : undefined}
								cwdFrom={adeLayout.cwdFrom(k, p)}
								flavor="ade"
								keyLabels={PANE_KEYS}
								menuState={() => ({ split: tabPanes(t).length > 1, expanded: !!t.expanded })}
								onfocus={() => adeLayout.focusPaneOf(k, t.id, p)}
								onaction={(a) => paneAction(k, t.id, p, a)}
								onopenfile={(rel, line, column) => openLinkedFile(k, rel, line, column)}
							/>
						{/snippet}
					</PaneSplitView>
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
		<aside aria-label="Right Side Bar" class={[FRAME, 'flex shrink-0 flex-col bg-(--vscode-sideBar-background)']} style:width="{appMode.panelWidth}px">
			{#if workspace.root}<RightSidebar key={slug ?? PRIMARY} />{/if}
		</aside>
	{/if}
</div>
