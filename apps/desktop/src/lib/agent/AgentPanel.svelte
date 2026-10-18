<script lang="ts">
	// Agent panel (secondary side bar), laid out like VS Code's Chat view: title actions on top,
	// the chat's request/response list (ChatList), and the chat input (Composer) pinned to the
	// bottom with its context chips, Ask/Agent mode and model pickers.
	// Sessions are this folder's chats (`chats`: an agent-host session in the folder or a task's
	// worktree, persisted with its transcript). The history list (≡) shows them, and the folder's
	// ADE tasks in their own "Agents (ADE)" section as read-only rows that open in Agents. The
	// panel opens on the most recent chat, else a new one; never on a task. The chat never types
	// into a terminal and never starts a CLI.
	import { onMount, untrack } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import type { Attachment } from './attachments.ts';
	import ChatList from './ChatList.svelte';
	import Composer from './Composer.svelte';
	import ChatEditsBar from './ChatEditsBar.svelte';
	import ChatTodoBar from './ChatTodoBar.svelte';
	import RestoreCheckpoint from './RestoreCheckpoint.svelte';
	import ContextRing from './ContextRing.svelte';
	import { kinguCommands, localCommandFor, mergeCommands, type FileCommand } from './slashCommands.ts';
	import { queueDefault, type SendHow } from './requestQueuing.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { chatEdits } from './chatEdits.svelte.ts';
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import { runtime } from '#lib/ade/runtime.svelte.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { quick } from '#lib/workbench/quick.svelte.ts';
	import { recentFiles } from '#lib/workbench/recentFiles.svelte.ts';
	import { rankFiles } from '#lib/workbench/quickAccess.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { ask } from '#lib/workbench/messageBox.ts';
	import { t } from '#lib/i18n/index.ts';
	import { timeAgo } from '#lib/ade/model.ts';
	import { STATUS_LABEL } from './events';
	import { cliOf } from '#lib/ade/agentCli.ts';
	import { chats } from './chats.svelte.ts';
	import { chatRewind } from './chatRewind.svelte.ts';
	import { chatCwdPath, groupByDate, historySections, initialChat, type ChatCwd, type DateGroup } from './chats.ts';
	import RulesChip from './RulesChip.svelte';
	import { assemblePrompt, isFileKey, promptPath, relativeTo, resolveContext, withoutImagesLine, type ContextFile } from './chatPrompt.ts';
	import { AGENT_APPROVALS, modeOf, permissionFor, turnBusy, type AgentApproval, type ChatMode } from './chatInput.ts';
	import { buildTurns, promptHistory, type Turn } from './chatParts.ts';
	import { chatSignals, registerChatCommands } from './chatCommands.svelte.ts';

	let selectedId = $state<string | null>(null);
	let composingNew = $state(false);
	let showList = $state(false);
	let busy = $state(false);
	let input = $state('');
	let files = $state<Attachment[]>([]);
	/** Files attached with `#` (or brought back by Edit). */
	let picked = $state<{ path: string; range?: { startLine: number; endLine: number } }[]>([]);
	/** The active file whose implicit chip the user turned off. */
	let implicitOff = $state<string | null>(null);
	/** Edit request: the input holds an earlier request, sent as a new message. */
	let editing = $state(false);
	let renamingId = $state<string | null>(null);
	let renameText = $state('');
	/** New chat picks: where it runs ('' = this folder, else a task slug), model, mode. */
	let newWhere = $state('');
	let newModel = $state(chats.defaults().model ?? '');
	let newMode = $state<ChatMode>(modeOf(chats.defaults().permissionMode));
	/** Agent mode's approval, kept while Ask is picked. */
	let approval = $state<AgentApproval>(chats.defaults().permissionMode === 'acceptEdits' ? 'acceptEdits' : 'default');
	/** Where the last model / mode change took effect, shown under the input. */
	let optionNote = $state('');
	let composer: ReturnType<typeof Composer> | undefined = $state();
	let modelPicker: HTMLSelectElement | undefined = $state();
	/** `.claude/commands` and skills of where the chat runs (for a chat with no session list yet). */
	let fileCommands = $state<FileCommand[]>([]);
	let root: HTMLDivElement;

	const chatMeta = $derived(selectedId ? chats.get(selectedId) : undefined);
	const chatRun = $derived(selectedId ? chats.run(selectedId) : undefined);
	const turns = $derived(chatRun ? buildTurns(chatRun) : []);
	const history = $derived(promptHistory(turns));
	const queued = $derived(chatMeta ? chats.queue(chatMeta.id) : []);
	const chatLive = $derived(!!chatRun && !chatRun.ended);
	const running = $derived(turnBusy(chatRun));
	const sections = $derived(
		historySections(
			chats.list,
			adeTasks.list.map((x) => ({ slug: x.slug, title: x.title, created_at: x.created_at, updated_at: x.updated_at, terminal: !!cliOf(x.agent) })),
			(r) => (r.kind === 'chat' ? chats.run(r.id)?.status : runtime.run(r.slug)?.status)
		)
	);
	/** The history's chats by Today / Yesterday / Last 7 days / Older. */
	const chatGroups = $derived(groupByDate(sections.chats, Date.now()));
	const GROUP_LABEL: Record<DateGroup, () => string> = {
		today: () => t('chat.history.today'),
		yesterday: () => t('chat.history.yesterday'),
		week: () => t('chat.history.week'),
		older: () => t('chat.history.older')
	};
	const taskWorktrees = $derived(adeTasks.worktrees.filter((w) => w.slug).map((w) => w.slug as string));
	const cwd = $derived(workspace.root && chatMeta ? chatCwdPath(workspace.root, chatMeta.cwd) : workspace.root);
	const mode = $derived(chatMeta ? modeOf(chatMeta.permission_mode) : newMode);
	const allowAll = $derived(chatMeta ? chats.isAllowAll(chatMeta.id) : approval === 'bypassPermissions');
	const queueAction = $derived(queueDefault(settings.get<string>('kingu.chat.requestQueuing.defaultAction')));

	// `/` commands: Kingu's own (run here, never sent), then the session's, then the folder's files.
	const localCommands = $derived(
		kinguCommands(
			{
				clear: () => newChat(),
				model: () => queueMicrotask(() => modelPicker?.focus()),
				fork: chatMeta ? () => fork(null) : undefined
			},
			(name) => (name === 'clear' ? t('chatInput.slash.clear') : name === 'model' ? t('chatInput.slash.model') : t('chatInput.slash.fork'))
		)
	);
	const slashCommands = $derived(mergeCommands(localCommands, chatRun?.commands ?? [], fileCommands));

	$effect(() => {
		const dir = cwd;
		if (!dir) return;
		let stale = false;
		invoke<FileCommand[]>('chat_slash_commands', { cwd: dir })
			.then((list) => !stale && (fileCommands = list))
			.catch(() => !stale && (fileCommands = []));
		return () => (stale = true);
	});

	// Implicit context (VS Code's "current file"): the active editor's file and selection.
	const activeFile = $derived(isFileKey(editors.active) ? editors.active : null);
	const implicit = $derived(activeFile ? { path: activeFile, range: editors.selection.range, implicit: true, disabled: implicitOff === activeFile } : null);
	const contextChips = $derived([...(implicit && !picked.some((p) => p.path === implicit.path && !p.range) ? [implicit] : []), ...picked]);

	onMount(() => {
		chatSignals.el = root;
		const off = registerChatCommands();
		return () => {
			off();
			if (chatSignals.el === root) chatSignals.el = null;
		};
	});

	// ⌃⌘I / ⌘L: focus the input. ⌘N in the chat: a new chat. Only requests made while mounted
	// count (the panel is mounted again for every folder).
	let seenFocus = chatSignals.focus;
	let seenNew = chatSignals.newChat;
	$effect(() => {
		const n = chatSignals.focus;
		if (n === seenFocus) return;
		seenFocus = n;
		untrack(() => queueMicrotask(() => composer?.focus()));
	});
	$effect(() => {
		const n = chatSignals.newChat;
		if (n === seenNew) return;
		seenNew = n;
		untrack(() => newChat());
	});
	// A clicked chat notification: show that chat.
	let seenOpen = chatSignals.open?.n;
	$effect(() => {
		const req = chatSignals.open;
		if (!req || req.n === seenOpen) return;
		seenOpen = req.n;
		untrack(() => chats.get(req.id) && select(req.id));
	});

	// A different folder: its chats, the most recent one shown.
	$effect(() => {
		void workspace.root;
		untrack(() => {
			selectedId = null;
			composingNew = false;
			showList = false;
			void chats.load();
		});
	});

	// Drop a removed chat; with nothing selected, show the most recent one (or a new chat).
	$effect(() => {
		if (selectedId && chats.loaded && !chats.get(selectedId)) selectedId = null;
		if (selectedId === null && !composingNew && chats.loaded) selectedId = initialChat(chats.list);
	});

	// Settings load after the panel: pick up the default model once it is known.
	$effect(() => {
		if (!newModel) newModel = chats.defaults().model ?? '';
	});

	// A chat opened after a restart: rebuild its list from the saved transcript.
	$effect(() => {
		if (!selectedId) return;
		const id = selectedId;
		untrack(() => void chats.open(id));
	});

	function resetInput() {
		input = '';
		files = [];
		picked = [];
		editing = false;
	}

	function select(id: string) {
		selectedId = id;
		composingNew = false;
		showList = false;
		renamingId = null;
		optionNote = '';
		editing = false;
	}

	function newChat() {
		selectedId = null;
		composingNew = true;
		showList = false;
		renamingId = null;
		optionNote = '';
		resetInput();
		const d = chats.defaults();
		newModel = d.model ?? '';
		newMode = modeOf(d.permissionMode);
		queueMicrotask(() => composer?.focus());
	}

	/** The request's prompt: the text and its attached files (read now), plus its images. */
	async function outgoing(text: string, attachments: Attachment[], runsInRoot: boolean) {
		const rootDir = workspace.root ?? '';
		const dropped = attachments.filter((a) => !a.image).map((a) => ({ path: relativeTo(workspace.root, a.path) }));
		const list = [...(implicit && !implicit.disabled ? [implicit] : []), ...picked, ...dropped];
		const context = await resolveContext(list, (rel) => invoke<string>('read_workspace_file', { rel }), (rel) => promptPath(rel, rootDir, runsInRoot));
		return { text: assemblePrompt(text, context), images: attachments.filter((a) => a.image).map((a) => a.path), files: list.map((f) => f.path) };
	}

	async function submit(text: string, attachments: Attachment[], how?: SendHow) {
		if (busy) return;
		// Kingu's own commands run here; every other `/command` goes to the agent as text.
		const local = localCommandFor(text, localCommands);
		if (local) {
			if (local.command.name !== 'clear') resetInput();
			await local.command.run(local.args);
			return;
		}
		busy = true;
		try {
			if (!chatMeta) {
				const where: ChatCwd = newWhere ? { kind: 'task', slug: newWhere } : { kind: 'folder' };
				const message = await outgoing(text, attachments, where.kind === 'folder');
				const id = await chats.create({ prompt: text, cwd: where, model: newModel.trim() || chats.defaults().model, permissionMode: permissionFor(newMode, approval), message });
				if (id) {
					select(id);
					resetInput();
				}
				return;
			}
			const message = await outgoing(text, attachments, chatMeta.cwd.kind === 'folder');
			const sent = await chats.submit(chatMeta.id, message, text, how);
			if (sent) resetInput();
		} catch (e) {
			status.flash(t('chat.sendFailed', { error: String(e) }), 10000);
		} finally {
			busy = false;
		}
	}

	function editRequest(req: NonNullable<Turn['request']>) {
		input = req.text;
		// Prompt paths are workspace-relative, or absolute under the folder when the chat runs in a task worktree.
		picked = req.files.map((f) => ({ path: relativeTo(workspace.root, f.path), ...(f.range ? { range: f.range } : {}) }));
		files = [];
		editing = true;
		queueMicrotask(() => composer?.focus());
	}

	/** Restore Checkpoint put the request back in an empty input, with its files (VS Code's restoreRequestToMainInputIfEmpty). */
	function restoreToInput(req: NonNullable<Turn['request']>) {
		if (input.trim() || picked.length || files.length) return;
		editRequest(req);
		editing = false;
	}

	/** Edit request in place: the chat rewinds to it, then the new text goes with the request's files (read now). */
	async function editInline(req: NonNullable<Turn['request']>, checkpoint: number, text: string) {
		if (!chatMeta || !workspace.root) return;
		const id = chatMeta.id;
		const rootDir = workspace.root;
		const runsInRoot = chatMeta.cwd.kind === 'folder';
		const list = req.files.map((f) => ({ path: relativeTo(rootDir, f.path), ...(f.range ? { range: f.range } : {}) }));
		const context = await resolveContext(list, (rel) => invoke<string>('read_workspace_file', { rel }), (rel) => promptPath(rel, rootDir, runsInRoot));
		// Its images go again while the app still knows their files (the last request's).
		const known = chats.lastSent(id);
		const images = known && known.text === withoutImagesLine(req.sent) ? known.images : [];
		await chatRewind.editAndSend(id, checkpoint, { text: assemblePrompt(text, context), images });
	}

	async function fork(request: number | null) {
		if (!chatMeta) return;
		const id = await chats.fork(chatMeta.id, request);
		if (id) select(id);
	}

	async function pickFile() {
		const all = await invoke<string[]>('fs_list_files').catch(() => [] as string[]);
		const item = await quick.choose({
			placeholder: t('chatView.pickFile'),
			items: [],
			dynamic: (q) => {
				const ranked = rankFiles(q, all, recentFiles.list, 50);
				const list = ranked.length ? ranked.map((r) => r.path) : q ? [] : all.slice(0, 50);
				return list.map((path) => ({ id: path, label: path.split('/').pop() || path, description: path, icon: path }));
			}
		});
		if (item && !picked.some((p) => p.path === item.id && !p.range)) picked = [...picked, { path: item.id }];
		queueMicrotask(() => composer?.focus());
	}

	/** "Allow all" asks once per app session (a native warning) before any chat uses it. */
	async function confirmAllowAll(): Promise<boolean> {
		if (chats.allowAllConfirmed) return true;
		const ok = await ask(t('chatInput.allowAllConfirm'), { kind: 'warning', okLabel: t('chatInput.allowAll') });
		if (ok) chats.allowAllConfirmed = true;
		return ok;
	}

	async function pickApproval(select: HTMLSelectElement) {
		const next = select.value as AgentApproval;
		if (next === 'bypassPermissions' && !(await confirmAllowAll())) {
			select.value = allowAll ? 'bypassPermissions' : chatMeta ? (chatMeta.permission_mode ?? 'default') : approval;
			return;
		}
		await setMode('agent', next);
	}

	/** Compact (the context ring): `/compact` to the agent, queued while a turn runs. */
	function compact() {
		if (chatMeta) void chats.submit(chatMeta.id, { text: '/compact', images: [] }, '/compact');
	}

	/** Edit on a queued row: back into the input (its attached context is read again on send). */
	function editQueued(n: number) {
		const item = chatMeta && chats.takeQueued(chatMeta.id, n);
		if (!item) return;
		input = item.label;
		queueMicrotask(() => composer?.focus());
	}

	async function setMode(next: ChatMode, nextApproval = approval) {
		approval = nextApproval;
		if (!chatMeta) {
			newMode = next;
			return;
		}
		const when = await chats.setPermissionMode(chatMeta.id, permissionFor(next, nextApproval));
		optionNote = when === 'live' ? t('chat.panel.appliedNow') : when === 'next' ? t('chat.panel.appliedNext') : '';
	}

	async function changeModel(model: string) {
		if (!chatMeta) {
			newModel = model;
			return;
		}
		const when = await chats.setModel(chatMeta.id, model);
		optionNote = when === 'live' ? t('chat.panel.appliedNow') : when === 'next' ? t('chat.panel.appliedNext') : '';
	}

	function startRename(id: string, title: string) {
		renameText = title;
		renamingId = id;
	}

	function finishRename(save: boolean) {
		if (!renamingId) return;
		if (save) chats.rename(renamingId, renameText);
		renamingId = null;
	}

	async function removeChat(id: string) {
		const meta = chats.get(id);
		if (!meta) return;
		const ok = await ask(t('chat.panel.deleteConfirm', { title: meta.title }), { kind: 'warning', okLabel: t('common.delete') });
		if (ok && (await chats.remove(id)) && selectedId === id) selectedId = null;
	}

	/** "Promote to task": a new ADE task (own worktree) started with the chat's first prompt. The chat stays. */
	async function promote() {
		if (!chatMeta) return;
		busy = true;
		try {
			await adeTasks.create({ title: chatMeta.title, prompt: chatMeta.prompt || chatMeta.title, base: '', mode: 'timeline', open: false });
		} finally {
			busy = false;
		}
	}

	function openTaskInAgents(slug: string) {
		appMode.setMode('agents');
		adeTasks.openTask(slug);
	}

	const cwdLabel = (where: ChatCwd) => (where.kind === 'folder' ? workspace.name || t('chat.panel.cwdFolder') : `kingu/${where.slug}`);
	const APPROVAL_LABEL: Record<AgentApproval, () => string> = {
		default: () => t('chat.panel.mode.default'),
		acceptEdits: () => t('chat.panel.mode.acceptEdits'),
		bypassPermissions: () => t('chatInput.allowAll')
	};
	/** Model choices: the default from settings, the chat's own, and Claude's aliases. */
	function modelChoices(current: string | null): string[] {
		const d = chats.defaults().model;
		return [...new Set([current, d, 'opus', 'sonnet', 'haiku'].filter((m): m is string => !!m))];
	}
	const STATE_DOT = { working: 'bg-(--vscode-editorInfo-foreground) animate-pulse', needsInput: 'bg-(--vscode-editorWarning-foreground)' } as const;
	const STATE_LABEL = { working: () => t('team.agent.status.running'), needsInput: () => t('team.agent.status.waiting') } as const;
	const ICON_BTN = 'grid size-[22px] shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
	const CHIP_SELECT =
		'h-5 max-w-32 truncate rounded-sm border border-transparent bg-transparent text-xs text-(--vscode-descriptionForeground) outline-none hover:border-(--vscode-widget-border) focus:border-(--vscode-focusBorder)';
	// Starters fill the prompt (they never send), like the Agents layout's empty composer.
	const STARTERS = [
		{ icon: 'bug', label: () => t('chat.panel.starter.bug'), text: () => t('chat.panel.starter.bugText') },
		{ icon: 'check', label: () => t('chat.panel.starter.test'), text: () => t('chat.panel.starter.testText') },
		{ icon: 'code', label: () => t('chat.panel.starter.explain'), text: () => t('chat.panel.starter.explainText') }
	] as const;
	const title = $derived(chatMeta?.title ?? t('chat.panel.newChat'));
	const placeholder = $derived(
		!workspace.root
			? t('chat.panel.noFolder')
			: !chatMeta
				? t('chat.panel.placeholderStart')
				: running
					? t('chatView.placeholderQueue')
					: mode === 'ask'
						? t('chatView.placeholderAsk')
						: t('chatView.placeholderAgent')
	);
