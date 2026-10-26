<script lang="ts">
	import type { Attachment } from '#lib/agent/attachments.ts';
	// Agents layout body, laid out like Orca: side bar (search, Tasks, Projects → worktrees) | the
	// selected worktree's active tab (the agent session, the new-task composer for the folder
	// itself, a terminal in that worktree, or a file / task diff opened from the right side bar;
	// Tasks shows the board, Automations its page) | right side bar (Explorer, Agents, Source Control, Checks and Review of that worktree). Terminals stay
	// mounted while hidden so their shells keep running; a file tab's editor mounts when shown.
	import Icon from '#lib/workbench/Icon.svelte';
	import Sash from '#lib/workbench/Sash.svelte';
	import DiffHost from '#lib/workbench/DiffHost.svelte';
	import AdeEditor from './AdeEditor.svelte';
	import MarkdownPreview from '#lib/workbench/MarkdownPreview.svelte';
	import { previewKey } from '#lib/workbench/viewers.ts';
	import AdeBrowser from './AdeBrowser.svelte';
	import FilePlaceholder from '#lib/workbench/FilePlaceholder.svelte';
	import SaveConflictCompare from '#lib/workbench/SaveConflictCompare.svelte';
	import { textFiles } from '#lib/workbench/textFileService.svelte.ts';
	import { keyOfTabId } from './adeTabs.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { isDiffKey } from '#lib/workbench/scm.ts';
	import Terminal from '#lib/terminal/Terminal.svelte';
	import PaneSplitView from '#lib/terminal/PaneSplitView.svelte';
	import { leaf } from '#lib/terminal/paneLayout.ts';
	import { keyLabel, keyOf } from '#lib/workbench/keys.ts';
	import { activePane, tabPanes } from './adeTabs.ts';
	import { ADE_SHORTCUTS } from './adeShortcuts.ts';
	import RecentTabSwitcher from './RecentTabSwitcher.svelte';
	import Composer from '#lib/agent/Composer.svelte';
	import { taskTitleFromPrompt } from '#lib/agent/composerText.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import AdeSidebar from './AdeSidebar.svelte';
	import { sidebarTint } from './sidebarView';
	import AdeTabBar from './AdeTabBar.svelte';
	import type { IconName } from '#lib/workbench/Icon.svelte';
	import Board from './Board.svelte';
	import NowPage from './NowPage.svelte';
	import AutomationsPage from './AutomationsPage.svelte';
	import IssuesPage from './IssuesPage.svelte';
	import TaskPage from './TaskPage.svelte';
	import CliQuestion from './CliQuestion.svelte';
	import WorktreeFiles from './WorktreeFiles.svelte';
	import AdeSourceControl from './AdeSourceControl.svelte';
	import AdeChecks from './AdeChecks.svelte';
	import AdeAgentsPanel from './AdeAgentsPanel.svelte';
	import AdePortsPanel from './AdePortsPanel.svelte';
	import { adeLayout, PRIMARY } from './adeLayout.svelte';
	import { rightSidebar } from './rightSidebar.svelte.ts';
	import { adeTasks } from './tasks.svelte';
	import { mayPruneSessions } from './agentGuard';
	import { recordQuickOpenVisit } from './quickOpen.svelte.ts';
	import { untrack } from 'svelte';
	import { cliName, cliOf } from './agentCli';
	import { profileOf } from '#lib/ade/agentProfiles.ts';
	import { cliSessions } from './cliSessions.svelte';
	import { paneAgents } from './paneAgents.svelte';
	import { terminalBells } from './terminalBell.svelte';
	import { BUTTON, BUTTON_SECONDARY, statusDot } from './ui';
	import { statusLabel, timeAgo } from './model';
	import { t } from '#lib/i18n/index.ts';

	let body: HTMLDivElement | undefined = $state();
	const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
	const maxSide = () => (body?.clientWidth ?? 1200) * 0.45;
	const key = $derived(adeLayout.key);
	const slug = $derived(key && adeTasks.find(key) ? key : null);
	// Orca's right side bar tabs: icon only, the title and shortcut in the tooltip; the shortcuts and
	// each worktree's tab live in rightSidebar.svelte.ts. Review (accept, merge, PR) is Kingu's own, for a task.
	const tabs = $derived(rightSidebar.tabs(key));
	const activeTab = $derived(adeLayout.activeTab(key));
	const activeFile = $derived(keyOfTabId(activeTab));
	/** The selected task runs its agent CLI in a terminal (the Orca way). */
	const cli = $derived(slug ? cliOf(adeTasks.find(slug)?.meta.agent ?? '') : null);
	/** Resumes the task's own session when its id is saved, else the CLI's latest one, where the CLI can. */
	const resume = $derived(cli ? profileOf(cli).canResume : null);
	/** Agent hibernation (attempts.svelte.ts) closed the task's idle CLI then. */
	const hibernatedAt = $derived(slug ? adeTasks.find(slug)?.meta.hibernated_at : null);

	// The folder's "new task" composer (Orca: a new worktree with an agent).
	let draft = $state('');
	let draftFiles = $state<Attachment[]>([]);
	let base = $state('');
	let busy = $state(false);
	let focusKey = $derived(appMode.composeRequest);
	const cliSetting = $derived(settings.get<string>('kingu.agent.cli') ?? '');

	$effect(() => {
		if (!workspace.root || slug) return;
		void adeTasks.refreshBranches().then(() => {
			if (!base || !adeTasks.branches.includes(base)) base = adeTasks.defaultBase();
		});
	});

	// A removed task's terminals and agent CLI close with it (also a task of the previous folder,
	// or one removed while the page was reloading). Only after this folder's tasks were read
	// successfully: a failed tasks_load leaves an empty list, which must not end running agents.
	$effect(() => {
		if (!mayPruneSessions({ loaded: adeTasks.loaded, loadedRoot: adeTasks.loadedRoot, root: workspace.root })) return;
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
	const STARTERS = $derived.by((): { icon: IconName; label: string; text: string }[] => [
		{ icon: 'bug', label: t('legacyAde.agentsLayout.starterBug'), text: t('legacyAde.agentsLayout.starterBugText') },
		{ icon: 'check', label: t('legacyAde.agentsLayout.starterTest'), text: t('legacyAde.agentsLayout.starterTestText') },
		{ icon: 'code', label: t('legacyAde.agentsLayout.starterFeature'), text: t('legacyAde.agentsLayout.starterFeatureText') },
		{ icon: 'refresh', label: t('legacyAde.agentsLayout.starterRefactor'), text: t('legacyAde.agentsLayout.starterRefactorText') }
	]);
	const recent = $derived([...adeTasks.views].sort((a, b) => b.meta.updated_at - a.meta.updated_at).slice(0, 4));
	let nudge = $state(0);
	function starter(text: string) {
		draft = draft.trim() ? `${text}${draft}` : text;
		nudge++; // remounts the composer, which autofocuses
	}

	async function start(text: string, attachments: Attachment[]) {
		busy = true;
		try {
			const created = await adeTasks.create({ title: taskTitleFromPrompt(text), prompt: text, base, attachments });
			if (created) {
				draft = '';
				draftFiles = [];
				adeLayout.show(created);
			}
		} finally {
			busy = false;
		}
	}
	// VS Code's modern layout: each part is a softly rounded pane on the title bar's color, 4px apart.
	const FRAME = 'min-h-0 overflow-hidden rounded-[8px] border border-(--vscode-widget-border)';

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

	// kingu.sidebar.appearance / tintColor / tintOpacity (Orca's left side bar appearance).
	const sidebarLook = $derived(sidebarTint(settings.get<string>('kingu.sidebar.appearance'), settings.get('kingu.sidebar.tintColor'), settings.get('kingu.sidebar.tintOpacity')));
</script>

<div bind:this={body} class="relative flex min-h-0 flex-1 bg-(--vscode-titleBar-activeBackground) px-[4px] pb-[4px] text-(--vscode-foreground)">
	{#if appMode.sessionsVisible}
		<aside
			aria-label="Side Bar"
			class={[FRAME, 'flex shrink-0 flex-col bg-(--vscode-sideBar-background)']}
			style:width="{appMode.sessionsWidth}px"
			style:background-color={sidebarLook?.backgroundColor}
			style:background-image={sidebarLook?.backgroundImage}
		>
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
		<RecentTabSwitcher />
		{#if adeLayout.page === 'now'}
			<NowPage />
		{:else if adeLayout.page === 'automations'}
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
			{:else if adeLayout.markdownPreview(key)}
				<!-- Orca's markdown-preview mode (⇧⌘V): the shared Markdown viewer, following unsaved edits. -->
				<div class="absolute inset-0"><MarkdownPreview previewKey={previewKey(activeFile)} /></div>
			{:else}
				<!-- The IDE's text file service: binary, too large and unreadable files keep their tab as a
				     placeholder with "Open Anyway", and a save conflict opens its compare here. -->
				{@const placeholder = textFiles.placeholder(activeFile)}
				{#if placeholder}
					<div class="absolute inset-0"><FilePlaceholder path={activeFile} {placeholder} /></div>
				{:else}
					{#key activeFile}
						<div class="absolute inset-0">
							<AdeEditor path={activeFile} onedit={() => adeLayout.pin(key, activeFile)} onfail={(e) => textFiles.openFailed(activeFile, e)} />
						</div>
					{/key}
					{#if textFiles.compare?.path === activeFile}
						{@const c = textFiles.compare}
						<div class="absolute inset-0">{#key c}<SaveConflictCompare path={c.path} disk={c.disk} />{/key}</div>
					{/if}
				{/if}
			{/if}
		{:else if activeTab === 'main'}
			{#if slug && cli}
				{#if !cliSessions.has(slug)}
					<!-- After a restart the CLI is not running: continue its session or start fresh (never on its own). -->
					<div class="grid h-full place-items-center p-6">
						<div class="max-w-md space-y-3 text-center">
							<div class="flex justify-center text-(--vscode-descriptionForeground)"><Icon name="terminal" size={28} /></div>
							<p>{t('legacyAde.agentsLayout.cliNotRunning', { cli: cliName(cli) })}</p>
							<p class="text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.agentsLayout.runsInWorktree')} <span class="font-mono">kingu/{slug}</span></p>
							{#if hibernatedAt}<p class="text-xs text-(--vscode-descriptionForeground)">{t('adeAttempts.hibernated.text', { ago: timeAgo(hibernatedAt, adeTasks.now) })}</p>{/if}
							<div class="flex justify-center gap-2">
								{#if resume}<button class={BUTTON} onclick={() => adeTasks.resumeCli(slug)}>{t('legacyAde.agentsLayout.continueSession')}</button>{/if}
								<button class={resume ? BUTTON_SECONDARY : BUTTON} onclick={() => adeTasks.resumeCli(slug, true)}>{t('legacyAde.agentsLayout.restartCli', { cli: cli.join(' ') })}</button>
							</div>
						</div>
					</div>
				{/if}
			{:else if slug}
				<!-- A task saved by an older Kingu timeline is migrated only when the user starts it. -->
				<div class="grid h-full place-items-center p-6">
					<div class="max-w-md space-y-3 text-center">
						<div class="flex justify-center text-(--vscode-descriptionForeground)"><Icon name="terminal" size={28} /></div>
						<p>{t('legacyAde.agentsLayout.usedTimeline')}</p>
						<p class="text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.agentsLayout.adeTerminalOnly', { cli: cliSetting || 'claude' })}</p>
						<button class={BUTTON} onclick={() => adeTasks.resumeCli(slug, true)}>{t('legacyAde.agentsLayout.startInTerminal')}</button>
					</div>
				</div>
			{:else}
				<div class="grid h-full place-items-center p-6">
					{#if workspace.root}
						<div class="w-full max-w-[640px] space-y-3">
							<div class="mb-5 flex flex-col items-center gap-2 text-center">
								<Icon name="agent" size={44} />
								<h1 class="text-lg font-semibold text-(--vscode-foreground)">{t('legacyAde.agentsLayout.composerTitle')}</h1>
								<p class="text-[13px] text-(--vscode-descriptionForeground)">{t('legacyAde.agentsLayout.composerText')}</p>
							</div>
							{#key `${focusKey}:${nudge}`}
								<Composer bind:value={draft} attach bind:attachments={draftFiles} size="lg" autofocus placeholder={t('legacyAde.agentsLayout.composerPlaceholder')} {busy} onsubmit={start}>
									{#snippet left()}
										<span class="inline-flex shrink-0 items-center gap-1 rounded-sm border border-(--vscode-widget-border) px-1.5 py-0.5 text-xs text-(--vscode-descriptionForeground)" title="Agent runs in the worktree terminal">
											<Icon name="terminal" size={12} /> Terminal · {cliSetting || 'claude'}
										</span>
										<label class="inline-flex shrink-0 items-center gap-1 rounded-sm border border-(--vscode-widget-border) px-1.5 py-0.5 hover:bg-(--vscode-toolbar-hoverBackground)" title={t('legacyAde.agentsLayout.forkFromBranch')}>
											<Icon name="branch" size={12} />
											<span class="sr-only">{t('legacyAde.agentsLayout.forkFromBranch')}</span>
											<select class="max-w-48 bg-transparent outline-none focus-visible:outline-none" bind:value={base} disabled={busy}>
												{#each adeTasks.branches as b (b)}<option value={b}>{b}</option>{/each}
												{#if !adeTasks.branches.length}<option value="">HEAD</option>{/if}
											</select>
										</label>
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
							<p class="text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.agentsLayout.newWorktreePrefix')} <span class="font-mono">kingu/…</span> {t('legacyAde.agentsLayout.newWorktreeSuffix', { cli: cliSetting || 'claude' })}</p>
							{#if recent.length}
								<section class="pt-5" aria-label={t('legacyAde.agentsLayout.recentTasks')}>
									<h2 class="mb-2 text-xs font-medium text-(--vscode-descriptionForeground)">{t('legacyAde.agentsLayout.recentTasks')}</h2>
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
						<p class="text-sm text-(--vscode-descriptionForeground)">{t('legacyAde.agentsLayout.openGitRepo')}</p>
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
					ontitle={(title) => cliSessions.title(s, title)}
					onbell={() => terminalBells.ring(s, 'main')}
					onopenfile={(rel, line, column) => openLinkedFile(s, rel, line, column)}
				/>
				<!-- Quick reply while the CLI asks a question (top right: the CLI draws its question at the bottom). -->
				<CliQuestion slug={s} class="absolute top-2 right-4 z-10 max-h-[70%] w-80 overflow-y-auto text-xs shadow-lg shadow-black/30" />
			</div>
		{/each}
		{#each Object.entries(adeLayout.browsers) as [k, list] (k)}
			{#each list as b (b.id)}
				<div class={['absolute inset-0', (adeLayout.board || k !== key || activeTab !== b.id) && 'hidden']}>
					<AdeBrowser worktree={k} id={b.id} />
				</div>
			{/each}
		{/each}
		{#each Object.entries(adeLayout.terminals) as [k, list] (k)}
			{#each list as t (t.id)}
				<div class={['absolute inset-0 bg-(--vscode-terminal-background,var(--vscode-panel-background))', (adeLayout.board || k !== key || activeTab !== t.id) && 'hidden']}>
					<!-- Orca's pane splits: every pane is its own PTY (`t<n>` ids; the first pane's id is the tab's). -->
					<PaneSplitView tree={t.layout ?? leaf(t.id)} expanded={t.expanded ?? null} active={activePane(t)} onresize={(path, ratio) => adeLayout.resizePane(k, t.id, path, ratio)}>
						{#snippet pane(p)}
							<Terminal
								key={adeLayout.ptyKey(k, p)}
								slug={k || undefined}
								run={p === t.id ? t.run : undefined}
								cwdFrom={adeLayout.cwdFrom(k, p)}
								flavor="ade"
								keyLabels={PANE_KEYS}
								menuState={() => ({ split: tabPanes(t).length > 1, expanded: !!t.expanded })}
								onoutput={() => paneAgents.output(adeLayout.ptyKey(k, p))}
								ontitle={(title) => paneAgents.title(adeLayout.ptyKey(k, p), title)}
								onbell={() => terminalBells.ring(k, t.id)}
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
				gap
			orientation="vertical"
			onDrag={(d) => (appMode.panelWidth = clamp(appMode.panelWidth - d, 220, Math.max(220, window.innerWidth - 320)))}
			onReset={() => (appMode.panelWidth = 350)}
		/>
		<aside aria-label={tabs.tabs.find((t) => t.id === tabs.active)?.label} class={[FRAME, 'flex shrink-0 flex-col bg-(--vscode-sideBar-background)']} style:width="{appMode.panelWidth}px">
			<!-- Orca's right side bar header: 36px, icon tabs with an underline (the title bar holds the toggle). -->
			<div class="flex h-[36px] min-h-[36px] shrink-0 items-center overflow-hidden border-b border-(--vscode-widget-border)">
				<div class="flex min-w-0 flex-1 items-center overflow-hidden pl-2" role="tablist" aria-label="Right Side Bar">
					{#each tabs.tabs as t (t.id)}
						{@const on = tabs.active === t.id}
						<button
							role="tab"
							aria-selected={on}
							aria-label={t.label}
							title={t.key ? `${t.label} (${keyLabel(t.key)})` : t.label}
							class={['relative flex h-[36px] w-9 shrink-0 items-center justify-center transition-colors', on ? 'text-(--vscode-foreground)' : 'text-(--vscode-descriptionForeground)/60 hover:text-(--vscode-descriptionForeground)']}
							onclick={() => rightSidebar.setTab(key, t.id)}
						>
							<Icon name={t.icon} size={16} filled={on} />
							{#if on}<span class="absolute right-[25%] bottom-0 left-[25%] h-[2px] rounded-t bg-(--vscode-foreground)"></span>{/if}
						</button>
					{/each}
				</div>
			</div>
			{#if tabs.active === 'files'}
				{#if workspace.root}{#key key}<WorktreeFiles slug={slug ?? ''} />{/key}{/if}
			{:else if tabs.active === 'changes'}
				{#key key}<AdeSourceControl slug={slug ?? ''} />{/key}
			{:else if tabs.active === 'agents'}
				<AdeAgentsPanel slug={slug ?? ''} />
			{:else if tabs.active === 'checks'}
				{#key key}<AdeChecks slug={slug ?? ''} />{/key}
			{:else if tabs.active === 'ports'}
				<AdePortsPanel slug={slug ?? ''} />
			{:else if slug}
				{#key slug}<TaskPage {slug} sections="review" />{/key}
			{/if}
		</aside>
	{/if}
</div>
