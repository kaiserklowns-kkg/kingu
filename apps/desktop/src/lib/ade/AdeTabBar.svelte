<script lang="ts">
	// Tab row of the Agents layout's center (Orca's worktree tabs): the selected worktree's agent
	// session (or the new-task composer for the folder itself), its terminals, files and task diffs
	// opened from the right side bar (italic while a preview, a dot while unsaved), and "+" for a
	// new terminal in that worktree; "N รอคุณ" at the end. Tasks (the board) shows as its own tab.
	// A split worktree has one of these per region (Orca's tab groups, adeSplit.ts): `group` limits it
	// to that group's tabs, and only the strip with `extras` (the top right one) has the quick
	// commands and the attention badge. Tabs drag within a strip to reorder and onto another strip to move.
	import { untrack } from 'svelte';
	import AgentIcon from '#lib/agent/AgentIcon.svelte';
	import FileIcon from '#lib/workbench/FileIcon.svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { fileIcon } from '#lib/workbench/fileIcons.ts';
	import { fileOf } from '#lib/workbench/scm.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { adeLayout } from './adeLayout.svelte';
	import { pickSession } from './agentsMode.svelte';
	import { statusLabel } from './model';
	import { adeTasks } from './tasks.svelte';
	import { statusDot } from './ui';
	import { sessionsAttentionLabel } from '#lib/workbench/titlebar.ts';
	import { keyLabel } from '#lib/workbench/keys.ts';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { invoke } from '@tauri-apps/api/core';
	import NewTabMenu, { type NewTabItem } from './NewTabMenu.svelte';
	import QuickCommandDialog from './QuickCommandDialog.svelte';
	import { quickPromptArgv } from './quickPrompt';
	import { CUSTOM_PICK, KNOWN_BINS, pickerItems } from './agentProfiles';
	import { enabledBins } from './agentCli';
	import { isMarkdownEditor } from './adeMarkdown.ts';
	import type { AdeTab } from './adeTabs';
	import { splittable } from './adeSplit';
	import { terminalBells } from './terminalBell.svelte';
	import { paneAgents } from './paneAgents.svelte';
	import { rowCardStatus, rowText } from './agentPresence';
	import CardStatusDot from './CardStatusDot.svelte';
	import { paneProgram } from './paneProgram.svelte';
	import { programLabel, withPercent } from './programStatus';
	import ProgressRing from './ProgressRing.svelte';
	import { t as tr } from '#lib/i18n/index.ts';
	import { primaryQuickCommand, QUICK_INSERT_ID, quickAppendsEnter, quickCommands, withoutQuickCommand } from '#lib/terminal/adeTerminalOptions.ts';
	import { ask } from '#lib/workbench/messageBox.ts';

	let { group, extras = true }: { group?: string; extras?: boolean } = $props();

	// Tab context menu, like the IDE's: close tabs, copy or reveal a file. The agent session and the
	// composer stay (they are the worktree itself).
	let menu = $state<{ tab: AdeTab; x: number; y: number } | null>(null);
	/** Bulk closes skip the agent session, the composer and pinned tabs (Orca's pinned tabs). */
	const closable = (t: AdeTab) => t.kind !== 'agent' && t.kind !== 'compose' && !adeLayout.isPinned(key, t.id);
	const TAB_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#64748b'];
	const menuItems = $derived.by(() => {
		if (!menu) return [];
		const t = menu.tab;
		const i = tabs.findIndex((x) => x.id === t.id);
		const file = t.kind === 'file' || t.kind === 'diff';
		return [
			menuItem('close', 'Close', { enabled: t.kind !== 'agent' && t.kind !== 'compose' }),
			menuItem('others', 'Close Others', { enabled: tabs.some((x) => x.id !== t.id && closable(x)) }),
			menuItem('right', 'Close to the Right', { enabled: tabs.slice(i + 1).some(closable) }),
			menuSeparator,
			menuItem('copyPath', 'Copy Path', { enabled: file }),
			menuItem('reveal', 'Reveal in Finder', { enabled: file }),
			menuItem('keep', 'Keep Open', { enabled: file && 'preview' in t && t.preview }),
			menuItem('preview', 'Toggle Markdown Preview', { enabled: file && 'key' in t && isMarkdownEditor(t.key) }),
			menuSeparator,
			menuItem('splitRight', tr('ade.split.right'), { enabled: splittable(t.id) && tabs.length > 1 }),
			menuItem('splitDown', tr('ade.split.down'), { enabled: splittable(t.id) && tabs.length > 1 }),
			...(group ? [menuItem('closeRegion', tr('ade.split.closeGroup'))] : []),
			menuItem('unsplit', tr('ade.split.close'), { enabled: !!adeLayout.treeOf(key) }),
			menuSeparator,
			menuItem('pin', adeLayout.isPinned(key, t.id) ? 'Unpin Tab' : 'Pin Tab', { enabled: closable(t) || adeLayout.isPinned(key, t.id) }),
			{
				type: 'submenu' as const,
				id: 'color',
				text: 'Tab Color',
				items: [
					...TAB_COLORS.map((c) => menuItem(`color:${c}`, c, { checked: adeLayout.colorOf(key, t.id) === c })),
					menuSeparator,
					menuItem('color:', 'None', { checked: !adeLayout.colorOf(key, t.id) })
				]
			}
		];
	});
	async function runMenu(id: string, t: AdeTab) {
		const i = tabs.findIndex((x) => x.id === t.id);
		const rel = 'key' in t ? fileOf(t.key) : '';
		switch (id) {
			case 'close':
				return adeLayout.close(key, t.id);
			case 'others':
			case 'right':
				for (const x of (id === 'others' ? tabs.filter((x) => x.id !== t.id) : tabs.slice(i + 1)).filter(closable)) adeLayout.close(key, x.id);
				return;
			case 'copyPath': {
				const text = workspace.root ? `${workspace.root}/${rel}` : rel;
				await navigator.clipboard.writeText(text);
				return status.flash(tr('legacyAde.adeTabBar.copied', { text }), 3000);
			}
			case 'reveal':
				return invoke('fs_reveal', { rel }).catch((e) => status.error(String(e)));
			case 'keep':
				return 'key' in t && adeLayout.pin(key, t.key);
			case 'preview':
				adeLayout.select(key, t.id);
				return adeLayout.toggleMarkdownPreview(key);
			case 'pin':
				return adeLayout.togglePin(key, t.id);
			case 'splitRight':
			case 'splitDown':
				// Into a new group beside the tab's own group.
				return adeLayout.splitTab(key, t.id, id === 'splitRight' ? 'right' : 'down', t.id);
			case 'closeRegion':
				return group && adeLayout.closeRegion(key, group);
			case 'unsplit':
				return adeLayout.unsplit(key);
		}
		if (id.startsWith('color:')) return adeLayout.setColor(key, t.id, id.slice(6) || undefined);
	}

	// The "+" is Orca's new-tab menu: a searchable list of a new tab's kinds, then the agent CLIs
	// found on the PATH (each runs in a new terminal of this worktree, so agents can run side by side).
	let create = $state<{ x: number; y: number } | null>(null);
	let found = $state<string[]>([]);
	const createItems = $derived<NewTabItem[]>([
		{ id: 'terminal', label: 'New Terminal', keyLabel: keyLabel('cmd+t') },
		{ id: 'browser', label: 'New Browser Tab', keyLabel: keyLabel('cmd+shift+b') },
		{ id: 'markdown', label: 'New Markdown', keyLabel: keyLabel('cmd+shift+m') },
		{ id: 'openMarkdown', label: 'Open Markdown…', keyLabel: keyLabel('cmd+shift+o') },
		...pickerItems(found, '')
			.filter((r) => r.id !== CUSTOM_PICK)
			.map((r) => ({ id: `agent:${r.id}`, label: r.label, description: r.description, agent: r.agent, group: 'Agents' }))
	]);
	async function openCreate(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		create = { x: r.left, y: r.bottom + 2 };
		found = enabledBins(
			await invoke<string[]>('agent_cli_found', { names: KNOWN_BINS }).catch(() => [] as string[]),
			settings.get<string[]>('kingu.agent.disabled'),
			null
		);
	}
	function runCreate(id: string) {
		// A region's "+" opens the new tab in that region's group (new tabs join the active group).
		if (group && shownTab !== activeTab) adeLayout.select(key, shownTab);
		if (id === 'browser') adeLayout.newBrowser(key);
		else if (id === 'markdown') adeLayout.newMarkdown(key);
		else if (id === 'openMarkdown') void adeLayout.openMarkdown(key);
		else if (id.startsWith('agent:')) {
			const bin = id.slice(6);
			adeLayout.newTerminal(key, { title: pickerItems(found, '').find((r) => r.id === bin)?.label ?? bin, run: [bin] });
		} else adeLayout.newTerminal(key);
	}

	// Orca's Quick Commands split button (tab-bar/TabBarQuickCommandsMenu.tsx, terminal.mdx): the
	// main part runs the command used last in a new terminal tab of this worktree, the chevron
	// lists every `kingu.terminal.quickCommands` entry and Add Command (the setting).
	const RECENT_QUICK = 'kingu.ade.quickCommand.recent';
	// Commands (typed into a shell) and prompts (Orca's Prompt action: the agent CLI started with it).
	type QuickKind = 'command' | 'prompt';
	type Quick = { kind: QuickKind; label: string; command: string };
	const QUICK_IDS: Record<QuickKind, string> = { command: 'kingu.terminal.quickCommands', prompt: 'kingu.terminal.quickPrompts' };
	const quick = $derived<Quick[]>([
		...quickCommands(settings.get<Record<string, unknown>>(QUICK_IDS.command)).map((q) => ({ ...q, kind: 'command' as const })),
		...quickCommands(settings.get<Record<string, unknown>>(QUICK_IDS.prompt)).map((q) => ({ ...q, kind: 'prompt' as const }))
	]);
	let recentQuick = $state<string | null>(readRecentQuick());
	const primaryQuick = $derived(primaryQuickCommand(quick, recentQuick));
	let quickMenu = $state<{ x: number; y: number } | null>(null);
	let addingQuick = $state(false);
	let quickChevron: HTMLButtonElement | undefined = $state();
	function toggleQuickMenu() {
		if (quickMenu) return void (quickMenu = null);
		const r = quickChevron?.getBoundingClientRect();
		if (r) quickMenu = { x: r.right - 300, y: r.bottom + 2 };
	}
	// Toggle Quick Commands Menu from the palette or its key (not on mount).
	let seenQuickRequest = untrack(() => adeLayout.quickMenuRequest);
	$effect(() => {
		const n = adeLayout.quickMenuRequest;
		if (n === seenQuickRequest) return;
		seenQuickRequest = n;
		if (extras) untrack(toggleQuickMenu);
	});
	/** Edit Quick Command: the entry and the scope that keeps it (this project's store wins, like the merge). */
	let editingQuick = $state<{ kind: QuickKind; label: string; command: string; scope: 'user' | 'repo'; agent?: string; appendEnter?: boolean } | null>(null);
	const AGENTS_ID = 'kingu.terminal.quickPromptAgents';
	/** A prompt's own agent (kingu.terminal.quickPromptAgents), '' for kingu.agent.cli. */
	const promptAgent = (label: string): string => {
		const v = settings.get<Record<string, unknown>>(AGENTS_ID)?.[label];
		return typeof v === 'string' ? v.trim() : '';
	};
	const quickScope = (q: Pick<Quick, 'kind' | 'label'>): 'user' | 'repo' => {
		const repo = settings.repo.values[QUICK_IDS[q.kind]];
		return repo && typeof repo === 'object' && q.label in repo ? 'repo' : 'user';
	};
	async function deleteQuick(q: Quick) {
		if (!(await ask(tr('legacyAde.quickCommand.deleteAsk', { label: q.label }), { title: tr('legacyAde.quickCommand.deleteTitle'), kind: 'warning', okLabel: tr('legacyAde.quickCommand.deleteOk') }))) return;
		const scope = quickScope(q);
		const id = QUICK_IDS[q.kind];
		const layer = (scope === 'repo' ? settings.repo.values : settings.user.values)[id];
		await settings.set(id, withoutQuickCommand(layer, q.label), scope).catch((e) => status.error(String(e)));
		const agents = (scope === 'repo' ? settings.repo.values : settings.user.values)[AGENTS_ID];
		if (q.kind === 'prompt' && agents && typeof agents === 'object' && q.label in agents) await settings.set(AGENTS_ID, withoutQuickCommand(agents, q.label), scope).catch((e) => status.error(String(e)));
		// Its Insert mode goes with it (a map of booleans, so not withoutQuickCommand's string filter).
		const insert = (scope === 'repo' ? settings.repo.values : settings.user.values)[QUICK_INSERT_ID];
		if (q.kind === 'command' && insert && typeof insert === 'object' && q.label in insert)
			await settings.set(QUICK_INSERT_ID, Object.fromEntries(Object.entries(insert).filter(([k]) => k !== q.label)), scope).catch((e) => status.error(String(e)));
	}
	function readRecentQuick(): string | null {
		try {
			return localStorage.getItem(RECENT_QUICK);
		} catch {
			return null;
		}
	}
	function runQuick(q: Quick) {
		if (q.kind === 'prompt') {
			const cli = promptAgent(q.label) || settings.get<string>('kingu.agent.cli') || 'claude';
			const argv = quickPromptArgv(cli, q.command);
			if (!argv) return void status.error(tr('legacyAde.quickCommand.noPrompt', { agent: cli }), 8000);
			adeLayout.newTerminal(key, { title: q.label, run: argv });
		} else {
			runCommandLine(q);
		}
		recentQuick = q.label;
		try {
			localStorage.setItem(RECENT_QUICK, q.label);
		} catch {
			// The last used command is a convenience; the first one runs without it.
		}
	}
	function runCommandLine(q: Quick) {
		// A line past the tty's input limit (1024 bytes on macOS) typed before the shell is ready
		// is cut; a long one goes through the daemon, which waits for the line editor (`sh -c`).
		const enter = quickAppendsEnter(settings.get<Record<string, unknown>>(QUICK_INSERT_ID), q.label);
		const long = new TextEncoder().encode(q.command).length > 900;
		// Insert mode (Orca's appendEnter off) only types; a long line cannot run as `sh -c` then.
		adeLayout.newTerminal(key, long && enter ? { title: q.label, run: ['sh', '-c', q.command] } : { title: q.label, type: q.command, typeEnter: enter });
	}
	// Orca's menu: a search over label and command text, the command used last first.
	const quickItems = $derived<NewTabItem[]>([
		...quick
			.map((q, i) => ({ q, i }))
			.toSorted((a, b) => Number(a.q.kind === 'prompt') - Number(b.q.kind === 'prompt') || Number(b.q.label === primaryQuick?.label) - Number(a.q.label === primaryQuick?.label))
			.map(({ q, i }) => ({
				id: `quick:${i}`,
				label: q.label,
				// Orca's "Insert" hint on a command that is only typed (appendEnter off).
				description: q.kind === 'command' && !quickAppendsEnter(settings.get<Record<string, unknown>>(QUICK_INSERT_ID), q.label) ? `${tr('legacyAde.quickCommand.insert')} · ${q.command.split('\n')[0]}` : q.command.split('\n')[0],
				group: q.kind === 'prompt' ? tr('legacyAde.quickCommand.prompts') : tr('legacyAde.adeTabBar.quickCommands'),
				actions: [
					{ id: `quickEdit:${i}`, icon: 'edit' as const, label: tr('legacyAde.quickCommand.edit', { label: q.label }) },
					{ id: `quickDelete:${i}`, icon: 'trash' as const, label: tr('legacyAde.quickCommand.delete', { label: q.label }) }
				]
			})),
		{ id: 'quick:add', label: tr('legacyAde.adeTabBar.addQuickCommand') }
	]);
	function runQuickItem(id: string) {
		if (id === 'quick:add') return void (addingQuick = true);
		const action = /^(quickEdit|quickDelete):(\d+)$/.exec(id);
		if (action) {
			const entry = quick[Number(action[2])];
			if (!entry) return;
			if (action[1] === 'quickDelete') return void deleteQuick(entry);
			editingQuick = { ...entry, scope: quickScope(entry), agent: entry.kind === 'prompt' ? promptAgent(entry.label) : undefined, appendEnter: entry.kind === 'command' ? quickAppendsEnter(settings.get<Record<string, unknown>>(QUICK_INSERT_ID), entry.label) : undefined };
			return;
		}
		const q = quick[Number(id.slice(6))];
		if (q) runQuick(q);
	}

	const key = $derived(adeLayout.key);
	const view = $derived(key ? adeTasks.find(key) : undefined);
	const tabs = $derived(group ? adeLayout.groupTabs(key, group) : adeLayout.tabs(key));
	const activeTab = $derived(adeLayout.activeTab(key));
	/** The tab this strip's region shows (Orca's group active tab); the accent line marks it only in the active group. */
	const shownTab = $derived((group && adeLayout.groupsOf(key)?.shown[group]) || activeTab);
	const attention = $derived(sessionsAttentionLabel(adeTasks.counts.needsInput));

	// Orca's drag reorder: drop a tab on another to put it before it, on the strip to move it last; a
	// tab from another region's strip moves into this group. The dragged tab is shared by every strip.
	let dropId = $state<string | null>(null);
	function dragStart(e: DragEvent, id: string) {
		// The center shows its split drop zones (Orca: drag a tab to a pane edge).
		adeLayout.draggingTab = id;
		e.dataTransfer?.setData('text/plain', id);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}
	function dragOver(e: DragEvent, id: string) {
		const dragId = adeLayout.draggingTab;
		if (!dragId || dragId === id) return;
		e.preventDefault();
		dropId = id;
	}
	function drop(e: DragEvent, id: string) {
		e.preventDefault();
		e.stopPropagation();
		const dragId = adeLayout.draggingTab;
		if (dragId && dragId !== id) adeLayout.moveTabTo(key, dragId, id, id);
		adeLayout.draggingTab = null;
		dropId = null;
	}
	function dropEnd(e: DragEvent) {
		e.preventDefault();
		e.stopPropagation();
		const dragId = adeLayout.draggingTab;
		if (dragId) adeLayout.moveTabTo(key, dragId, shownTab, null);
		adeLayout.draggingTab = null;
		dropId = null;
	}

	// Same look as the IDE's editor tabs: rounded tops in the strip, an accent line on the active one.
	const TAB = 'group relative flex h-[30px] max-w-60 min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-t-lg pr-1.5 pl-3 text-[13px] transition-colors';
	const ACTIVE = 'bg-(--vscode-tab-activeBackground) text-(--vscode-tab-activeForeground)';
	const ACCENT = 'absolute inset-x-2.5 top-0 h-0.5 rounded-b-full bg-(--vscode-tab-activeBorderTop)';
	const INACTIVE = 'text-(--vscode-tab-inactiveForeground) hover:bg-(--vscode-tab-hoverBackground)';