</script>

<div bind:this={root} class="flex h-full flex-col text-[13px]" data-chat-view>
	<!-- Title actions (VS Code's chat view title): history, the chat's title, new chat, Agents. -->
	<div class="flex h-[30px] shrink-0 items-center gap-1 px-2">
		<button
			class={[ICON_BTN, showList && 'bg-(--vscode-toolbar-activeBackground)']}
			aria-label={t('chatView.history')}
			title={t('chatView.history')}
			aria-pressed={showList}
			onclick={() => (showList = !showList)}><Icon name="menu" size={16} /></button
		>
		<span class="min-w-0 flex-1 truncate" {title}>{showList ? t('chatView.history') : title}</span>
		<button class={ICON_BTN} aria-label={t('chat.panel.newChat')} title={t('chatView.newChatKey')} disabled={!workspace.root} onclick={newChat}><Icon name="plus" size={16} /></button>
		<button class={ICON_BTN} aria-label={t('chat.panel.openInAgents')} title={t('chat.panel.openInAgents')} onclick={() => appMode.setMode('agents')}>
			<Icon name="agentsLayout" size={16} />
		</button>
	</div>

	{#if !showList && chatMeta}
		<div class="flex shrink-0 items-center gap-2 px-3 pb-1.5 text-xs text-(--vscode-descriptionForeground)">
			{#if chatRun && !chatRun.ended}<span class={['size-2 shrink-0 rounded-full', running ? STATE_DOT.working : 'bg-[#73C991]']} title={STATUS_LABEL[chatRun.status]}></span>{/if}
			<span class="flex min-w-0 flex-1 items-center gap-1 truncate" title={t('chat.panel.cwdLabel')}>
				<Icon name={chatMeta.cwd.kind === 'folder' ? 'folder' : 'branch'} size={12} />
				<span class="truncate font-mono">{cwdLabel(chatMeta.cwd)}</span>
			</span>
			{#if chatLive}
				<button class="hover:text-(--vscode-errorForeground)" title={t('chat.panel.endSession')} onclick={() => chatMeta && chats.stop(chatMeta.id)}>{t('chat.panel.endSessionLabel')}</button>
			{/if}
			<button class={ICON_BTN} aria-label={t('chat.panel.rename')} title={t('chat.panel.rename')} onclick={() => chatMeta && ((showList = true), startRename(chatMeta.id, chatMeta.title))}>
				<Icon name="edit" size={13} />
			</button>
			<button class={ICON_BTN} aria-label={t('chat.panel.promote')} title={t('chat.panel.promoteHint')} disabled={busy} onclick={promote}><Icon name="tasks" size={13} /></button>
			<button class={ICON_BTN} aria-label={t('chat.panel.delete')} title={t('chat.panel.delete')} disabled={chatLive} onclick={() => chatMeta && removeChat(chatMeta.id)}><Icon name="trash" size={13} /></button>
		</div>
	{/if}

	<div class="min-h-0 flex-1 overflow-hidden border-t border-(--vscode-sideBar-border)">
		{#if showList}
			<!-- History (VS Code's agent sessions): chats, then the folder's ADE tasks (read-only here). -->
			<div class="h-full overflow-y-auto py-1">
				<ul aria-label={t('chatView.chats')}>
					{#each chatGroups as g (g.group)}
						<li class="px-3 pt-2 pb-1 text-[11px] font-medium text-(--vscode-descriptionForeground) uppercase" role="presentation">{GROUP_LABEL[g.group]()}</li>
						{#each g.rows as r (r.id)}
						<li
							class={[
								'group/row flex h-[38px] items-center gap-2 px-3 hover:bg-(--vscode-list-hoverBackground)',
								selectedId === r.id && 'bg-(--vscode-list-inactiveSelectionBackground)'
							]}
						>
							{#if renamingId === r.id}
								<input
									class="h-[22px] min-w-0 flex-1 rounded-sm border border-(--vscode-focusBorder) bg-(--vscode-input-background) px-1 text-[13px] text-(--vscode-input-foreground) outline-none"
									aria-label={t('chat.panel.rename')}
									bind:value={renameText}
									onkeydown={(e) => {
										if (e.key === 'Enter' && !e.isComposing) finishRename(true);
										else if (e.key === 'Escape') finishRename(false);
									}}
									onblur={() => finishRename(true)}
									{@attach (el) => el.focus()}
								/>
							{:else}
								<button class="flex min-w-0 flex-1 items-center gap-2 text-left" onclick={() => select(r.id)}>
									<span class="shrink-0 text-(--vscode-descriptionForeground)"><Icon name="agent" size={14} /></span>
									<span class="flex min-w-0 flex-1 flex-col">
										<span class="truncate">{r.title}</span>
										<span class="truncate text-xs text-(--vscode-descriptionForeground)">{r.state ? STATE_LABEL[r.state]() : timeAgo(r.at, Date.now())}</span>
									</span>
									{#if r.state}<span class={['size-2 shrink-0 rounded-full', STATE_DOT[r.state]]} title={STATE_LABEL[r.state]()}></span>{/if}
								</button>
								<span class="flex shrink-0 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100">
									<button class={ICON_BTN} aria-label={t('chat.panel.rename')} title={t('chat.panel.rename')} onclick={() => startRename(r.id, r.title)}><Icon name="edit" size={13} /></button>
									<button class={ICON_BTN} aria-label={t('chat.panel.delete')} title={t('chat.panel.delete')} disabled={!!r.state} onclick={() => removeChat(r.id)}><Icon name="trash" size={13} /></button>
								</span>
							{/if}
						</li>
						{/each}
					{:else}
						<li class="px-3 py-2 text-(--vscode-descriptionForeground)">{t('chatView.noChats')}</li>
					{/each}
				</ul>
				{#if sections.tasks.length}
					<div class="mt-2 px-3 pt-2 pb-1 text-[11px] font-medium text-(--vscode-descriptionForeground) uppercase">{t('chatView.adeSection')}</div>
					<ul aria-label={t('chatView.adeSection')}>
						{#each sections.tasks as r (r.slug)}
							<li class="flex h-[26px] items-center gap-1.5 px-3 text-(--vscode-descriptionForeground)" title={t('chatView.adeReadOnly')}>
								<Icon name={r.terminal ? 'terminal' : 'branch'} size={14} />
								<span class="min-w-0 flex-1 truncate">{r.title}</span>
								{#if r.state}<span class={['size-2 shrink-0 rounded-full', STATE_DOT[r.state]]} title={STATE_LABEL[r.state]()}></span>{/if}
								<button class="shrink-0 text-xs text-(--vscode-textLink-foreground) hover:underline" onclick={() => openTaskInAgents(r.slug)}>{t('chat.panel.openInAgentsShort')}</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{:else if chatMeta}
			<ChatList
				run={chatRun}
				{cwd}
				chatId={chatMeta.id}
				root={workspace.root}
				onanswer={(p, decision, message, answers) => chatMeta && chats.answer(chatMeta.id, p.request_id, decision, message, answers)}
				actions={{ retry: () => chatMeta && void chatRewind.retry(chatMeta.id), edit: editRequest, editInline }}
				reverted={(r) => !!chatMeta && chatEdits.isReverted(chatMeta.id, r)}
				class="h-full p-3"
			>
				{#snippet checkpoint(request, req, first)}
					{#if chatMeta}
						<RestoreCheckpoint chatId={chatMeta.id} {request} {first} onrestored={() => restoreToInput(req)} />
						<button class={ICON_BTN} aria-label={t('chatRewind.fork')} title={t('chatRewind.forkHint')} onclick={() => fork(request)}><Icon name="branch" size={13} /></button>
					{/if}
				{/snippet}
				{#snippet empty()}
					<p class="text-(--vscode-descriptionForeground)">{t('chat.panel.noHistory')}</p>
				{/snippet}
			</ChatList>
		{:else}
			<div class="grid h-full place-items-center p-6 text-center">
				<div class="flex max-w-72 flex-col items-center gap-2 text-(--vscode-descriptionForeground)">
					<span class="text-(--vscode-foreground)"><Icon name="agent" size={40} /></span>
					<p class="text-sm font-semibold text-(--vscode-foreground)">{t('chat.panel.emptyTitle')}</p>
					<p class="text-xs leading-5">{workspace.root ? t('chat.panel.emptyBody') : t('chat.panel.noFolder')}</p>
					<div class="mt-2 flex flex-wrap justify-center gap-1.5">
						{#each STARTERS as s (s.icon)}
							<button
								class="flex h-7 items-center gap-1.5 rounded-full border border-(--vscode-widget-border) px-3 text-xs hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)"
								onclick={() => (input = input.trim() ? `${s.text()}${input}` : s.text())}
							>
								<Icon name={s.icon} size={13} />{s.label()}
							</button>
						{/each}
					</div>
				</div>
			</div>
		{/if}
	</div>

	{#if !showList}
		<div class="shrink-0 p-2">
			<!-- chat edits bar -->
			{#if chatMeta}<ChatTodoBar {turns} {running} />{/if}
			{#if chatMeta}<ChatEditsBar chatId={chatMeta.id} />{/if}
			{#if chatMeta && chatRewind.canRedo(chatMeta.id)}
				<div class="mb-1.5 flex items-center gap-1.5 rounded border border-(--vscode-widget-border) px-2 py-1 text-xs text-(--vscode-descriptionForeground)" role="status">
					<Icon name="discard" size={12} />
					<span class="min-w-0 flex-1">{t('chatRewind.restored')}</span>
					<button class="shrink-0 text-(--vscode-textLink-foreground) hover:underline" title={t('chatRewind.redoHint')} onclick={() => chatMeta && chatRewind.redo(chatMeta.id)}>{t('chatRewind.redo')}</button>
				</div>
			{/if}
			{#if queued.length}
				<ul class="mb-1.5 space-y-1" aria-label={t('chatView.queued')}>
					{#each queued as q (q.n)}
						<li class="flex items-center gap-1.5 rounded border border-dashed border-(--vscode-widget-border) px-2 py-1 text-xs text-(--vscode-descriptionForeground)">
							<Icon name="clock" size={12} />
							<span class="min-w-0 flex-1 truncate" title={q.label}>{t('chatView.queuedItem', { text: q.label })}</span>
							<button class={ICON_BTN} aria-label={t('chatInput.queue.edit')} title={t('chatInput.queue.editHint')} onclick={() => editQueued(q.n)}><Icon name="edit" size={12} /></button>
							<button class={ICON_BTN} aria-label={t('chatInput.queue.sendNow')} title={t('chatInput.queue.sendNowHint')} onclick={() => chatMeta && void chats.sendQueuedNow(chatMeta.id, q.n)}
								><Icon name="send" size={12} /></button
							>
							<button class={ICON_BTN} aria-label={t('chatView.unqueue')} title={t('chatView.unqueue')} onclick={() => chatMeta && chats.unqueue(chatMeta.id, q.n)}><Icon name="close" size={12} /></button>
						</li>
					{/each}
				</ul>
			{/if}
			{#if editing}
				<div class="mb-1.5 flex items-start gap-1.5 rounded border border-(--vscode-widget-border) px-2 py-1 text-xs text-(--vscode-descriptionForeground)" role="note">
					<Icon name="info" size={12} />
					<span class="min-w-0 flex-1">{t('chatView.editNotice')}</span>
					<button class="shrink-0 text-(--vscode-textLink-foreground) hover:underline" onclick={resetInput}>{t('common.cancel')}</button>
				</div>
			{/if}
			<Composer
				bind:this={composer}
				bind:value={input}
				attach
				bind:attachments={files}
				{placeholder}
				disabled={!workspace.root}
				{busy}
				{history}
				{running}
				onstop={() => chatMeta && chats.interrupt(chatMeta.id)}
				onhash={pickFile}
				context={contextChips}
				oncontexttoggle={(f) => (implicitOff = implicitOff === f.path ? null : f.path)}
				oncontextremove={(f) => (picked = picked.filter((p) => !(p.path === f.path && p.range?.startLine === f.range?.startLine)))}
				sendLabel={running ? t('chatView.queue') : undefined}
				contextExtra={rulesChip}
				commands={slashCommands}
				queueDefault={queueAction}
				onsubmit={submit}
			>
				{#snippet footer()}
					{#if chatRun?.context}<ContextRing usage={chatRun.context} cost={chatRun.result?.total_cost_usd ?? null} oncompact={chatMeta ? compact : undefined} />{/if}
				{/snippet}
				{#snippet chips()}
					{#if !chatMeta}
						<select class={CHIP_SELECT} aria-label={t('chat.panel.cwdLabel')} title={t('chat.panel.cwdLabel')} bind:value={newWhere}>
							<option value="">{workspace.name || t('chat.panel.cwdFolder')}</option>
							{#each taskWorktrees as slug (slug)}<option value={slug}>kingu/{slug}</option>{/each}
						</select>
					{/if}
					<select class={CHIP_SELECT} aria-label={t('chatView.mode')} title={t('chatView.modeHint')} value={mode} onchange={(e) => setMode(e.currentTarget.value as ChatMode)}>
						<option value="ask">{t('chatView.mode.ask')}</option>
						<option value="agent">{t('chatView.mode.agent')}</option>
					</select>
					{#if mode === 'agent'}
						<select
							class={CHIP_SELECT}
							aria-label={t('chat.panel.mode')}
							title={t('chat.panel.mode')}
							value={allowAll ? 'bypassPermissions' : chatMeta ? (chatMeta.permission_mode ?? 'default') : approval}
							onchange={(e) => pickApproval(e.currentTarget)}
						>
							{#each AGENT_APPROVALS as m (m)}<option value={m}>{APPROVAL_LABEL[m]()}</option>{/each}
						</select>
					{/if}
					<select
						bind:this={modelPicker}
						class={CHIP_SELECT}
						aria-label={t('chat.panel.model')}
						title={t('chat.panel.model')}
						value={chatMeta ? (chatMeta.model ?? '') : newModel}
						onchange={(e) => changeModel(e.currentTarget.value)}
					>
						{#each modelChoices(chatMeta ? chatMeta.model : newModel) as m (m)}<option value={m}>{m}</option>{/each}
					</select>
				{/snippet}
			</Composer>
			{#if optionNote}<p class="px-1 pt-1 text-xs text-(--vscode-descriptionForeground)" role="status">{optionNote}</p>{/if}
			{#if allowAll && mode === 'agent'}<p class="px-1 pt-1 text-xs text-(--vscode-editorWarning-foreground)" role="status">{t('chatInput.allowAllNote')}</p>{/if}
		</div>
	{/if}
</div>

{#snippet rulesChip()}
	<RulesChip {cwd} files={contextChips.filter((f) => !('disabled' in f && f.disabled)).map((f) => f.path)} />
{/snippet}
