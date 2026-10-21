<script lang="ts">
	// Agent panel (secondary side bar), laid out like VS Code's Chat view: title actions on top,
	// the chat's request/response list (ChatList), and the chat input (Composer, Cursor's agent
	// composer) pinned to the bottom: a toolbar stacked on it (status and Stop, the files changed
	// with Keep All / Undo All / Review, the queued messages, the edit banner), inline context
	// chips, and a bottom bar with the mode pill (Agent / Ask / Plan / custom agents, ⌘. or ⇧Tab),
	// the model label (⌘/), the options menu (runtime, folder, run mode) and the context ring.
	// Sessions are this folder's chats (`chats`: an agent-host session in the folder or a task's
	// worktree, persisted with its transcript). The history list (≡) shows them, and the folder's
	// ADE tasks in their own "Agents (ADE)" section as read-only rows that open in Agents. The
	// panel opens on the most recent chat, else a new one; never on a task. The chat never types
	// into a terminal and never starts a CLI.
	// Add Context (⌥⌘P, the composer's @ button, or `#` / `@` inline): files, folders, the selection,
	// problems, git changes, terminal output, a clipboard image, a past chat, instructions
	// (chatContextSources.svelte.ts). Export / Import Chat: a chat as a JSON file.
	import { onMount, untrack } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
	import { addAttachments, type Attachment } from './attachments.ts';
	import type { SuggestItem } from './SlashSuggest.svelte';
	import { contextFiles, mentionItems, pickContext, resolveMention, resolveSource, type ContextPick } from './chatContextSources.svelte.ts';
	import { folderContext } from './chatContext.ts';
	import { claudeModel, CODEBASE_HINT, expandPrompt, fromPick, modePick, pickerAgents, promptAgentPick, promptArgs, promptRequest, typedVariables, type Customizations, type ModePick, type PromptFile } from './customizations.ts';
	import { linesOf } from './chatPrompt.ts';
	import { CLAUDE_RUNTIME } from './runtimes.ts';
	import { modelCatalog } from './modelCatalog.svelte.ts';
	import { modelChoices, modelSublabel } from './modelChoices.ts';
	import ChatList from './ChatList.svelte';
	import Composer from './Composer.svelte';
	import ChatEditsBar from './ChatEditsBar.svelte';
	import ChatTodoBar from './ChatTodoBar.svelte';
	import RestoreCheckpoint from './RestoreCheckpoint.svelte';
	import ChatTranscriptTools from './ChatTranscriptTools.svelte';
	import SideChat from './SideChat.svelte';
	import { CONTINUE_PROMPT, withQuote } from './chatTranscript.ts';
	import ContextRing from './ContextRing.svelte';
	import { kinguCommands, localCommandFor, mergeCommands, modeCommands, type FileCommand, type SlashItem } from './slashCommands.ts';
	import ComposerMenu from './ComposerMenu.svelte';
	import ComposerQueue from './ComposerQueue.svelte';
	import type { ComposerChip } from './Composer.svelte';
	import type { MenuRow } from './composerMenu.ts';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { canSteer, composerPlaceholder, customName, cycleMode, MODE_ICON, modeOrder, modeTone, runModeHint, runModeLabel, shortModelLabel, type ModeTone } from './composer.ts';
	import { arkaiGroups, needsKey } from './arkai.ts';
	import type { QueuedMessage } from './chats.svelte.ts';
	import { queueDefault, type SendHow } from './requestQueuing.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { chatEdits } from './chatEdits.svelte.ts';
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import { runtime } from '#lib/ade/runtime.svelte.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { editors } from '#lib/workbench/editors.svelte.ts';
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
	import { assemblePrompt, contextLabel, isFileKey, promptPath, relativeTo, resolveContext, withoutImagesLine, type ContextText } from './chatPrompt.ts';
	import { AGENT_APPROVALS, modeOf, permissionFor, turnBusy, type AgentApproval, type ChatMode } from './chatInput.ts';
	import { buildTurns, feedbackTarget, promptHistory, type Turn } from './chatParts.ts';
	import { chatSignals, registerChatCommands } from './chatCommands.svelte.ts';
	import { agentRuntimes } from './runtimes.svelte.ts';
	import { runtimeChoices, runtimeOf } from './runtimes.ts';
	import { arkaiProviders } from './arkai.svelte.ts';
	import { ARKAI_RUNTIME, arkaiDefault } from './arkai.ts';
	import { chatExtras } from './chatExtras.svelte.ts';
	import { layout } from '#lib/workbench/layout.svelte.ts';
	import { defaultModePick, pastedContext } from './chatSettings.ts';
	import { saveBeforeSend } from './chatSettings.svelte.ts';
	import ChatHistoryFilter from './ChatHistoryFilter.svelte';
	import { chatHistory } from './chatHistory.svelte.ts';
	import { filterChats, isFiltered, snippetParts, type SearchHit } from './chatHistory.ts';
	import { chatTools } from './chatTools.svelte.ts';
	import { openChatDebug } from './chatDebugCommands.ts';

	let {
		editorChatId
	}: {
		/** Open Chat in Editor (ChatEditor.svelte): the panel shows only this chat, in an editor tab, and none of the side bar's commands. */
		editorChatId?: string;
	} = $props();
	const inEditor = untrack(() => !!editorChatId);

	let selectedId = $state<string | null>(untrack(() => editorChatId ?? null));
	let composingNew = $state(false);
	/** The panel showed its first chat of the folder (chat.restoreLastPanelSession decides which). */
	let panelStarted = false;
	let showList = $state(false);
	let busy = $state(false);
	let input = $state('');
	let files = $state<Attachment[]>([]);
	/** Files attached with `#` (or brought back by Edit). */
	let picked = $state<{ path: string; range?: { startLine: number; endLine: number } }[]>([]);
	/** Add Context's other context (problems, a diff, terminal output, a folder, a past chat). */
	let texts = $state<ContextText[]>([]);
	/** Edit request: the input holds an earlier request, sent as a new message. */
	let editing = $state(false);
	let renamingId = $state<string | null>(null);
	let renameText = $state('');
	/** New chat picks: where it runs ('' = this folder, else a task slug), model, mode. */
	let newWhere = $state('');
	let newModel = $state(chats.defaults().model ?? '');
	let newMode = $state<ChatMode>(modeOf(chats.defaults().permissionMode));
	/** The new chat's agent (runtimes.ts); kept for the next new chat. */
	let newRuntime = $state(runtimeOf(null));
	/** Agent mode's approval, kept while Ask is picked. */
	let approval = $state<AgentApproval>(chats.defaults().permissionMode === 'acceptEdits' ? 'acceptEdits' : 'default');
	/** Where the last model / mode change took effect, shown under the input. */
	let optionNote = $state('');
	let composer: ReturnType<typeof Composer> | undefined = $state();
	/** The composer's open dropdown: the mode pill's, the model picker or the options menu. */
	let menuOpen = $state<'mode' | 'model' | 'options' | null>(null);
	/** A queued message being edited in the input: it goes back to `index` when sent or cancelled. */
	let editingQueued = $state<{ item: QueuedMessage; index: number } | null>(null);
	/** `.claude/commands` and skills of where the chat runs (for a chat with no session list yet). */
	let fileCommands = $state<FileCommand[]>([]);
	/** VS Code's prompt files and custom agents of where the chat runs (Rust customizations.rs). */
	let customs = $state<Customizations>({ prompts: [], agents: [] });
	/** The new chat's agent: Ask or a custom agent (null: Agent / Plan by `newMode`). */
	let newAgent = $state<string | null>(null);
	let root: HTMLDivElement;
	/** The box holding the chat list (Find in Chat, the selection bar and the side chat sit over it). */
	let listBox: HTMLDivElement | undefined = $state();
	/** Ask in Side Chat: the drawer's chat and excerpt, shown while that chat is. */
	let side = $state<{ parent: string; excerpt: string } | null>(null);

	const chatMeta = $derived(selectedId ? chats.get(selectedId) : undefined);
	/** The chat's agent and what it can do: rewind and the model picker are the Claude SDK's. */
	const runtimeId = $derived(chatMeta ? runtimeOf(chatMeta) : newRuntime);
	const features = $derived(agentRuntimes.features(runtimeId));
	const chatRun = $derived(selectedId ? chats.run(selectedId) : undefined);
	const turns = $derived(chatRun ? buildTurns(chatRun) : []);
	const history = $derived(promptHistory(turns));
	const queued = $derived(chatMeta ? chats.queue(chatMeta.id) : []);
	const chatLive = $derived(!!chatRun && !chatRun.ended);
	const running = $derived(turnBusy(chatRun));
	const sections = $derived(
		historySections(
			chats.visible,
			adeTasks.list.map((x) => ({ slug: x.slug, title: x.title, created_at: x.created_at, updated_at: x.updated_at, terminal: !!cliOf(x.agent) })),
			(r) => (r.kind === 'chat' ? chats.run(r.id)?.status : runtime.run(r.slug)?.status)
		)
	);
	/** The history's search and filters (chatHistory.svelte.ts): the rows kept, with a transcript snippet each. */
	const historyFilter = $derived(chatHistory.filter);
	const filteredChats = $derived(
		isFiltered(historyFilter)
			? filterChats(
					sections.chats.map((r) => ({ ...r, runtime: chats.get(r.id)?.runtime })),
					historyFilter,
					chatHistory.facts(historyFilter.query.trim() ? chatHistory.hitsFor(historyFilter.query) : null)
				)
			: null
	);
	const historyHits = $derived(new Map<string, SearchHit>((filteredChats ?? []).flatMap((x) => (x.hit ? [[x.chat.id, x.hit] as const] : []))));
	/** The history's chats by Today / Yesterday / Last 7 days / Older. */
	const chatGroups = $derived(groupByDate(filteredChats ? filteredChats.map((x) => x.chat) : sections.chats, Date.now()));
	// The chat commands act on (Show Agent Debug Logs, Configure Tools): the one shown here last.
	$effect(() => {
		const id = selectedId;
		if (id) untrack(() => (chatTools.current = id));
	});
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
				model: () => queueMicrotask(() => (menuOpen = 'model')),
				fork: chatMeta && features.rewind ? () => fork(null) : undefined
			},
			(name) => (name === 'clear' ? t('chatInput.slash.clear') : name === 'model' ? t('chatInput.slash.model') : t('chatInput.slash.fork'))
		)
	);
	/** The mode picker: Agent / Ask / Plan, then the folder's custom agents. */
	const chatAgent = $derived(chatMeta ? (chatMeta.agent ?? null) : newAgent);
	const pick = $derived(modePick(chatMeta ? chatMeta.permission_mode : mode === 'ask' ? 'plan' : 'default', chatAgent));
	const shownAgents = $derived(pickerAgents(customs.agents, chatAgent));
	const tone = $derived(modeTone(pick));
	/** ⌘. / ⇧Tab's order: Agent, Ask, Plan, the custom agents. */
	const modes = $derived(modeOrder(shownAgents.map((a) => a.name)));
	// `/agent`, `/ask`, `/plan`, `/<custom agent>` (the `/` menu's Modes): switch, then send what follows.
	const modeSlash = $derived(
		modeCommands(
			modes.map((m) => ({
				name: customName(m)?.replace(/\s+/g, '-') ?? m,
				label: t('composer.slash.modeSwitch', { mode: modeName(m) }),
				run: () => applyPick(m)
			}))
		)
	);
	const ownCommands = $derived([...localCommands, ...modeSlash]);
	const slashCommands = $derived(mergeCommands(ownCommands, chatRun?.commands ?? [], fileCommands, customs.prompts));

	$effect(() => {
		const dir = cwd;
		if (!dir) return;
		let stale = false;
		invoke<FileCommand[]>('chat_slash_commands', { cwd: dir })
			.then((list) => !stale && (fileCommands = list))
			.catch(() => !stale && (fileCommands = []));
		void loadCustomizations(dir, () => stale);
		return () => (stale = true);
	});

	async function loadCustomizations(dir: string | null = cwd, stale: () => boolean = () => false) {
		if (!dir) return;
		const got = await invoke<Customizations>('chat_customizations', { cwd: dir }).catch(() => ({ prompts: [], agents: [] }) as Customizations);
		if (!stale()) customs = got;
	}

	// Implicit context (VS Code's "current file"): the active editor's file and selection.
	const activeFile = $derived(isFileKey(editors.active) ? editors.active : null);
	// Nothing is attached without asking (Cursor has no current-file chip): `@` offers the active
	// editor's file first instead.
	const contextChips = $derived(picked);

	onMount(() => {
		if (inEditor) return;
		chatSignals.el = root;
		void agentRuntimes.load();
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
	let seenAdd = chatSignals.addContext;
	let seenExport = chatSignals.exportChat;
	let seenImport = chatSignals.importChat;
	// The side bar's panel takes these; a chat in an editor tab does not.
	$effect(() => {
		const n = chatSignals.addContext;
		if (n === seenAdd || inEditor) return;
		seenAdd = n;
		untrack(() => void addContext());
	});
	$effect(() => {
		const n = chatSignals.exportChat;
		if (n === seenExport || inEditor) return;
		seenExport = n;
		untrack(() => void exportChat());
	});
	$effect(() => {
		const n = chatSignals.importChat;
		if (n === seenImport || inEditor) return;
		seenImport = n;
		untrack(() => void importChat());
	});
	$effect(() => {
		const n = chatSignals.focus;
		if (n === seenFocus || inEditor) return;
		seenFocus = n;
		untrack(() => queueMicrotask(() => composer?.focus()));
	});
	$effect(() => {
		const n = chatSignals.newChat;
		if (n === seenNew || inEditor) return;
		seenNew = n;
		untrack(() => newChat());
	});
	// ⌘. (and ⇧Tab in the input): the next mode. ⌘/: the model picker. Cancel Chat: stop the turn.
	let seenMode = chatSignals.nextMode;
	let seenModel = chatSignals.modelPicker;
	let seenCancel = chatSignals.cancel;
	$effect(() => {
		const n = chatSignals.nextMode;
		if (n === seenMode || inEditor) return;
		seenMode = n;
		untrack(() => void nextMode());
	});
	$effect(() => {
		const n = chatSignals.modelPicker;
		if (n === seenModel || inEditor) return;
		seenModel = n;
		untrack(() => (features.models || runtimeId === ARKAI_RUNTIME) && (menuOpen = 'model'));
	});
	$effect(() => {
		const n = chatSignals.cancel;
		if (n === seenCancel || inEditor) return;
		seenCancel = n;
		untrack(() => chatMeta && running && void chats.interrupt(chatMeta.id));
	});
	$effect(() => {
		if (runtimeId === ARKAI_RUNTIME) void arkaiProviders.load();
	});
	// A clicked chat notification: show that chat.
	let seenOpen = chatSignals.open?.n;
	$effect(() => {
		const req = chatSignals.open;
		if (!req || req.n === seenOpen || inEditor) return;
		seenOpen = req.n;
		untrack(() => chats.get(req.id) && select(req.id));
	});

	// A different folder: its chats, the most recent one shown.
	$effect(() => {
		void workspace.root;
		untrack(() => {
			if (inEditor) return void (chats.root !== workspace.root && chats.load());
			selectedId = null;
			composingNew = false;
			showList = false;
			void chats.load();
		});
	});

	// Drop a removed chat; with nothing selected, show the most recent one (or a new chat).
	$effect(() => {
		if (inEditor) return;
		if (selectedId && chats.loaded && !chats.get(selectedId)) selectedId = null;
		if (selectedId === null && !composingNew && chats.loaded) {
			// The folder just opened: chat.restoreLastPanelSession (VS Code's default: off) shows the
			// most recent chat, else a new one. Later (a chat removed), the most recent one.
			const fresh = !panelStarted && settings.get<boolean>('chat.restoreLastPanelSession') !== true;
			panelStarted = true;
			if (fresh) untrack(() => newChat(false));
			else selectedId = initialChat(chats.visible);
		}
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
		texts = [];
		editing = false;
		editingQueued = null;
	}

	function select(id: string) {
		// A chat editor tab shows one chat: another one (a fork) opens in its own tab.
		if (inEditor && id !== editorChatId) return chatExtras.openInEditor(id);
		selectedId = id;
		composingNew = false;
		showList = false;
		renamingId = null;
		optionNote = '';
		editing = false;
	}

	function newChat(focus = true) {
		// From a chat editor tab: the side bar starts it.
		if (inEditor) return void ((layout.auxVisible = true), chatSignals.newChat++);
		selectedId = null;
		composingNew = true;
		showList = false;
		renamingId = null;
		optionNote = '';
		resetInput();
		const d = chats.defaults();
		newModel = d.model ?? '';
		newMode = modeOf(d.permissionMode);
		const preset = settings.get<string>('chat.newSession.defaultMode');
		if (typeof preset === 'string' && preset.trim()) void startMode(preset);
		if (focus) queueMicrotask(() => composer?.focus());
	}

	/** chat.pasteAsAttachmentThreshold: a long paste becomes a context chip instead of input text. */
	function attachPaste(text: string): boolean {
		const c = pastedContext(text, settings.get('chat.pasteAsAttachmentThreshold'));
		if (!c) return false;
		texts = [...texts, c];
		return true;
	}

	/** chat.newSession.defaultMode: the new chat's mode (a custom agent once the folder's agents are read). */
	async function startMode(preset: string) {
		let p = defaultModePick(preset, customs.agents);
		if (!p) {
			await loadCustomizations();
			p = defaultModePick(preset, customs.agents);
		}
		if (p && !chatMeta) await applyPick(p);
	}

	/** The request's prompt: the text and its attached files (read now), plus its images. */
	/**
	 * The `#` variables typed in the request (VS Code's chat variables: #selection, #problems,
	 * #changes, #terminalLastCommand, #file:…, #folder:…, #codebase) → what they attach.
	 */
	async function typedContext(text: string): Promise<{ files: { path: string; range?: { startLine: number; endLine: number } }[]; texts: ContextText[] }> {
		const out: { files: { path: string; range?: { startLine: number; endLine: number } }[]; texts: ContextText[] } = { files: [], texts: [] };
		const env = contextEnv();
		for (const v of typedVariables(text)) {
			let picks: ContextPick[] = [];
			if (v.kind === 'file') picks = [{ kind: 'file', path: v.path }];
			else if (v.kind === 'folder') picks = [{ kind: 'text', text: folderContext(v.path, contextFiles.list) }];
			else if (v.kind === 'codebase') picks = [{ kind: 'text', text: { kind: 'codebase', label: '#codebase', text: CODEBASE_HINT } }];
			else picks = await resolveSource(v.kind === 'changes' ? 'scm' : v.kind === 'terminalLastCommand' ? 'terminal' : v.kind, env);
			for (const p of picks) {
				if (p.kind === 'file') out.files.push({ path: relativeTo(workspace.root, p.path), ...(p.range ? { range: p.range } : {}) });
				else if (p.kind === 'text') out.texts.push(p.text);
			}
		}
		return out;
	}

	async function outgoing(text: string, attachments: Attachment[], runsInRoot: boolean, extra: ContextText[] = []) {
		const rootDir = workspace.root ?? '';
		const dropped = attachments.filter((a) => !a.image).map((a) => ({ path: relativeTo(workspace.root, a.path) }));
		if (typedVariables(text).some((v) => v.kind === 'folder')) await contextFiles.refresh(workspace.root);
		const typed = await typedContext(text);
		const list = [...picked, ...dropped, ...typed.files];
		const context = await resolveContext(list, (rel) => invoke<string>('read_workspace_file', { rel }), (rel) => promptPath(rel, rootDir, runsInRoot));
		const allTexts = [...texts, ...typed.texts.filter((x) => !texts.some((y) => y.kind === x.kind && y.label === x.label)), ...extra];
		return { text: assemblePrompt(text, context, allTexts), images: attachments.filter((a) => a.image).map((a) => a.path), files: list.map((f) => f.path) };
	}

	/** A prompt file's variables: the active editor's file, its selected text, the chat's folder. */
	async function promptVars() {
		const range = editors.selection.range;
		let selection: string | null = null;
		if (activeFile && range) selection = await invoke<string>('read_workspace_file', { rel: activeFile }).then((text) => linesOf(text, range)).catch(() => null);
		return { file: activeFile, selection, workspaceFolder: cwd };
	}

	/**
	 * `/name args` of a prompt file (VS Code's prompt files): its agent and model are picked, then
	 * the filled prompt goes as attached context of a request naming it.
	 */
	async function runPromptFile(file: PromptFile, args: string, attachments: Attachment[], how?: SendHow) {
		let run: { file: PromptFile; body: string };
		try {
			run = await invoke<{ body: string } & PromptFile>('chat_prompt_file', { cwd, name: file.name }).then((r) => ({ file: r, body: r.body }));
		} catch (e) {
			return void status.flash(String(e), 8000);
		}
		const target = promptAgentPick(run.file.agent, customs.agents);
		if (target && target !== pick) await applyPick(target);
		const model = runtimeId === CLAUDE_RUNTIME ? claudeModel(run.file.model) : null;
		if (model) await changeModel(model);
		const { inputs, rest } = promptArgs(args);
		const req = promptRequest(run.file, expandPrompt(run.body, inputs, await promptVars()), rest);
		await send(req.text, attachments, how, [req.context], `/${file.name}${args ? ` ${args}` : ''}`);
	}

	async function submit(text: string, attachments: Attachment[], how?: SendHow) {
		if (busy) return;
		// Kingu's own commands run here; every other `/command` goes to the agent as text.
		const local = localCommandFor(text, ownCommands);
		if (local) {
			if (local.command.name !== 'clear') resetInput();
			await local.command.run(local.args);
			// `/plan do this`: the mode, then the rest as the request.
			if (local.command.source === 'mode' && local.args) await send(local.args, attachments, how);
			return;
		}
		// A tool call waits: what is typed answers it (Cursor's "Reject, suggest, follow up?"): the
		// call is skipped ("Skipped rm") and the text goes as a new message the agent continues with
		// (steered into the running turn where the runtime can, else after it).
		if (chatMeta && pendingApproval && !editingQueued) {
			chats.answer(chatMeta.id, pendingApproval.request_id, 'deny');
			await send(text, attachments, steerable ? 'steer' : 'queue');
			return;
		}
		if (chatMeta && editingQueued) return saveQueuedEdit(text, attachments);
		const asPrompt = localCommandFor(text, customs.prompts);
		if (asPrompt) return runPromptFile(asPrompt.command, asPrompt.args, attachments, how);
		await send(text, attachments, how);
	}

	/** Sends a request (`extra`: context besides the input's; `title`: the new chat's first prompt). */
	async function send(text: string, attachments: Attachment[], how?: SendHow, extra: ContextText[] = [], title = text) {
		if (busy) return;
		busy = true;
		try {
			// chat.saveBeforeSend: the agent reads the files as you see them.
			await saveBeforeSend();
			// `#set` names a tool set (chatTools.ts): its tools are on again, and the agent is told what they are.
			extra = [...extra, ...(await chatTools.promptRefs(chatMeta?.id ?? null, text, cwd))];
			if (!chatMeta) {
				const where: ChatCwd = newWhere ? { kind: 'task', slug: newWhere } : { kind: 'folder' };
				const message = await outgoing(text, attachments, where.kind === 'folder', extra);
				const id = await chats.create({ prompt: title, cwd: where, model: newRuntime === ARKAI_RUNTIME ? arkaiDefault(arkaiProviders.list, newModel) : newModel.trim() || chats.defaults().model, permissionMode: permissionFor(newMode, approval), message, runtime: newRuntime, agent: newAgent });
				if (id) {
					select(id);
					resetInput();
				}
				return;
			}
			const message = await outgoing(text, attachments, chatMeta.cwd.kind === 'folder', extra);
			const sent = await chats.submit(chatMeta.id, message, title, how);
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

	/** Restore Checkpoint put the request back in an empty input, with its files (VS Code's restoreRequestToMainInputIfEmpty), unless chat.undoRequests.restoreInput is off. */
	function restoreToInput(req: NonNullable<Turn['request']>) {
		if (settings.get<boolean>('chat.undoRequests.restoreInput') === false || input.trim() || picked.length || files.length) return;
		editRequest(req);
		editing = false;
	}

	/** Edit request in place: the chat rewinds to it, then the new text goes with the request's files (read now). */
	async function editInline(req: NonNullable<Turn['request']>, checkpoint: number, text: string) {
		if (!chatMeta || !workspace.root) return;
		await saveBeforeSend();
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

	/** A follow-up chip: sent as the next request (VS Code's followup click), unless the input has a draft. */
	function pickFollowup(text: string) {
		if (!chatMeta) return;
		chatExtras.clearFollowups(chatMeta.id);
		if (input.trim() || picked.length || files.length) {
			input = `${input.trimEnd()}${input.trim() ? '\n' : ''}${text}`;
			queueMicrotask(() => composer?.focus());
			return;
		}
		void submit(text, []);
	}

	/** Open Chat in Editor (VS Code's chatMoveActions): the chat moves to a tab, the side bar starts a new one. */
	function openInEditor() {
		if (!chatMeta) return;
		chatExtras.openInEditor(chatMeta.id);
		newChat(false);
	}

	async function fork(request: number | null) {
		if (!chatMeta) return;
		const id = await chats.fork(chatMeta.id, request);
		if (id) select(id);
	}

	/** What Add Context gave: file chips, context texts and images. */
	function attachPicks(picks: ContextPick[]) {
		for (const p of picks) {
			if (p.kind === 'image') files = addAttachments(files, [p.path]);
			else if (p.kind === 'text') texts = [...texts.filter((x) => !(x.kind === p.text.kind && x.label === p.text.label)), p.text];
			else {
				const path = relativeTo(workspace.root, p.path);
				const same = (x: (typeof picked)[number]) => x.path === path && x.range?.startLine === p.range?.startLine && x.range?.endLine === p.range?.endLine;
				if (!picked.some(same)) picked = [...picked, { path, ...(p.range ? { range: p.range } : {}) }];
			}
		}
		queueMicrotask(() => composer?.focus());
	}

	const contextEnv = () => ({ cwd, chatId: chatMeta?.id ?? null });

	async function addContext() {
		if (!workspace.root) return;
		void contextFiles.refresh(workspace.root);
		attachPicks(await pickContext(contextEnv()));
	}

	async function onmention(item: SuggestItem) {
		attachPicks(await resolveMention(item, contextEnv()));
	}

	/** Implement on the plan card: Agent mode with edits allowed, then the plan is carried out (its approval, or a message). */
	async function implement() {
		if (!chatMeta) return;
		const id = chatMeta.id;
		const waiting = chatRun?.pending.find((p) => p.tool === 'ExitPlanMode');
		await setMode('agent', 'acceptEdits');
		if (waiting) chats.answer(id, waiting.request_id, 'allow');
		else void chats.submit(id, { text: t('chatIo.implementPrompt'), images: [] }, t('chatIo.implementPrompt'));
	}

	async function exportChat() {
		if (!chatMeta) return status.flash(t('chatIo.noChat'), 5000);
		const id = chatMeta.id;
		const name = chatMeta.title.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat';
		const path = await saveDialog({ title: t('chatIo.export'), defaultPath: `${name}.json`, filters: [{ name: t('chatIo.filter'), extensions: ['json'] }] }).catch(() => null);
		if (!path) return;
		try {
			await invoke('chat_export', { id, path });
			status.flash(t('chatIo.exported', { path }), 6000);
		} catch (e) {
			status.flash(t('chatIo.exportFailed', { error: String(e) }), 10000);
		}
	}

	async function importChat() {
		if (!workspace.root) return status.flash(t('chatIo.noFolder'), 5000);
		const path = await openDialog({ title: t('chatIo.import'), multiple: false, directory: false, filters: [{ name: t('chatIo.filter'), extensions: ['json'] }] }).catch(() => null);
		if (!path || Array.isArray(path)) return;
		try {
			const got = await chats.importFile(path);
			if (!got) return;
			select(got.id);
			status.flash(t('chatIo.imported', { title: got.title }), 8000);
		} catch (e) {
			status.flash(t('chatIo.importFailed', { error: String(e) }), 10000);
		}
	}

	/** "Allow all" asks once per app session (a native warning) before any chat uses it. */
	async function confirmAllowAll(): Promise<boolean> {
		if (chats.allowAllConfirmed) return true;
		const ok = await ask(t('chatInput.allowAllConfirm'), { kind: 'warning', okLabel: t('chatInput.allowAll') });
		if (ok) chats.allowAllConfirmed = true;
		return ok;
	}

	/** The run mode (Cursor's Ask Every Time / Run Everything over Kingu's approvals); Run Everything asks first. */
	async function pickApproval(next: AgentApproval) {
		if (next === 'bypassPermissions' && !(await confirmAllowAll())) return;
		await setMode('agent', next);
	}

	/** Compact (the context ring): `/compact` to the agent, queued while a turn runs. */
	function compact() {
		if (chatMeta) void chats.submit(chatMeta.id, { text: '/compact', images: [] }, '/compact');
	}

	/**
	 * Edit on a queued row (Cursor's "Editing queued message"): out of the queue into the input;
	 * sending puts it back in its place (its context read again), Cancel puts the original back.
	 */
	function editQueued(n: number) {
		if (!chatMeta) return;
		cancelQueuedEdit();
		const index = queued.findIndex((q) => q.n === n);
		const item = chats.takeQueued(chatMeta.id, n);
		if (!item) return;
		editingQueued = { item, index };
		input = item.label;
		queueMicrotask(() => composer?.focus());
	}

	function cancelQueuedEdit() {
		const was = editingQueued;
		if (!was || !chatMeta) return;
		chats.requeue(chatMeta.id, was.item, was.index);
		resetInput();
	}

	async function saveQueuedEdit(text: string, attachments: Attachment[]) {
		const was = editingQueued;
		if (!was || !chatMeta) return;
		busy = true;
		try {
			const message = await outgoing(text, attachments, chatMeta.cwd.kind === 'folder');
			chats.requeue(chatMeta.id, { ...message, label: text, n: was.item.n }, was.index);
			resetInput();
		} catch (e) {
			status.flash(t('chat.sendFailed', { error: String(e) }), 10000);
		} finally {
			busy = false;
		}
	}

	/** The composer's keys and the card's buttons on the waiting tool call: Run, allowlist (saved in this folder) or Skip. */
	function answerApproval(action: 'allow' | 'allowlist' | 'skip') {
		const p = pendingApproval;
		if (!chatMeta || !p) return;
		chats.answer(chatMeta.id, p.request_id, action === 'skip' ? 'deny' : action === 'allowlist' && p.can_always ? 'allow_workspace' : 'allow');
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

	/**
	 * The mode picker (VS Code's agent picker): Agent and Plan set the permission mode; Ask and a
	 * custom agent set the chat's agent (its instructions and tools) and pick its model when it names one.
	 */
	async function applyPick(next: ModePick) {
		const { mode: nextMode, agent } = fromPick(next);
		if (nextMode !== mode) await setMode(nextMode);
		if (!chatMeta) newAgent = agent;
		else {
			const when = await chats.setAgent(chatMeta.id, agent);
			if (when && agent) optionNote = t('chatCustomize.agentNext');
		}
		const custom = agent && customs.agents.find((a) => a.name === agent);
		const model = custom && runtimeId === CLAUDE_RUNTIME ? claudeModel(custom.model) : null;
		if (model) await changeModel(model);
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
	const TEXT_ICON: Record<string, IconName> = { problems: 'warning', 'git-diff': 'git', terminal: 'terminal', folder: 'folder', chat: 'agent' };
	const STATE_DOT = { working: 'bg-(--vscode-editorInfo-foreground) animate-pulse', needsInput: 'bg-(--vscode-editorWarning-foreground)' } as const;
	const STATE_LABEL = { working: () => t('team.agent.status.running'), needsInput: () => t('team.agent.status.waiting') } as const;
	const ICON_BTN = 'grid size-[22px] shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
	const title = $derived(chatMeta?.title ?? t('chat.panel.newChat'));
	/** An empty new chat: the composer sits at the top, under the header (Cursor's). */
	const composerTop = $derived(!showList && !chatMeta && !inEditor);
	const pendingApproval = $derived(chatRun?.pending.find((p) => p.tool !== 'AskUserQuestion'));
	const placeholder = $derived(
		composerPlaceholder({
			folder: !!workspace.root,
			editingQueued: !!editingQueued,
			pendingApproval: !!pendingApproval,
			running,
			followUp: turns.length > 0
		})
	);

	// ---- the composer's bottom bar -----------------------------------------------------------

	const TONE_COLOR: Record<ModeTone, string> = {
		agent: 'var(--vscode-foreground)',
		ask: 'var(--vscode-charts-green, #89d185)',
		plan: 'color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 70%, var(--vscode-charts-orange, #d18616))',
		custom: 'var(--vscode-charts-purple, #b180d7)'
	};
	function modeName(m: ModePick): string {
		const name = customName(m);
		if (name) return name;
		return m === 'ask' ? t('chatCustomize.mode.ask') : m === 'plan' ? t('chatView.mode.ask') : t('chatView.mode.agent');
	}
	const MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
	const KEY = MAC ? { mode: '⌘.', model: '⌘/' } : { mode: 'Ctrl+.', model: 'Ctrl+/' };
	const modeRows = $derived<MenuRow[]>([
		// Cursor's mode menu: icon, label and a check, in ⇧Tab's order (Agent, Plan, Ask), then custom agents.
		...(['agent', 'plan', 'ask'] as const).map((m) => ({ id: m, label: modeName(m), icon: MODE_ICON[m], checked: pick === m })),
		...shownAgents.map((a) => ({ id: `custom:${a.name}`, label: a.name, icon: MODE_ICON.custom, section: t('chatCustomize.customAgents'), checked: pick === `custom:${a.name}` })),
		...(chatAgent && chatAgent !== 'ask' && !shownAgents.some((a) => a.name === chatAgent)
			? [{ id: `custom:${chatAgent}`, label: t('chatCustomize.agentMissing', { name: chatAgent }), icon: MODE_ICON.custom, section: t('chatCustomize.customAgents'), checked: true }]
			: [])
	]);
	/** The chat's model (a new chat's pick), for the trigger and the picker's check. */
	const currentModel = $derived(chatMeta ? (chatMeta.model ?? '') : newModel);
	const modelRows = $derived.by<MenuRow[]>(() => {
		if (runtimeId === ARKAI_RUNTIME) {
			const byId = new Map(arkaiProviders.list.map((p) => [p.id, p]));
			return arkaiGroups(arkaiProviders.list, currentModel).flatMap((g) => {
				const p = byId.get(g.provider);
				const section = p && needsKey(p) ? t('arkai.picker.noKey', { name: g.label }) : g.label;
				return g.models.map((m) => ({ id: m.value, label: m.label, description: m.description, section, checked: m.value === currentModel }));
			});
		}
		// The second line only when it says something the label does not (no "claude-opus-5-5" twice).
		return modelChoices(chatMeta ? chatMeta.model : newModel, chats.defaults().model, modelCatalog.list).map((m) => {
			const description = modelSublabel(m);
			return { id: m.value, label: m.label, ...(description ? { description } : {}), checked: m.value === currentModel };
		});
	});
	const modelShort = $derived(shortModelLabel(modelRows.find((r) => r.checked)?.label || currentModel || t('composer.model.default')));
	const runtimeName = $derived(runtimeChoices(agentRuntimes.list, runtimeId).find((r) => r.id === runtimeId)?.name ?? runtimeId);
	const runtimeProtocol = $derived(agentRuntimes.list.find((r) => r.id === runtimeId)?.protocol ?? null);
	const currentApproval = $derived<AgentApproval>(allowAll ? 'bypassPermissions' : chatMeta ? ((chatMeta.permission_mode === 'plan' ? approval : chatMeta.permission_mode) ?? 'default') : approval);
	const globalAutoApprove = $derived(settings.get<boolean>('chat.tools.global.autoApprove') === true);
	const optionRows = $derived<MenuRow[]>([
		...(!chatMeta && agentRuntimes.list.length > 1
			? runtimeChoices(agentRuntimes.list, newRuntime).map((r) => ({ id: `runtime:${r.id}`, label: r.missing ? t('chatRuntime.missing', { name: r.name }) : r.name, icon: 'agent' as const, section: t('chatRuntime.label'), checked: r.id === newRuntime }))
			: []),
		...(!chatMeta
			? [
					{ id: 'where:', label: workspace.name || t('chat.panel.cwdFolder'), icon: 'folder' as const, section: t('chat.panel.cwdLabel'), checked: newWhere === '' },
					...taskWorktrees.map((slug) => ({ id: `where:${slug}`, label: `kingu/${slug}`, icon: 'branch' as const, section: t('chat.panel.cwdLabel'), checked: newWhere === slug }))
				]
			: []),
		...(mode === 'agent'
			? AGENT_APPROVALS.map((a) => ({
					id: `run:${a}`,
					label: runModeLabel(a),
					description: runModeHint(a),
					icon: a === 'bypassPermissions' ? ('warning' as const) : ('shield' as const),
					section: t('composer.run.title'),
					checked: !globalAutoApprove && a === currentApproval,
					warn: a === 'bypassPermissions',
					disabled: globalAutoApprove
				}))
			: [])
	]);
	const steerable = $derived(canSteer(runtimeProtocol));
	/** The review row shows: files waiting to be kept, or the last request's settled ones (ChatEditsBar). */
	const editsCount = $derived.by(() => {
		const v = chatMeta ? chatEdits.view(chatMeta.id) : undefined;
		return v ? v.files.length || (v.requests.some((r) => !r.reverted && r.paths.length) ? 1 : 0) : 0;
	});

	// "Steer New Messages?" (Cursor's): the first time a message is queued, once (kept in this
	// browser profile); Keep Queuing hides it, Use Steering sets the queue setting to steer.
	const NUDGE_KEY = 'kingu.chat.steerNudgeDismissed';
	let nudgeDismissed = $state(readFlag(NUDGE_KEY));
	function readFlag(key: string): boolean {
		try {
			return localStorage.getItem(key) === '1';
		} catch {
			return false;
		}
	}
	function dismissNudge(steer: boolean) {
		nudgeDismissed = true;
		try {
			localStorage.setItem(NUDGE_KEY, '1');
		} catch {
			// Private storage: shown again next time.
		}
		if (steer) void settings.set('kingu.chat.requestQueuing.defaultAction', 'steer', 'user');
	}
	const showNudge = $derived(!!chatMeta && queued.length > 0 && queueAction === 'queue' && steerable && !nudgeDismissed);

	// "How did the agent do?" (Cursor's) after a turn ends: 👍 👎 saved in the chat's own transcript
	// (chatExtras.vote, never sent anywhere), × hides it for that request.
	let feedbackHidden = $state<Record<string, true>>({});
	const feedbackRequest = $derived(feedbackTarget(turns, running));
	const feedbackFor = $derived(chatMeta && feedbackRequest !== null && !feedbackHidden[`${chatMeta.id}:${feedbackRequest}`] ? feedbackRequest : null);
	function vote(v: 'up' | 'down' | null) {
		if (!chatMeta || feedbackFor === null) return;
		if (v) void chatExtras.vote(chatMeta.id, feedbackFor, v);
		feedbackHidden = { ...feedbackHidden, [`${chatMeta.id}:${feedbackFor}`]: true };
	}
	const toolbarStatus = $derived<'running' | 'waiting' | null>(running ? (chatRun?.status === 'waiting' ? 'waiting' : 'running') : null);
	const stacked = $derived((!!chatMeta && (editsCount > 0 || !!toolbarStatus || queued.length > 0)) || editing || !!editingQueued);

	/** A composer dropdown closed: the input gets the focus back. */
	function closeMenu(refocus = true) {
		menuOpen = null;
		if (refocus) queueMicrotask(() => composer?.focus());
	}

	/**
	 * The header's ⋯ menu: where and how the chat runs (Kingu's runtime and folder for a new chat,
	 * the run mode in Agent), then the chat's own actions.
	 */
	const headerMenu = $derived.by<MenuNode[]>(() => {
		const rows = (section: string) => optionRows.filter((r) => r.section === section).map((r) => menuItem(r.id, r.label, { checked: !!r.checked, enabled: !r.disabled }));
		const sub = (id: string, text: string, items: MenuNode[]): MenuNode[] => (items.length ? [{ type: 'submenu', id, text, items }] : []);
		const out: MenuNode[] = [
			...sub('runtime', t('chatRuntime.label'), rows(t('chatRuntime.label'))),
			...sub('where', t('chat.panel.cwdLabel'), rows(t('chat.panel.cwdLabel'))),
			...sub('run', t('composer.run.title'), rows(t('composer.run.title')))
		];
		const chat: MenuNode[] = chatMeta
			? [
					menuItem('rename', t('chat.panel.rename')),
					menuItem('editor', t('chatExtras.openInEditor'), { enabled: !inEditor }),
					menuItem('promote', t('chat.panel.promote'), { enabled: !busy }),
					menuItem('tools', t('chatTools.menu')),
					menuItem('debug', t('chatDebug.menu')),
					...(chatLive ? [menuItem('end', t('chat.panel.endSession'))] : []),
					menuItem('delete', t('chat.panel.delete'), { enabled: !chatLive })
				]
			: [];
		const more: MenuNode[] = [menuItem('agents', t('chat.panel.openInAgents')), menuItem('export', t('chatIo.export'), { enabled: !!chatMeta }), menuItem('import', t('chatIo.import'))];
		return [out, chat, more].filter((g) => g.length).flatMap((g, i) => (i ? [menuSeparator, ...g] : g));
	});
	let headerMenuAt = $state<{ x: number; y: number; keyboard: boolean } | null>(null);

	function runHeader(id: string) {
		if (id.startsWith('runtime:') || id.startsWith('where:') || id.startsWith('run:')) return pickOption(id);
		if (id === 'rename' && chatMeta) {
			showList = true;
			startRename(chatMeta.id, chatMeta.title);
		} else if (id === 'editor') openInEditor();
		else if (id === 'promote') void promote();
		else if (id === 'tools' && chatMeta) void chatTools.configure(chatMeta.id);
		else if (id === 'debug' && chatMeta) openChatDebug(chatMeta.id);
		else if (id === 'end' && chatMeta) void chats.stop(chatMeta.id);
		else if (id === 'delete' && chatMeta) void removeChat(chatMeta.id);
		else if (id === 'agents') appMode.setMode('agents');
		else if (id === 'export') void exportChat();
		else if (id === 'import') void importChat();
	}

	/** The highlighted `@` file's first lines (Cursor's preview beside the menu). */
	const previewCache = new Map<string, string | null>();
	async function previewOf(item: { key?: string }): Promise<string | null> {
		const rel = item.key?.startsWith('file:') ? item.key.slice(5) : null;
		if (!rel) return null;
		if (!previewCache.has(rel)) {
			const text = await invoke<string>('read_workspace_file', { rel }).catch(() => null);
			previewCache.set(rel, text === null ? null : text.split('\n').slice(0, 30).join('\n'));
		}
		return previewCache.get(rel) ?? null;
	}

	/** Esc in the composer with no menu open: the focus goes back to the editor (Cursor's). */
	function leaveComposer() {
		if (editors.active) editors.focusGroup(editors.activeGroup.id);
		else (document.activeElement as HTMLElement | null)?.blur();
	}

	/** A turn ended while the chat was not looked at: a dot on its tab until the panel has focus (Cursor's unread dot). */
	let unread = $state(false);
	let wasRunning = false;
	$effect(() => {
		const now = running;
		if (wasRunning && !now && !chatSignals.hasFocus()) unread = true;
		wasRunning = now;
	});

	function pickOption(id: string) {
		closeMenu();
		if (id.startsWith('runtime:')) newRuntime = id.slice(8);
		else if (id.startsWith('where:')) newWhere = id.slice(6);
		else if (id.startsWith('run:')) void pickApproval(id.slice(4) as AgentApproval);
	}

	async function nextMode() {
		if (!workspace.root) return;
		void loadCustomizations();
		await applyPick(cycleMode(modes, pick));
	}

	/** The context chips: the current file (turned off, not removed), attached files, then other context. */
	const chipEntries = $derived<{ chip: ComposerChip; act: (action: 'remove' | 'toggle') => void }[]>([
		...contextChips.map((f) => ({
			chip: { key: `file:${f.path}:${f.range?.startLine ?? ''}-${f.range?.endLine ?? ''}`, label: contextLabel(f), icon: 'file' as const, title: f.path },
			act: () => void (picked = picked.filter((p) => !(p.path === f.path && p.range?.startLine === f.range?.startLine && p.range?.endLine === f.range?.endLine)))
		})),
		...texts.map((c, i) => ({
			chip: { key: `text:${i}:${c.kind}:${c.label}`, label: c.label, icon: TEXT_ICON[c.kind] ?? ('note' as const), title: c.text.slice(0, 500) },
			act: () => void (texts = texts.filter((x) => x !== c))
		}))
	]);

	function pickCommand(item: SlashItem): boolean {
		if (item.source !== 'mode') return false;
		const cmd = modeSlash.find((m) => m.name === item.name);
		if (cmd) void cmd.run('');
		return true;
	}
</script>

<div bind:this={root} class="flex h-full min-w-0 flex-col overflow-hidden text-[13px]" data-chat-view onfocusin={() => selectedId && (chatTools.current = selectedId)}>
	<!-- The chat header (Cursor's): the chat as a tab (spinner while it runs, a dot when it finished
	     unseen, × closes it), then New Chat, History, ⋯ (where and how it runs, the chat's actions)
	     and the panel toggle. -->
	<div class="flex h-[35px] shrink-0 items-center gap-0.5 border-b border-(--vscode-sideBar-border) px-1.5" onfocusin={() => (unread = false)}>
		{#if showList}
			<span class="min-w-0 flex-1 truncate px-1.5 font-medium">{t('chatView.history')}</span>
		{:else}
			<div
				class="group/tab flex h-[26px] max-w-[70%] min-w-0 items-center gap-1.5 rounded-md bg-(--vscode-toolbar-hoverBackground) pr-0.5 pl-2"
				title={chatMeta ? `${title} · ${cwdLabel(chatMeta.cwd)}` : title}
			>
				{#if pendingApproval}
					<span class="shrink-0 text-(--vscode-editorWarning-foreground)" role="status" aria-label={t('composer.status.waiting')}><Icon name="help" size={13} /></span>
				{:else if running}
					<span class="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent text-(--vscode-descriptionForeground)" role="status" aria-label={t('composer.status.running')}></span>
				{:else if unread}
					<span class="grid size-3 shrink-0 place-items-center" role="status" aria-label={t('composer.header.unread')}><span class="size-2 rounded-full bg-(--vscode-notificationsInfoIcon-foreground,#3794ff)"></span></span>
				{:else}
					<span class="shrink-0 text-(--vscode-descriptionForeground)"><Icon name="chat" size={13} /></span>
				{/if}
				<span class="min-w-0 truncate">{title}</span>
				{#if !inEditor && chatMeta}
					<button class={[ICON_BTN, 'size-[18px] opacity-60 group-hover/tab:opacity-100']} aria-label={t('composer.header.close')} title={t('composer.header.close')} onclick={() => newChat()}><Icon name="close" size={12} /></button>
				{/if}
			</div>
		{/if}
		<span class="flex-1"></span>
		{#if inEditor}
			<button class={ICON_BTN} aria-label={t('chatExtras.moveToSideBar')} title={t('chatExtras.moveToSideBar')} onclick={() => editorChatId && chatExtras.moveToSideBar(editorChatId)}>
				<Icon name="sidebarRight" size={16} />
			</button>
		{:else}
			<button class={ICON_BTN} aria-label={t('chat.panel.newChat')} title={t('chatView.newChatKey')} disabled={!workspace.root} onclick={() => newChat()}><Icon name="plus" size={16} /></button>
			<button
				class={[ICON_BTN, showList && 'bg-(--vscode-toolbar-activeBackground)']}
				aria-label={t('chatView.history')}
				title={t('chatView.history')}
				aria-pressed={showList}
				onclick={() => (showList = !showList)}><Icon name="clock" size={15} /></button
			>
			<button
				class={[ICON_BTN, ((allowAll && mode === 'agent') || globalAutoApprove) && 'text-(--vscode-editorWarning-foreground)']}
				aria-label={t('composer.header.more')}
				title={t('composer.options.hint', { runtime: runtimeName, where: chatMeta ? cwdLabel(chatMeta.cwd) : newWhere ? `kingu/${newWhere}` : workspace.name || t('chat.panel.cwdFolder'), run: globalAutoApprove ? t('composer.run.global') : mode === 'agent' ? runModeLabel(currentApproval) : modeName(pick) })}
				aria-haspopup="menu"
				aria-expanded={headerMenuAt !== null}
				onclick={(e) => {
					const r = e.currentTarget.getBoundingClientRect();
					headerMenuAt = { x: r.right - 248, y: r.bottom + 2, keyboard: e.detail === 0 };
				}}><Icon name="more" size={16} /></button
			>
			<button class={ICON_BTN} aria-label={t('composer.header.hidePanel')} title={t('composer.header.hidePanel')} onclick={() => (layout.auxVisible = false)}><Icon name="sidebarRight" size={15} /></button>
		{/if}
	</div>
	{#if headerMenuAt}
		<PopupMenu items={headerMenu} label={t('composer.header.more')} x={headerMenuAt.x} y={headerMenuAt.y} focusFirst={headerMenuAt.keyboard} onRun={(n) => n.type === 'item' && runHeader(n.id)} onClose={() => (headerMenuAt = null)} />
	{/if}

	{#if composerTop}{@render composerBlock()}{/if}
	<div bind:this={listBox} class="relative min-h-0 flex-1 overflow-hidden">
		{#if showList}
			<!-- History (VS Code's agent sessions): search and filters, chats, then the folder's ADE tasks (read-only here). -->
			<div class="h-full overflow-y-auto pb-1">
				<div class="sticky top-0 z-10 bg-(--vscode-sideBar-background)"><ChatHistoryFilter /></div>
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
										{#if historyHits.get(r.id)}
											{@const sn = snippetParts(historyHits.get(r.id)!.snippets[0])}
											<span class="truncate text-xs text-(--vscode-descriptionForeground)">{sn.before}<mark class="bg-(--vscode-editor-findMatchHighlightBackground) text-inherit">{sn.match}</mark>{sn.after}</span>
										{:else}
											<span class="truncate text-xs text-(--vscode-descriptionForeground)">{r.state ? STATE_LABEL[r.state]() : timeAgo(r.at, Date.now())}</span>
										{/if}
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
						<li class="px-3 py-2 text-(--vscode-descriptionForeground)">{filteredChats ? t('chatHistory.noMatch') : t('chatView.noChats')}</li>
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
				actions={{
					retry: features.rewind ? () => chatMeta && void chatRewind.retry(chatMeta.id) : undefined,
					edit: editRequest,
					editInline: features.rewind ? editInline : undefined,
					implement: mode === 'ask' ? implement : undefined,
					stop: () => chatMeta && void chats.interrupt(chatMeta.id),
					fork: features.rewind ? (request) => void fork(request) : undefined,
					runMode: mode === 'agent' ? { current: currentApproval, options: AGENT_APPROVALS, pick: (a) => void pickApproval(a), locked: globalAutoApprove } : undefined,
					sentAt: (request) => (chatMeta ? (chatEdits.view(chatMeta.id)?.requests.find((r) => r.index === request)?.at ?? null) : null),
					remember: (text) => void chatExtras.remember(text),
					continue: () => void submit(CONTINUE_PROMPT, []),
					followups: { items: running ? [] : chatExtras.followups(chatMeta.id), pick: pickFollowup }
				}}
				reverted={(r) => !!chatMeta && chatEdits.isReverted(chatMeta.id, r)}
				class="h-full p-3"
			>
				{#snippet checkpoint(request, req, first)}
					{#if chatMeta && features.rewind}
						<RestoreCheckpoint chatId={chatMeta.id} {request} {first} compact onrestored={() => restoreToInput(req)} />
					{/if}
				{/snippet}
				{#snippet empty()}
					<p class="text-(--vscode-descriptionForeground)">{t('chat.panel.noHistory')}</p>
				{/snippet}
			</ChatList>
			<ChatTranscriptTools
				host={() => listBox ?? null}
				active={!inEditor}
				onquote={(text) => {
					input = withQuote(input, text);
					queueMicrotask(() => composer?.focus());
				}}
				onside={features.rewind ? (text) => chatMeta && (side = { parent: chatMeta.id, excerpt: text }) : undefined}
			/>
			{#if side && side.parent === chatMeta.id}
				{#key side}
					<SideChat parentId={side.parent} excerpt={side.excerpt} {cwd} root={workspace.root} onclose={() => (side = null)} onkeep={(id) => ((side = null), select(id))} />
				{/key}
			{/if}
		{:else if inEditor}
			<p class="p-6 text-center text-(--vscode-descriptionForeground)">{chats.loaded ? t('chatExtras.editorMissing') : t('chatExtras.editorLoading')}</p>
		{/if}
	</div>

	{#if !showList && chatMeta}{@render composerBlock()}{/if}
</div>

<!-- The composer: at the top of an empty chat (Cursor's), at the bottom once the chat has started. -->
{#snippet composerBlock()}
		<div class={['shrink-0 px-2', composerTop ? 'pt-2 pb-1' : 'pt-1 pb-2']}>
			{#if chatMeta}<ChatTodoBar {turns} {running} />{/if}
			{#if chatMeta && chatRewind.canRedo(chatMeta.id)}
				<div class="mb-1.5 flex items-center gap-1.5 rounded border border-(--vscode-widget-border) px-2 py-1 text-xs text-(--vscode-descriptionForeground)" role="status">
					<Icon name="discard" size={12} />
					<span class="min-w-0 flex-1">{t('chatRewind.restored')}</span>
					<button class="shrink-0 text-(--vscode-textLink-foreground) hover:underline" title={t('chatRewind.redoHint')} onclick={() => chatMeta && chatRewind.redo(chatMeta.id)}>{t('chatRewind.redo')}</button>
				</div>
			{/if}
			{#if feedbackFor !== null}
				<div class="mb-1.5 flex items-center gap-1 rounded-lg border border-(--vscode-widget-border) py-1 pr-1 pl-2.5 text-xs" role="group" aria-label={t('composer.feedback.title')}>
					<span class="min-w-0 flex-1 truncate text-(--vscode-descriptionForeground)">{t('composer.feedback.title')}</span>
					<button class={ICON_BTN} aria-label={t('chatExtras.feedback.helpful')} title={t('chatExtras.feedback.helpful')} onclick={() => vote('up')}><Icon name="thumbsUp" size={13} /></button>
					<button class={ICON_BTN} aria-label={t('chatExtras.feedback.unhelpful')} title={t('chatExtras.feedback.unhelpful')} onclick={() => vote('down')}><Icon name="thumbsDown" size={13} /></button>
					<button class={ICON_BTN} aria-label={t('common.close')} title={t('common.close')} onclick={() => vote(null)}><Icon name="close" size={13} /></button>
				</div>
			{/if}
			{#if showNudge}
				<div class="mb-1.5 space-y-1.5 rounded-lg border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) p-2.5 text-xs" role="dialog" aria-label={t('composer.nudge.title')}>
					<div class="font-semibold">{t('composer.nudge.title')}</div>
					<p class="text-(--vscode-descriptionForeground)">{t('composer.nudge.body')}</p>
					<div class="flex justify-end gap-1.5">
						<button class="h-[22px] rounded-md px-2 hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => dismissNudge(false)}>{t('composer.nudge.keep')}</button>
						<button
							class="h-[22px] rounded-md bg-[color-mix(in_srgb,var(--vscode-foreground)_85%,transparent)] px-2 text-(--vscode-sideBar-background,var(--vscode-input-background)) hover:opacity-90"
							onclick={() => dismissNudge(true)}>{t('composer.nudge.steer')}</button
						>
					</div>
				</div>
			{/if}
			{#if stacked}
				<!-- The composer toolbar (Cursor's): status and review, the queue, the edit banner, stacked on the input. -->
				<div
					class="divide-y divide-(--vscode-widget-border) overflow-hidden rounded-t-xl border border-b-0 border-(--vscode-input-border,var(--vscode-widget-border)) bg-[color-mix(in_srgb,var(--vscode-input-background)_55%,var(--vscode-sideBar-background))]"
				>
					{#if chatMeta}<ChatEditsBar chatId={chatMeta.id} status={toolbarStatus} onstop={() => chatMeta && chats.interrupt(chatMeta.id)} flat />{/if}
					{#if chatMeta}
						<ComposerQueue
							items={queued}
							steer={steerable}
							onedit={editQueued}
							onsend={(n, how) => chatMeta && void chats.sendQueuedNow(chatMeta.id, n, how)}
							onremove={(n) => chatMeta && chats.unqueue(chatMeta.id, n)}
							onmove={(n, index) => chatMeta && chats.moveQueued(chatMeta.id, n, index)}
						/>
					{/if}
					{#if editing || editingQueued}
						<div class="flex items-center gap-1.5 bg-[color-mix(in_srgb,var(--vscode-input-background)_80%,var(--vscode-focusBorder))] px-2.5 py-1 text-xs" role="note">
							<Icon name={editingQueued ? 'clock' : 'edit'} size={12} />
							<span class="min-w-0 flex-1 truncate">{editingQueued ? t('composer.editingQueued') : t('chatView.editNotice')}</span>
							<button class="shrink-0 text-(--vscode-textLink-foreground) hover:underline" onclick={() => (editingQueued ? cancelQueuedEdit() : resetInput())}>{t('common.cancel')}</button>
						</div>
					{/if}
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
				{stacked}
				top={composerTop}
				onescape={leaveComposer}
				preview={previewOf}
				tint={tone === 'agent' ? undefined : TONE_COLOR[tone]}
				onstop={() => chatMeta && chats.interrupt(chatMeta.id)}
				mentions={(q, scope) => mentionItems(q, scope, picked.map((p) => p.path), contextEnv())}
				{onmention}
				onmentionopen={() => void contextFiles.refresh(workspace.root)}
				chips={chipEntries.map((e) => e.chip)}
				onchip={(c, action) => chipEntries.find((e) => e.chip.key === c.key)?.act(action)}
				chipsExtra={rulesChip}
				sendLabel={running ? t('chatView.queue') : undefined}
				commands={slashCommands}
				onpickcommand={pickCommand}
				queueDefault={queueAction}
				cmdEnter={settings.get<boolean>('kingu.chat.submitWithCmdEnter') === true}
				oncyclemode={() => void nextMode()}
				approval={pendingApproval ? { answer: answerApproval } : undefined}
				onsubmit={submit}
				onpastetext={attachPaste}
			>
				{#snippet left(l)}
					<!-- The mode pill: its colour and icon per mode (Cursor's), ⌘. / ⇧Tab cycles. -->
					<div class="relative flex min-w-0 shrink-0">
						<button
							type="button"
							class="flex h-[22px] min-w-0 items-center gap-1 rounded-full py-0.5 pr-1 pl-2 text-xs opacity-90 hover:opacity-100 disabled:opacity-50"
							style:background="color-mix(in srgb, {TONE_COLOR[tone]} {tone === 'agent' ? 12 : 18}%, transparent)"
							style:color={tone === 'agent' ? 'var(--vscode-foreground)' : TONE_COLOR[tone]}
							aria-label={t('composer.mode.label', { mode: modeName(pick) })}
							title={t('composer.mode.hint', { key: KEY.mode })}
							aria-haspopup="listbox"
							aria-expanded={menuOpen === 'mode'}
							disabled={!workspace.root}
							onclick={() => {
								void loadCustomizations();
								menuOpen = menuOpen === 'mode' ? null : 'mode';
							}}
						>
							<Icon name={MODE_ICON[tone]} size={12} />
							{#if l.modeLabel}<span class="max-w-28 truncate">{modeName(pick)}</span>{/if}
							<Icon name="chevronDown" size={10} />
						</button>
						{#if menuOpen === 'mode'}
							<ComposerMenu
								rows={modeRows}
								below={composerTop}
								width={200}
								label={t('chatView.mode')}
								search={modeRows.length > 6}
								footer={t('composer.mode.footer', { key: KEY.mode })}
								onpick={(id) => (closeMenu(), void applyPick(id as ModePick))}
								onclose={closeMenu}
							/>
						{/if}
					</div>
					{#if features.models || runtimeId === ARKAI_RUNTIME}
						<!-- The model label (Cursor's compact trigger), ⌘/ opens it. -->
						<div class="relative flex min-w-0">
							<button
								type="button"
								class="flex h-[22px] min-w-0 items-center gap-0.5 rounded-md px-1.5 text-xs text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)"
								aria-label={t('composer.model.label', { model: modelShort })}
								title={t('composer.model.hint', { model: modelShort, key: KEY.model })}
								aria-haspopup="listbox"
								aria-expanded={menuOpen === 'model'}
								onclick={() => (menuOpen = menuOpen === 'model' ? null : 'model')}
							>
								{#if l.modelLabel}<span class="truncate">{modelShort}</span>{:else}<Icon name="cpu" size={12} />{/if}
							</button>
							{#if menuOpen === 'model'}
								<ComposerMenu
									rows={modelRows}
									below={composerTop}
									label={t('chat.panel.model')}
									search
									placeholder={t('composer.model.search')}
									width={300}
									footer={runtimeId === ARKAI_RUNTIME && !modelRows.length ? (arkaiProviders.loading ? t('arkai.picker.loading') : t('arkai.picker.none')) : undefined}
									onpick={(id) => (closeMenu(), void changeModel(id))}
									onclose={closeMenu}
								/>
							{/if}
						</div>
					{/if}
				{/snippet}
				{#snippet right(l)}
					{#if chatRun?.context && l.ring && settings.get<boolean>('chat.contextUsage.enabled') !== false}<ContextRing usage={chatRun.context} cost={chatRun.result?.total_cost_usd ?? null} oncompact={chatMeta ? compact : undefined} />{:else if running && l.ring}<span
							class="grid size-6 shrink-0 place-items-center"
							role="status"
							aria-label={t('composer.status.running')}><span class="size-3 animate-spin rounded-full border-[1.5px] border-(--vscode-widget-border) border-t-(--vscode-descriptionForeground)"></span></span
						>{/if}
				{/snippet}
			</Composer>
			{#if optionNote}<p class="px-1 pt-1 text-xs text-(--vscode-descriptionForeground)" role="status">{optionNote}</p>{/if}
			{#if allowAll && mode === 'agent'}<p class="px-1 pt-1 text-xs text-(--vscode-editorWarning-foreground)" role="status">{t('chatInput.allowAllNote')}</p>{/if}
			{#if globalAutoApprove}<p class="px-1 pt-1 text-xs text-(--vscode-editorWarning-foreground)" role="status">{t('chatCustomize.autoApproveNote')}</p>{/if}
		</div>
{/snippet}

{#snippet rulesChip()}
	<RulesChip {cwd} files={contextChips.map((f) => f.path)} />
{/snippet}