</script>

<div data-ade-strip class="flex h-[35px] shrink-0 items-end gap-0.5 border-b border-(--vscode-editorGroupHeader-tabsBorder,var(--vscode-widget-border)) bg-(--vscode-editorGroupHeader-tabsBackground) px-1">
	{#if adeLayout.board && !group}
		<div class={[TAB, ACTIVE]}>
			<span class={ACCENT}></span>
			{#if adeLayout.page === 'now'}<Icon name="agent" size={14} /> Now{:else if adeLayout.page === 'automations'}<Icon name="clock" size={14} /> Automations{:else if adeLayout.page === 'issues'}<Icon name="bug" size={14} /> Issues{:else}<Icon name="tasks" size={14} /> Tasks{/if}
			<button class="grid size-5 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={tr('legacyAde.adeTabBar.closePage', { page: adeLayout.page === 'now' ? 'Now' : adeLayout.page === 'automations' ? 'Automations' : adeLayout.page === 'issues' ? 'Issues' : 'Tasks' })} onclick={() => (adeLayout.board = false)}><Icon name="close" size={13} /></button>
		</div>
	{:else}
		<div
			class="flex min-w-0 items-end gap-0.5 overflow-x-auto [scrollbar-width:none]"
			role="tablist"
			tabindex="-1"
			aria-label={tr('legacyAde.adeTabBar.worktreeTabs')}
			ondragover={(e) => adeLayout.draggingTab && e.preventDefault()}
			ondrop={dropEnd}
		>
			{#each tabs as t (t.id)}
				{@const active = t.id === shownTab}
				<div
					role="tab"
					tabindex="0"
					aria-selected={active}
					class={[TAB, active ? ACTIVE : INACTIVE, dropId === t.id && adeLayout.draggingTab && 'border-l-2 border-(--vscode-focusBorder)']}
					draggable="true"
					ondragstart={(e) => dragStart(e, t.id)}
					ondragover={(e) => dragOver(e, t.id)}
					ondrop={(e) => drop(e, t.id)}
					ondragend={() => ((dropId = null), (adeLayout.draggingTab = null))}
					onclick={() => adeLayout.select(key, t.id)}
					onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), adeLayout.select(key, t.id))}
					onauxclick={(e) => e.button === 1 && t.kind !== 'agent' && t.kind !== 'compose' && !adeLayout.isPinned(key, t.id) && adeLayout.close(key, t.id)}
					ondblclick={() => (t.kind === 'file' || t.kind === 'diff' ? adeLayout.pin(key, t.key) : t.kind === 'terminal' && adeLayout.rename(key, t.id))}
					oncontextmenu={(e) => (e.preventDefault(), (menu = { tab: t, x: e.clientX, y: e.clientY }))}
				>
					{#if active && t.id === activeTab}<span class={ACCENT}></span>{/if}
					{#if adeLayout.colorOf(key, t.id) ?? (t.kind === 'terminal' ? t.color : undefined)}
						{@const dot = adeLayout.colorOf(key, t.id) ?? (t.kind === 'terminal' ? t.color : undefined)}
						<span class="size-2 shrink-0 rounded-full" style:background={dot} aria-hidden="true"></span>
					{/if}
					{#if t.kind === 'agent' && view}
						{@const percent = paneProgram.taskProgress(view)}
						{#if percent !== undefined}
							<span class="grid size-3 shrink-0 place-items-center" title={withPercent(statusLabel(view), percent)}><ProgressRing {percent} tone={view.status === 'running' ? 'working' : 'attention'} label={withPercent(statusLabel(view), percent)} /></span>
						{:else}
							<span class={['size-2 shrink-0 rounded-full', statusDot(view)]} title={statusLabel(view)}></span>
						{/if}
						<AgentIcon agent={view.meta.agent || 'claude'} size={14} />
						<span class="truncate" title={view.meta.title}>{view.meta.title}</span>
					{:else if t.kind === 'browser'}
						<Icon name="globe" size={14} /><span class="truncate" title={t.label}>{t.label}</span>
					{:else if t.kind === 'file' || t.kind === 'diff'}
						<FileIcon icon={fileIcon(t.label)} />
						<span class={['truncate', t.preview && 'italic']} title={t.kind === 'diff' ? tr('legacyAde.adeTabBar.diffOfTask', { file: fileOf(t.key) }) : t.key}>{t.label}</span>
						{#if t.kind === 'diff'}<Icon name="git" size={12} />{/if}
					{:else}
						<!-- An agent typed into this terminal (or started from the new-tab menu) shows its own state, like the main agent tab. -->
						{@const row = t.kind === 'terminal' ? paneAgents.tabRow(key, t.id) : undefined}
						<!-- OSC 7501 (Orca's progress ring): a reported percentage turns a live state glyph into a ring filled that far. -->
						{@const program = t.kind === 'terminal' && !row ? paneProgram.tab(key, t.id) : undefined}
						{#if row}
							{@const percent = paneProgram.agentProgress(row.id, row.state)}
							{#if percent !== undefined}
								<span class="grid size-3 shrink-0 place-items-center" title={withPercent(rowText(row), percent)}><ProgressRing {percent} tone={row.state === 'working' ? 'working' : 'attention'} label={withPercent(rowText(row), percent)} /></span>
							{:else}
								<span class="grid size-3 shrink-0 place-items-center" role="status" aria-label={rowText(row)} title={rowText(row)}><CardStatusDot status={rowCardStatus(row)} size="size-2" /></span>
							{/if}
							{#if row.agent}<AgentIcon agent={row.agent} size={14} />{:else}<Icon name="terminal" size={14} />{/if}
						{:else if program}
							<!-- A program that is not an agent: a ring for its percentage, else the spinner (no percentage given), a question mark (blocked), a green (done) or red (error) dot. -->
							{#if program.progress !== undefined}
								<span class="grid size-3 shrink-0 place-items-center" title={programLabel(program)}><ProgressRing percent={program.progress} tone={program.status === 'working' ? 'working' : 'attention'} label={programLabel(program)} /></span>
							{:else}
								<span class="grid size-3 shrink-0 place-items-center" role="status" aria-label={programLabel(program)} title={programLabel(program)}><CardStatusDot status={program.status} size="size-2" /></span>
							{/if}
							<Icon name="terminal" size={14} />
						{:else}
							<Icon name={t.kind === 'compose' ? 'agent' : 'terminal'} size={14} />
						{/if}
						<span class="truncate">{t.label}</span>
					{/if}
					{#if !active && terminalBells.has(key, t.id)}
						<!-- kingu.agent.notifications.terminalBell: this terminal rang while hidden. -->
						<span class="size-1.5 shrink-0 rounded-full bg-(--vscode-activityBarBadge-background)" role="status" aria-label={tr('ade.bell.dot')} title={tr('ade.bell.dot')}></span>
					{/if}
					{#if t.kind !== 'agent' && t.kind !== 'compose' && !adeLayout.isPinned(key, t.id)}
						{@const dirty = t.kind === 'file' && editors.isDirty(t.key)}
						<button
							class={['grid size-5 shrink-0 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)', !active && !dirty && 'invisible group-hover:visible']}
							aria-label={dirty ? tr('legacyAde.adeTabBar.unsavedClose', { label: t.label }) : tr('legacyAde.adeTabBar.closeTab', { label: t.label })}
							title={tr('legacyAde.adeTabBar.close')}
							onclick={(e) => (e.stopPropagation(), adeLayout.close(key, t.id))}
						>
							{#if dirty}
								<span class="size-2 rounded-full bg-current group-hover:hidden"></span>
								<span class="hidden group-hover:block"><Icon name="close" size={13} /></span>
							{:else}
								<Icon name="close" size={13} />
							{/if}
						</button>
					{:else}
						<span class="w-1"></span>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
	<!-- Also on a page (Now, Tasks…): a new tab leaves the page for the worktree. -->
	<div class="flex items-center self-center px-1">
		<button
			class="grid size-6 place-items-center rounded-md enabled:hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-35"
			aria-label="New Tab"
			title="New Tab"
			disabled={!workspace.root}
			onclick={openCreate}
		>
			<Icon name="plus" size={16} />
		</button>
	</div>
	<span class="flex-1"></span>
	{#if workspace.root && extras}
		<div class="my-auto mr-1 flex h-[22px] items-stretch rounded-md text-xs">
			{#if primaryQuick}
				{@const q = primaryQuick}
				<button
					class="flex max-w-40 items-center gap-1 rounded-l-md px-1.5 text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)"
					title={tr('legacyAde.adeTabBar.runQuickCommand', { label: q.label, command: q.command })}
					aria-label={tr('legacyAde.adeTabBar.runQuickCommand', { label: q.label, command: q.command })}
					onclick={() => runQuick(q)}><Icon name="play" size={12} /><span class="truncate">{q.label}</span></button
				>
			{/if}
			<button
				bind:this={quickChevron}
				class={['grid w-5 place-items-center text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)', primaryQuick ? 'rounded-r-md' : 'rounded-md']}
				title={tr('legacyAde.adeTabBar.quickCommands')}
				aria-label={tr('legacyAde.adeTabBar.quickCommands')}
				onclick={toggleQuickMenu}><Icon name={primaryQuick ? 'chevronDown' : 'terminal'} size={12} /></button
			>
		</div>
	{/if}
	{#if attention && extras}
		<button
			class="needs-input my-auto mr-2 flex h-[22px] items-center gap-1.5 rounded-md px-2 text-xs text-(--vscode-editorWarning-foreground) hover:bg-(--vscode-toolbar-hoverBackground)"
			title={tr('legacyAde.adeTabBar.chooseSession', { attention })}
			onclick={pickSession}
		>
			<span class="size-2 rounded-full bg-(--vscode-editorWarning-foreground)"></span>{attention}
		</button>
	{/if}
	{#if group}
		{@const g = group}
		<button
			class="my-auto mr-1 grid size-6 shrink-0 place-items-center rounded-md text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground)"
			aria-label={tr('ade.split.closeRegion')}
			title={tr('ade.split.closeRegion')}
			onclick={() => adeLayout.closeRegion(key, g)}><Icon name="close" size={13} /></button
		>
	{/if}
</div>

{#if addingQuick}
	<QuickCommandDialog onclose={() => (addingQuick = false)} onsaved={(label) => (recentQuick = label)} />
{:else if editingQuick}
	<QuickCommandDialog initial={editingQuick} onclose={() => (editingQuick = null)} onsaved={(label) => (recentQuick = label)} />
{/if}
{#if quickMenu}
	<NewTabMenu details items={quickItems} label={tr('legacyAde.adeTabBar.quickCommands')} placeholder={tr('legacyAde.adeTabBar.searchQuickCommands')} x={quickMenu.x} y={quickMenu.y} onRun={runQuickItem} onClose={() => (quickMenu = null)} />
{/if}

{#if create}
	{@const at = create}
	<NewTabMenu items={createItems} x={at.x} y={at.y} onRun={runCreate} onClose={() => (create = null)} />
{/if}
{#if menu}
	{@const target = menu.tab}
	<PopupMenu items={menuItems} label="Tab" x={menu.x} y={menu.y} onRun={(node) => node.type === 'item' && runMenu(node.id, target)} onClose={() => (menu = null)} />
{/if}

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
