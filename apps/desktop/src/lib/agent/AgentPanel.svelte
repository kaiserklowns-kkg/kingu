<script lang="ts">
	// Agent panel (secondary side bar), laid out like VS Code's Chat view: the view header (the
	// chat's title, which opens the history; New Chat + with its ⌄ menu (a new chat on another
	// agent), ⚡ Customize Chat, ⋯ and Open Chat in Editor), the chat's request/response list
	// (ChatList) or, in an empty chat, the welcome (ChatWelcome: Build with Agent, Generate Agent
	// Instructions), and the chat input pinned to the bottom (Composer in VS Code's look): the tip
	// card (ChatTipCard) or a toolbar stacked on it (status and Stop, the files changed with Keep
	// All / Undo All / Review, the queued messages, the edit banner), inline context chips, and a
	// bottom bar with + (Add Context), the mode picker (Agent / Ask / Plan / custom agents, ⌘. or
	// ⇧Tab), the model picker (⌘/), the context ring, the microphone and send. Under the input
	// (ChatSessionBar): the agent the chat runs on (Arkai, Claude Code, Codex...) and the permissions.
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
	import { FALLBACK_MODELS } from './modelChoices.ts';
	import { modelCatalog, probeRuntimeModels } from './modelCatalog.svelte.ts';
	import { effortState } from './effortChoice.svelte.ts';
	import { effortLabel, effortRows, type Effort } from './effort.ts';
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
	import { canSteer, composerPlaceholder, customName, cycleMode, modeOrder, modeTone, runModeHint, runModeLabel, shortModelLabel } from './composer.ts';
	import { arkaiGroups, needsKey } from './arkai.ts';
	import type { QueuedMessage } from './chats.svelte.ts';
	import { queueDefault, type SendHow } from './requestQueuing.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { chatEdits } from './chatEdits.svelte.ts';
	import type { IconName } from '#lib/workbench/Icon.svelte';
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { MODE_CODICON, MODE_MENU_CODICON, PERMISSION_CODICON } from './chatIcons.ts';
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
	import McpStatusNote from './McpStatusNote.svelte';
	import { mcpChat } from './mcpChat.svelte.ts';
	import { findPromptCommand } from './mcpChat.ts';
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
	import ChatWelcome from './ChatWelcome.svelte';
	import ChatTipCard from './ChatTipCard.svelte';
	import ChatSessionBar from './ChatSessionBar.svelte';
	import { chatTips, registerTipCommands, tipSignals } from './chatTips.svelte.ts';
	import { generateRequest, hasAgentInstructions, orderedTips, showTips, type TipAction, type TipContext } from './chatTips.ts';
	import { commands } from '#lib/workbench/commands.svelte.ts';
	import './chatView.css';

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
	/** The new chat's reasoning effort (null: the runtime's default, else the model's). */
	let newEffort = $state<Effort | null>(null);
	let newMode = $state<ChatMode>(modeOf(chats.defaults().permissionMode));
	/** The new chat's agent (runtimes.ts); kept for the next new chat. */
	let newRuntime = $state(runtimeOf(null));
	/** Agent mode's approval, kept while Ask is picked. */
	let approval = $state<AgentApproval>(chats.defaults().permissionMode === 'acceptEdits' ? 'acceptEdits' : 'default');
	/** Where the last model / mode change took effect, shown under the input. */
	let optionNote = $state('');
	let composer: ReturnType<typeof Composer> | undefined = $state();
	/** The composer's open dropdown: the mode pill's, the model picker, its effort level or the options menu. */
	let menuOpen = $state<'mode' | 'model' | 'effort' | 'options' | null>(null);
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
	/** The agent's name (the session target picker, "Chat with <agent>"). */
	const runtimeName = $derived(runtimeChoices(agentRuntimes.list, runtimeId).find((r) => r.id === runtimeId)?.name ?? runtimeId);
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
				model: () => queueMicrotask(openModelPicker),
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
	const slashCommands = $derived(mergeCommands(ownCommands, chatRun?.commands ?? [], fileCommands, customs.prompts, mcpChat.promptItems(cwd)));
	// The MCP servers' prompts (`/mcp.<server>.<prompt>`) are asked for once a `/` is typed.
	$effect(() => {
		if (input.startsWith('/') && cwd) untrack(() => void mcpChat.load(contextEnv()));
	});

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
		const offTips = registerTipCommands();
		return () => {
			off();
			offTips();
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
		untrack(() => (features.models || runtimeId === ARKAI_RUNTIME) && openModelPicker());
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

	// Settings load after the panel: pick up the default model once it is known (Claude's only:
	// another runtime starts with its own default, not a Claude model).
	$effect(() => {
		if (!newModel && newRuntime === CLAUDE_RUNTIME) newModel = chats.defaults().model ?? '';
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
		// The default model is Claude's: another runtime starts with its own default, not a Claude model.
		newModel = newRuntime === CLAUDE_RUNTIME ? (d.model ?? '') : '';
		newEffort = null;
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
		if (how === 'queue' || how === 'steer') chatTips.record('queue');
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
		const asMcp = text.startsWith('/mcp.') ? findPromptCommand(text, mcpChat.prompts(cwd)) : null;
		if (asMcp) return fillMcpPrompt(asMcp.item, asMcp.args);
		await send(text, attachments, how);
	}

	/** `/mcp.<server>.<prompt>` (VS Code's): its arguments asked, the rendered prompt put in the input to review and send. */
	async function fillMcpPrompt(cmd: Parameters<typeof mcpChat.runPrompt>[0], args: string) {
		const r = await mcpChat.runPrompt(cmd, args, contextEnv());
		if (!r) return;
		input = r.text;
		texts = [...texts.filter((x) => !r.context.some((y) => y.kind === x.kind && y.label === x.label)), ...r.context];
		status.flash(t('chatMcp.prompt.filled'), 5000);
		queueMicrotask(() => composer?.focus());
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
				const id = await chats.create({ prompt: title, cwd: where, model: newRuntime === ARKAI_RUNTIME ? arkaiDefault(arkaiProviders.list, newModel) : newModel.trim() || (newRuntime === CLAUDE_RUNTIME ? chats.defaults().model : ''), permissionMode: permissionFor(newMode, approval), message, runtime: newRuntime, agent: newAgent, effort: newEffort });
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
		chatTips.record('fork');
		const id = await chats.fork(chatMeta.id, request);
		if (id) select(id);
	}

	/** What Add Context gave: file chips, context texts and images. */
	function attachPicks(picks: ContextPick[]) {
		if (picks.length) chatTips.record('attach');
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
		// Files from Disk... (the paperclip's dialog, which VS Code's chat input has no button for).
		const disk = { id: 'disk', label: t('chatWelcome.attachFiles'), description: t('chatWelcome.attachFilesHint'), run: () => (chatTips.record('attach'), composer?.pickFiles()) };
		attachPicks(await pickContext(contextEnv(), [disk]));
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

	/** The run mode (kingu-old's permission picker over Kingu's approvals); Allow all asks first. */
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
		chatTips.record(`mode:${next}`);
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

	/** The model picker's Effort Level (old's modelPickerModelConfig): the live session from its next response or turn. */
	async function changeEffort(next: Effort) {
		if (!chatMeta) {
			newEffort = next;
			return;
		}
		const when = await chats.setEffort(chatMeta.id, next);
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
	const title = $derived(chatMeta?.title ?? t('chatWelcome.viewTitle'));
	const pendingApproval = $derived(chatRun?.pending.find((p) => p.tool !== 'AskUserQuestion'));
	const placeholder = $derived(
		composerPlaceholder({
			folder: !!workspace.root,
			editingQueued: !!editingQueued,
			pendingApproval: !!pendingApproval,
			running,
			followUp: turns.length > 0,
			agent: runtimeName
		})
	);

	// ---- the composer's bottom bar -----------------------------------------------------------

	function modeName(m: ModePick): string {
		const name = customName(m);
		if (name) return name;
		return m === 'ask' ? t('chatCustomize.mode.ask') : m === 'plan' ? t('chatView.mode.ask') : t('chatView.mode.agent');
	}
	const MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
	const KEY = MAC ? { mode: '⌘.', model: '⌘/', find: '⌘F', context: '⌥⌘P', newChat: '⌘N' } : { mode: 'Ctrl+.', model: 'Ctrl+/', find: 'Ctrl+F', context: 'Ctrl+Alt+P', newChat: 'Ctrl+N' };
	const modeRows = $derived<MenuRow[]>([
		// Cursor's mode menu: icon, label and a check, in ⇧Tab's order (Agent, Plan, Ask), then custom agents.
		...(['agent', 'plan', 'ask'] as const).map((m) => ({ id: m, label: modeName(m), codicon: MODE_MENU_CODICON[m], checked: pick === m })),
		...shownAgents.map((a) => ({ id: `custom:${a.name}`, label: a.name, section: t('chatCustomize.customAgents'), checked: pick === `custom:${a.name}` })),
		...(chatAgent && chatAgent !== 'ask' && !shownAgents.some((a) => a.name === chatAgent)
			? [{ id: `custom:${chatAgent}`, label: t('chatCustomize.agentMissing', { name: chatAgent }), section: t('chatCustomize.customAgents'), checked: true }]
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
		// Each runtime keeps its own models (the cached list of its last session); only Claude's
		// alias fallback and default model, not on other runtimes.
		const catalog = modelCatalog.for(runtimeId);
		const listed = catalog.length || runtimeId !== CLAUDE_RUNTIME ? catalog : FALLBACK_MODELS;
		return modelChoices(chatMeta ? chatMeta.model : newModel, runtimeId === CLAUDE_RUNTIME ? chats.defaults().model : undefined, listed).map((m) => {
			const description = modelSublabel(m);
			return { id: m.value, label: m.label, ...(description ? { description } : {}), checked: m.value === currentModel };
		});
	});
	// VS Code's model picker says "No models available" while there is none to pick (Arkai with no provider set up).
	const modelShort = $derived(
		runtimeId === ARKAI_RUNTIME && !modelRows.length && !arkaiProviders.loading ? t('chatWelcome.noModels') : shortModelLabel(modelRows.find((r) => r.checked)?.label || currentModel || t('composer.model.default'))
	);
	/** Under the model rows: while the one-off ask runs, and when it came back with nothing. */
	const modelFooter = $derived.by(() => {
		if (modelRows.length) return undefined;
		if (runtimeId === ARKAI_RUNTIME) return arkaiProviders.loading ? t('arkai.picker.loading') : t('arkai.picker.none');
		if (modelCatalog.busy[runtimeId]) return t('composer.model.loading');
		if (modelCatalog.failed[runtimeId]) return t('composer.model.probeFail');
		return undefined;
	});
	const runtimeProtocol = $derived(agentRuntimes.list.find((r) => r.id === runtimeId)?.protocol ?? null);
	/**
	 * The Effort Level beside the model (old's model picker config readout): the levels the
	 * chat's model takes on its runtime and the one in effect; hidden when there are none.
	 */
	const effort = $derived(
		effortState(
			runtimeId,
			chatMeta ? chatMeta.model : runtimeId === ARKAI_RUNTIME ? arkaiDefault(arkaiProviders.list, newModel) : newModel.trim() || (runtimeId === CLAUDE_RUNTIME ? chats.defaults().model : ''),
			chatMeta ? chatMeta.effort : newEffort
		)
	);
	const currentApproval = $derived<AgentApproval>(allowAll ? 'bypassPermissions' : chatMeta ? ((chatMeta.permission_mode === 'plan' ? approval : chatMeta.permission_mode) ?? 'default') : approval);
	const globalAutoApprove = $derived(settings.get<boolean>('chat.tools.global.autoApprove') === true);
	/** Where a new chat runs (the header's ⋯): this folder or a task's worktree. */
	const whereRows = $derived<MenuRow[]>(
		!chatMeta
			? [
					{ id: 'where:', label: workspace.name || t('chat.panel.cwdFolder'), checked: newWhere === '' },
					...taskWorktrees.map((slug) => ({ id: `where:${slug}`, label: `kingu/${slug}`, checked: newWhere === slug }))
				]
			: []
	);
	/** The permission picker under the input (VS Code's permissionPickerActionItem): Agent mode's run mode. */
	const permissionRows = $derived<MenuRow[]>(
		AGENT_APPROVALS.map((a) => ({
			id: a,
			label: runModeLabel(a),
			description: runModeHint(a),
			codicon: PERMISSION_CODICON[a],
			checked: !globalAutoApprove && a === currentApproval,
			warn: a === 'bypassPermissions',
			disabled: globalAutoApprove
		}))
	);
	const permissionPicker = $derived({
		label: globalAutoApprove ? t('composer.run.global') : runModeLabel(currentApproval),
		icon: globalAutoApprove ? 'warning' : PERMISSION_CODICON[currentApproval],
		warn: globalAutoApprove || (allowAll && mode === 'agent'),
		disabled: globalAutoApprove || mode !== 'agent' || !workspace.root,
		title: globalAutoApprove ? t('chatCustomize.autoApproveNote') : mode !== 'agent' ? t('chatWelcome.permissions.agentOnly') : runModeHint(currentApproval),
		rows: permissionRows,
		onpick: (id: string) => {
			chatTips.record('permissions');
			void pickApproval(id as AgentApproval);
		}
	});
	/** The session target picker under the input (VS Code's sessionTargetPickerActionItem): the agent the chat runs on. */
	const targetPicker = $derived({
		label: runtimeName,
		icon: 'extensions',
		agent: runtimeId,
		title: t('chatWelcome.target.hint'),
		disabled: !workspace.root,
		rows: runtimeChoices(agentRuntimes.list, runtimeId).map<MenuRow>((r) => ({ id: r.id, label: r.missing ? t('chatRuntime.missing', { name: r.name }) : r.name, agent: r.id, checked: r.id === runtimeId, disabled: r.missing })),
		onpick: (id: string) => {
			if (id === runtimeId) return;
			// A started chat keeps its agent: another one starts a new chat (VS Code's new session of that type).
			if (chatMeta) newChat();
			newRuntime = id;
			// Models are per runtime: another agent starts with its own default.
			if (id !== CLAUDE_RUNTIME) newModel = '';
		}
	});
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
		const out: MenuNode[] = whereRows.length ? [{ type: 'submenu', id: 'where', text: t('chat.panel.cwdLabel'), items: whereRows.map((r) => menuItem(r.id, r.label, { checked: !!r.checked })) }] : [];
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
		const more: MenuNode[] = [
			menuItem('history', t('chatWelcome.showHistory')),
			menuItem('agents', t('chat.panel.openInAgents')),
			menuItem('export', t('chatIo.export'), { enabled: !!chatMeta }),
			menuItem('import', t('chatIo.import'))
		];
		const panel: MenuNode[] = [menuItem('hide', t('composer.header.hidePanel'))];
		return [out, chat, more, panel].filter((g) => g.length).flatMap((g, i) => (i ? [menuSeparator, ...g] : g));
	});
	/** New Chat's ⌄ (VS Code's ChatNewMenu): a new chat, one on each other agent, the history. */
	const newChatMenu = $derived.by<MenuNode[]>(() => {
		const others = runtimeChoices(agentRuntimes.list, runtimeId).filter((r) => !r.missing);
		return [
			menuItem('new', t('chatWelcome.newChat'), { keyLabel: KEY.newChat, enabled: !!workspace.root }),
			...(others.length > 1 ? [menuSeparator, ...others.map((r) => menuItem(`runtime:${r.id}`, t('chatWelcome.newChatWith', { name: r.name }), { enabled: !!workspace.root, agent: r.id }))] : []),
			menuSeparator,
			menuItem('history', t('chatWelcome.showHistory'))
		];
	});
	/** ⚡ Customize Chat (VS Code's Open Customizations): custom agents, prompt files, instructions, tools. */
	const customizeMenu = $derived<MenuNode[]>([
		menuItem('workbench.action.chat.configure.customagents', t('chatWelcome.customize.agents')),
		menuItem('workbench.action.chat.configure.prompts', t('chatWelcome.customize.prompts')),
		menuItem('workbench.action.chat.configure.instructions', t('chatWelcome.customize.instructions')),
		...(chatMeta ? [menuItem('tools', t('chatWelcome.customize.tools'))] : []),
		menuSeparator,
		menuItem('generate', t('chatWelcome.customize.generate'), { enabled: !!workspace.root })
	]);
	let headerMenuAt = $state<{ kind: 'more' | 'new' | 'customize'; x: number; y: number; keyboard: boolean } | null>(null);
	const headerMenus = $derived({ more: headerMenu, new: newChatMenu, customize: customizeMenu });
	function openHeaderMenu(kind: 'more' | 'new' | 'customize', e: MouseEvent & { currentTarget: HTMLElement }) {
		const r = e.currentTarget.getBoundingClientRect();
		headerMenuAt = { kind, x: Math.max(4, r.right - 248), y: r.bottom + 2, keyboard: e.detail === 0 };
	}
	function runHeaderMenu(kind: 'more' | 'new' | 'customize', id: string) {
		if (id === 'history') return toggleHistory(true);
		if (kind === 'new') {
			if (id === 'new') return newChat();
			if (id.startsWith('runtime:')) {
				newChat();
				newRuntime = id.slice(8);
				if (newRuntime !== CLAUDE_RUNTIME) newModel = '';
			}
			return;
		}
		if (kind === 'customize') {
			if (id === 'tools') return void (chatMeta && chatTools.configure(chatMeta.id));
			if (id === 'generate') return void generateInstructions();
			return void commands.run(id);
		}
		runHeader(id);
	}

	function runHeader(id: string) {
		if (id.startsWith('where:')) return pickOption(id);
		if (id === 'hide') return void (layout.auxVisible = false);
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
		if (id.startsWith('where:')) newWhere = id.slice(6);
	}

	function openModelPicker() {
		chatTips.record('modelPicker');
		menuOpen = 'model';
		// A runtime with no cached list asks its agent once (a throwaway session); the picker refills live.
		probeRuntimeModels(runtimeId);
	}

	/** The history list (the header's title, ⋯ and New Chat's ⌄). */
	function toggleHistory(on = !showList) {
		if (on) chatTips.record('history');
		showList = on;
	}

	// ---- the welcome and the tips (VS Code's chat welcome view and chatTipService) ------------

	/** Whether the folder has agent instructions (Generate Agent Instructions shows while not). */
	let hasInstructions = $state<boolean | null>(null);
	$effect(() => {
		const dir = cwd;
		// Asked again when a turn ends (the agent may have just written them) and per chat.
		void running;
		void selectedId;
		if (!dir) return void (hasInstructions = null);
		let stale = false;
		invoke<{ kind: string }[]>('chat_rules', { cwd: dir, files: [] })
			.then((rules) => !stale && (hasInstructions = hasAgentInstructions(rules)))
			.catch(() => !stale && (hasInstructions = null));
		return () => (stale = true);
	});

	/** Generate Agent Instructions (VS Code's: `/init` in Agent mode); a chat with messages gets a new chat for it. */
	async function generateInstructions() {
		chatTips.record('init');
		if (!workspace.root || busy) return;
		if (chatMeta && turns.length) newChat(false);
		if (pick !== 'agent') await applyPick('agent');
		await send(generateRequest(runtimeId, t('chatWelcome.generatePrompt')), []);
	}

	const tipCtx = $derived<TipContext>({
		mode: tone,
		rewind: !!features.rewind,
		models: !!features.models || runtimeId === ARKAI_RUNTIME,
		hasInstructions,
		hasCustomAgents: customs.agents.length > 0,
		setting: (key) => settings.get(key),
		used: new Set(chatTips.used)
	});
	const tipsShown = $derived(showTips({ enabled: chatTips.enabled, hiddenForSession: chatTips.hiddenForSession, empty: !chatMeta && !inEditor && !showList }));
	const tip = $derived(tipsShown ? chatTips.current(tipCtx) : undefined);
	const severalTips = $derived(tipsShown && orderedTips(tipCtx, chatTips.dismissedSet).length > 1);
	// The tip on screen stays put between renders (VS Code's stable rerender).
	$effect(() => {
		const shown = tip;
		untrack(() => chatTips.keep(shown));
	});
	let seenNextTip = tipSignals.next;
	let seenPrevTip = tipSignals.previous;
	let seenGenerate = chatTips.generate;
	$effect(() => {
		const n = tipSignals.next;
		if (n === seenNextTip || inEditor) return;
		seenNextTip = n;
		untrack(() => chatTips.step(1, tipCtx));
	});
	$effect(() => {
		const n = tipSignals.previous;
		if (n === seenPrevTip || inEditor) return;
		seenPrevTip = n;
		untrack(() => chatTips.step(-1, tipCtx));
	});
	$effect(() => {
		const n = chatTips.generate;
		if (n === seenGenerate || inEditor) return;
		seenGenerate = n;
		untrack(() => void generateInstructions());
	});

	function runTip(a: TipAction) {
		if (a.kind === 'generate') void generateInstructions();
		else if (a.kind === 'mode') void applyPick(a.mode);
		else if (a.kind === 'history') toggleHistory(true);
		else if (a.kind === 'insert') {
			input = `${a.text} `;
			queueMicrotask(() => composer?.focus());
		} else {
			if (a.id === 'workbench.command.new.agent') chatTips.record('newAgent');
			void commands.run(a.id);
		}
	}

	async function nextMode() {
		if (!workspace.root) return;
		chatTips.record('modeCycle');
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

<div bind:this={root} class={['interactive-session flex h-full min-w-0 flex-col overflow-hidden text-[13px]', !inEditor && 'kg-chat-part']} data-chat-view onfocusin={() => selectedId && (chatTools.current = selectedId)}>
	{#snippet titleState()}
		{#if pendingApproval}
			<span class="shrink-0 text-(--vscode-editorWarning-foreground)" role="status" aria-label={t('composer.status.waiting')}><Codicon id="question" size={12} /></span>
		{:else if running}
			<span class="shrink-0" role="status" aria-label={t('composer.status.running')}><Codicon id="loading" modifier="spin" size={12} /></span>
		{:else if unread}
			<span class="grid size-3 shrink-0 place-items-center" role="status" aria-label={t('composer.header.unread')}><span class="size-2 rounded-full bg-(--vscode-notificationsInfoIcon-foreground,#3794ff)"></span></span>
		{/if}
	{/snippet}
	{#if inEditor}
		<!-- A chat in an editor tab: its title and Move Chat to the Side Bar. -->
		<div class="flex h-[35px] shrink-0 items-center gap-0.5 pr-2 pl-3">
			<span class="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-semibold" title={title}>{@render titleState()}<span class="min-w-0 truncate">{title}</span></span>
			<button class={ICON_BTN} aria-label={t('chatExtras.moveToSideBar')} title={t('chatExtras.moveToSideBar')} onclick={() => editorChatId && chatExtras.moveToSideBar(editorChatId)}>
				<Codicon id="layout-sidebar-right" size={16} />
			</button>
		</div>
	{:else}
		<!-- The title row (VS Code's pane-composite title): "Chat", then New Chat + with its ⌄, Open
		     Customizations, Views and More Actions, and Maximize Secondary Side Bar after a separator. -->
		<div class="composite title has-actions" onfocusin={() => (unread = false)}>
			<div class="title-label"><h2>{t('chatWelcome.viewTitle')}</h2></div>
			<div class="title-actions" role="toolbar" aria-label={t('chatWelcome.actions')}>
				<span class="action-item monaco-dropdown-with-default">
					<button type="button" class="action-label" aria-label={t('chatWelcome.newChatKey', { key: KEY.newChat })} title={t('chatWelcome.newChatKey', { key: KEY.newChat })} disabled={!workspace.root} onclick={() => newChat()}><Codicon id="plus" /></button>
					<button
						type="button"
						class="action-label dropdown"
						aria-label={t('chatWelcome.newChat')}
						title={t('chatWelcome.newChat')}
						aria-haspopup="menu"
						aria-expanded={headerMenuAt?.kind === 'new'}
						onclick={(e) => openHeaderMenu('new', e)}><Codicon id="chevron-down" size={12} /></button
					>
				</span>
				<button
					type="button"
					class="action-item action-label"
					aria-label={t('chatWelcome.customize')}
					title={t('chatWelcome.customize')}
					aria-haspopup="menu"
					aria-expanded={headerMenuAt?.kind === 'customize'}
					onclick={(e) => openHeaderMenu('customize', e)}><Codicon id="extensions" /></button
				>
				<button
					type="button"
					class={['action-item action-label', ((allowAll && mode === 'agent') || globalAutoApprove) && 'text-(--vscode-editorWarning-foreground)!']}
					aria-label={t('chatWelcome.more')}
					title={t('composer.options.hint', { runtime: runtimeName, where: chatMeta ? cwdLabel(chatMeta.cwd) : newWhere ? `kingu/${newWhere}` : workspace.name || t('chat.panel.cwdFolder'), run: globalAutoApprove ? t('composer.run.global') : mode === 'agent' ? runModeLabel(currentApproval) : modeName(pick) })}
					aria-haspopup="menu"
					aria-expanded={headerMenuAt?.kind === 'more'}
					onclick={(e) => openHeaderMenu('more', e)}><Codicon id="toolbar-more" /></button
				>
				<span class="action-separator" role="separator"></span>
			</div>
			<div class="global-actions">
				<button
					type="button"
					class={['action-label', layout.auxMaximized && 'checked']}
					aria-label={layout.auxMaximized ? t('chatWelcome.restore') : t('chatWelcome.maximize')}
					title={layout.auxMaximized ? t('chatWelcome.restore') : t('chatWelcome.maximize')}
					aria-pressed={layout.auxMaximized}
					onclick={() => void commands.run('workbench.action.toggleMaximizedAuxiliaryBar')}><Codicon id="auxiliarybar-maximize" /></button
				>
			</div>
		</div>
		{#if chatMeta || showList}
			<!-- The chat's own title row (VS Code's chatViewTitleControl): Go Back (a new chat), the
			     chat's agent and title (a click picks another chat: the history), Show Agent Sessions. -->
			<div class="chat-view-title-container">
				<div class="chat-view-title-inner">
					<div class="chat-view-title-navigation-toolbar">
						<button type="button" class="action-label" aria-label={t('chatWelcome.goBack')} title={t('chatWelcome.goBack')} onclick={() => (showList ? toggleHistory(false) : newChat())}><Codicon id="arrow-left" /></button>
						<button
							type="button"
							class="chat-view-title-action-item"
							title={showList ? t('chatView.history') : t('chatWelcome.viewTitleHint', { title: chatMeta ? `${title} · ${cwdLabel(chatMeta.cwd)}` : title })}
							aria-label={t('chatWelcome.pickSession')}
							aria-pressed={showList}
							onclick={() => toggleHistory()}
						>
							{@render titleState()}
							{#if showList}
								<span class="chat-view-title-label">{t('chatView.history')}</span>
							{:else}
								<span class="chat-view-title-harness">{runtimeName}</span>
								<span class="chat-view-title-separator" aria-hidden="true">·</span>
								<span class="chat-view-title-label">{title}</span>
							{/if}
						</button>
					</div>
					<div class="chat-view-title-actions-toolbar">
						<button type="button" class={['action-label', showList && 'checked']} aria-label={t('chatWelcome.showSessions')} title={t('chatWelcome.showSessions')} aria-pressed={showList} onclick={() => toggleHistory()}><Codicon id="layout-sidebar-right-off" /></button>
					</div>
				</div>
			</div>
		{/if}
	{/if}
	{#if headerMenuAt}
		{@const kind = headerMenuAt.kind}
		<PopupMenu
			items={headerMenus[headerMenuAt.kind]}
			label={headerMenuAt.kind === 'new' ? t('chatWelcome.newChatMenu') : headerMenuAt.kind === 'customize' ? t('chatWelcome.customize') : t('composer.header.more')}
			x={headerMenuAt.x}
			y={headerMenuAt.y}
			focusFirst={headerMenuAt.keyboard}
			onRun={(n) => n.type === 'item' && runHeaderMenu(kind, n.id)}
			onClose={() => (headerMenuAt = null)}
		/>
	{/if}

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
									<span class="shrink-0 text-(--vscode-descriptionForeground)"><Codicon id="arkai-mark" size={14} /></span>
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
									<button class={ICON_BTN} aria-label={t('chat.panel.rename')} title={t('chat.panel.rename')} onclick={() => startRename(r.id, r.title)}><Codicon id="edit" size={13} /></button>
									<button class={ICON_BTN} aria-label={t('chat.panel.delete')} title={t('chat.panel.delete')} disabled={!!r.state} onclick={() => removeChat(r.id)}><Codicon id="trash" size={13} /></button>
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
								<Codicon id={r.terminal ? 'terminal' : 'git-branch'} size={14} />
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
				class="h-full py-1.5"
			>
				{#snippet checkpoint(request, req, first)}
					{#if chatMeta && features.rewind}
						<RestoreCheckpoint chatId={chatMeta.id} {request} {first} onrestored={() => (chatTips.record('restore'), restoreToInput(req))} />
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
				onside={features.rewind ? (text) => chatMeta && (chatTips.record('sideChat'), (side = { parent: chatMeta.id, excerpt: text })) : undefined}
			/>
			{#if side && side.parent === chatMeta.id}
				{#key side}
					<SideChat parentId={side.parent} excerpt={side.excerpt} {cwd} root={workspace.root} onclose={() => (side = null)} onkeep={(id) => ((side = null), select(id))} />
				{/key}
			{/if}
		{:else if inEditor}
			<p class="p-6 text-center text-(--vscode-descriptionForeground)">{chats.loaded ? t('chatExtras.editorMissing') : t('chatExtras.editorLoading')}</p>
		{:else}
			<ChatWelcome
				title={pick === 'ask' ? t('chatWelcome.title.ask') : t('chatWelcome.title.agent')}
				instructions={!!workspace.root && hasInstructions === false}
				ongenerate={() => void generateInstructions()}
			/>
		{/if}
	</div>

	{#if !showList && (chatMeta || !inEditor)}{@render composerBlock()}{/if}
</div>

<!-- The chat input, at the bottom (VS Code's): the tip card or the toolbar joined to its top, the pickers under it. -->
{#snippet composerBlock()}
		<div class="interactive-input-part">
			{#if chatMeta}<ChatTodoBar {turns} {running} />{/if}
			{#if chatMeta}<McpStatusNote chatId={chatMeta.id} />{/if}
			{#if chatMeta && chatRewind.canRedo(chatMeta.id)}
				<div class="flex items-center gap-1.5 rounded-[6px] border border-(--vscode-widget-border) px-2 py-1 text-xs text-(--vscode-descriptionForeground)" role="status">
					<Codicon id="discard" size={12} />
					<span class="min-w-0 flex-1">{t('chatRewind.restored')}</span>
					<button class="shrink-0 text-(--vscode-textLink-foreground) hover:underline" title={t('chatRewind.redoHint')} onclick={() => chatMeta && chatRewind.redo(chatMeta.id)}>{t('chatRewind.redo')}</button>
				</div>
			{/if}
			{#if feedbackFor !== null}
				<div class="flex items-center gap-1 rounded-[8px] border border-(--vscode-widget-border) py-1 pr-1 pl-2.5 text-xs" role="group" aria-label={t('composer.feedback.title')}>
					<span class="min-w-0 flex-1 truncate text-(--vscode-descriptionForeground)">{t('composer.feedback.title')}</span>
					<button class={ICON_BTN} aria-label={t('chatExtras.feedback.helpful')} title={t('chatExtras.feedback.helpful')} onclick={() => vote('up')}><Codicon id="thumbsup" /></button>
					<button class={ICON_BTN} aria-label={t('chatExtras.feedback.unhelpful')} title={t('chatExtras.feedback.unhelpful')} onclick={() => vote('down')}><Codicon id="thumbsdown" /></button>
					<button class={ICON_BTN} aria-label={t('common.close')} title={t('common.close')} onclick={() => vote(null)}><Codicon id="close" /></button>
				</div>
			{/if}
			{#if showNudge}
				<div class="space-y-1.5 rounded-[8px] border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) p-2.5 text-xs" role="dialog" aria-label={t('composer.nudge.title')}>
					<div class="font-semibold">{t('composer.nudge.title')}</div>
					<p class="text-(--vscode-descriptionForeground)">{t('composer.nudge.body')}</p>
					<div class="flex justify-end gap-1.5">
						<button class="h-[22px] rounded-md px-2 hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => dismissNudge(false)}>{t('composer.nudge.keep')}</button>
						<button class="h-[22px] rounded-md bg-(--vscode-button-background) px-2 text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)" onclick={() => dismissNudge(true)}>{t('composer.nudge.steer')}</button>
					</div>
				</div>
			{/if}
			<!-- VS Code's input stack: the tip card and the toolbars docked on the input, one surface. -->
			<div class="chat-input-stack">
				{#if tip}
					<ChatTipCard
						{tip}
						keys={{ model: KEY.model, mode: KEY.mode, find: KEY.find }}
						several={severalTips}
						onaction={runTip}
						onstep={(dir) => chatTips.step(dir, tipCtx)}
						ondismiss={() => chatTips.dismissForSession(tipCtx)}
						ondismissthis={() => chatTips.dismiss(tipCtx)}
						ondisable={() => chatTips.disable(true)}
					/>
				{/if}
				{#if stacked}
					<!-- Status and review, the queue, the edit banner, docked on the input. -->
					<div class={['chat-input-stack-toolbar divide-y divide-(--vscode-widget-border)', tip && 'chat-input-stack-continues']}>
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
							<div class="flex items-center gap-1.5 px-2.5 py-1 text-xs" role="note">
								<Codicon id={editingQueued ? 'clock' : 'edit'} size={12} />
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
					stacked={stacked || !!tip}
					vscode
					editing={!!editing}
					onescape={leaveComposer}
					preview={previewOf}
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
						<!-- Add Context... (VS Code's AttachContextAction, add-compact): the context sources and files from disk. -->
						<button
							type="button"
							class="action-label icon-only"
							aria-label={t('chatWelcome.addContext', { key: KEY.context })}
							title={t('chatWelcome.addContext', { key: KEY.context })}
							disabled={!workspace.root}
							onclick={() => void addContext()}><Codicon id="add-compact" /></button
						>
						<!-- The mode picker (VS Code's modePickerActionItem): the mode's compact icon and name; ⌘. / ⇧Tab cycles. -->
						<div class="chat-input-picker-item relative flex min-w-0 shrink-0">
							<button
								type="button"
								class={['action-label', !l.modeLabel && MODE_CODICON[tone] && 'icon-only']}
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
								{#if MODE_CODICON[tone]}<Codicon id={MODE_CODICON[tone]!} />{/if}
								{#if l.modeLabel || !MODE_CODICON[tone]}<span class="chat-input-picker-label max-w-28">{modeName(pick)}</span>{/if}
							</button>
							{#if menuOpen === 'mode'}
								<ComposerMenu
									rows={modeRows}
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
							<!-- The model picker (VS Code's modelPickerWidget): the model's name, "No models available" without one; ⌘/ opens it. -->
							<div class="chat-input-picker-item relative flex min-w-0">
								<button
									type="button"
									class="action-label min-w-0"
									aria-label={t('composer.model.label', { model: modelShort })}
									title={t('composer.model.hint', { model: modelShort, key: KEY.model })}
									aria-haspopup="listbox"
									aria-expanded={menuOpen === 'model'}
									onclick={() => (menuOpen === 'model' ? (menuOpen = null) : openModelPicker())}
								>
									<span class="chat-input-picker-label">{modelShort}</span>
								</button>
								{#if menuOpen === 'model'}
									<ComposerMenu
										rows={modelRows}
										label={t('chat.panel.model')}
										search
										placeholder={t('composer.model.search')}
										width={300}
										footer={modelFooter}
										onpick={(id) => (closeMenu(), void changeModel(id))}
										onclose={closeMenu}
									/>
								{/if}
							</div>
						{/if}
						{#if effort.current && l.modelLabel}
							{@const label = effortLabel(effort.current)}
							<!-- The model's Effort Level (old's split model picker: the config readout after the name opens its levels). -->
							<div class={['chat-input-picker-item model-picker-config relative flex shrink-0', (features.models || runtimeId === ARKAI_RUNTIME) && 'model-picker-config-split']}>
								<button
									type="button"
									class="action-label"
									aria-label={t('composer.effort.label', { effort: label })}
									title={t('composer.effort.label', { effort: label })}
									aria-haspopup="listbox"
									aria-expanded={menuOpen === 'effort'}
									onclick={() => (menuOpen = menuOpen === 'effort' ? null : 'effort')}
								>
									<span class="chat-input-picker-label">{label}</span>
								</button>
								{#if menuOpen === 'effort'}
									<ComposerMenu
										rows={effortRows(effort.levels, effort.current)}
										label={t('composer.effort.title')}
										width={260}
										onpick={(id) => (closeMenu(), void changeEffort(id as Effort))}
										onclose={closeMenu}
									/>
								{/if}
							</div>
						{/if}
					{/snippet}
					{#snippet right(l)}
						{#if chatRun?.context && l.ring && settings.get<boolean>('chat.contextUsage.enabled') !== false}<ContextRing usage={chatRun.context} cost={chatRun.result?.total_cost_usd ?? null} oncompact={chatMeta ? compact : undefined} />{/if}
					{/snippet}
				</Composer>
			</div>
			<ChatSessionBar target={targetPicker} permission={permissionPicker} onclose={(refocus) => refocus && queueMicrotask(() => composer?.focus())} />
			{#if optionNote}<p class="px-1 text-xs text-(--vscode-descriptionForeground)" role="status">{optionNote}</p>{/if}
			{#if allowAll && mode === 'agent'}<p class="px-1 text-xs text-(--vscode-editorWarning-foreground)" role="status">{t('chatInput.allowAllNote')}</p>{/if}
			{#if globalAutoApprove}<p class="px-1 text-xs text-(--vscode-editorWarning-foreground)" role="status">{t('chatCustomize.autoApproveNote')}</p>{/if}
		</div>
{/snippet}

{#snippet rulesChip()}
	<RulesChip {cwd} files={contextChips.map((f) => f.path)} />
{/snippet}
