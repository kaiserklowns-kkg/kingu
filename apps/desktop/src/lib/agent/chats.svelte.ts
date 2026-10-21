/**
 * `chats` — agent chats of the open folder (VS Code's chat sessions), separate from ADE tasks
 * (`adeTasks`): no worktree, no setup script, no tabs, and never a terminal or a CLI. Each chat
 * is one agent-host session, run in the open folder or one of its task worktrees.
 *
 *   chats.list / chats.sorted          ChatMeta[] of the open folder (chats.json), newest first
 *   chats.run(id)                      ChatRun | undefined: the chat's timeline (live, or replayed)
 *   chats.open(id)                     loads the saved transcript once (after a restart)
 *   chats.create({ prompt, cwd, model, permissionMode, message, runtime })  new chat + first run
 *                                      (`runtime`: which agent runs it, runtimes.ts)
 *   chats.send(id, message)            into the live run, else a new run resuming its session
 *   chats.submit(id, message, label, how)  while a turn runs: queue it (sent when the turn ends),
 *                                      steer (into the running session now) or stop and send
 *   chats.queue(id) / unqueue(id, n)   the chat's queued requests; takeQueued / sendQueuedNow
 *                                      (Edit / Send Now on a queued row), moveQueued (reorder),
 *                                      requeue (an edited row back in its place)
 *   chats.retry(id)                    sends the last request again (chatRewind.retry rewinds first)
 *   chats.fork(id, before)             Fork Conversation: a new chat with the conversation before
 *                                      request `before` (all of it with null); returns its id
 *                                      (`{ side: true }`: a side chat, kept out of `visible`)
 *   chats.visible / keepSideChat(id)   the chats the history shows (no side chats) / a side chat
 *                                      kept as a chat of its own
 *   chats.stopAndWait(id) / reload(id, resume)   for rewinds (chatRewind.svelte.ts)
 *   chats.importFile(path)             Import Chat: a chat file as a new chat (no session yet)
 *   chats.setModel / setPermissionMode applied to the live session (SDK setModel / setPermissionMode)
 *                                      or saved for the next run; returns which. "Allow all"
 *                                      (`bypassPermissions`) is kept in memory only (`allowAll`)
 *   chats.answer / interrupt / stop / rename / remove / promote
 *   (after a chat's first answer: an AI title, unless renamed; chatTitle.ts)
 *
 * Runs are keyed by folder + chat id (`runKey`), so they keep streaming while another folder is
 * open; only the open folder's list is loaded and saved. Rust appends each run's events to the
 * chat's transcript and refuses a second live run of a chat or of its session.
 */

import { Channel, invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { runSummary } from '#lib/ade/model.ts';
import { mcpServers, prepareMcp, skillPlugins } from '#lib/ade/mcp.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { applyEvent, initialRun, type AgentEvent, type Decision, type RunState } from './events';
import { buildTurns, lastRequest } from './chatParts.ts';
import { CLAUDE_RUNTIME, runtimeOf } from './runtimes.ts';
import { withoutImagesLine } from './chatPrompt.ts';
import { shouldDrain, turnBusy, type RunPermissionMode } from './chatInput.ts';
import { moveItem } from './composer.ts';
import type { SendHow } from './requestQueuing.ts';
import { chatTitlePrompt, parseChatTitle } from './chatTitle.ts';
import { forkTitle, rewoundMeta, type ForkPoint } from './chatRewind.ts';
import { chatsToResume, RESUME_PROMPT } from './chatResume.ts';
import { autoApprover } from './toolApproval.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import {
	chatCwdPath,
	chatSendPlan,
	MAX_TITLE,
	newChat,
	newChatId,
	optionChange,
	patchChat,
	PERMISSION_MODES,
	removeChat,
	renamedChatTitle,
	replayTranscript,
	runKey,
	sortChats,
	type ChatCwd,
	type ChatMeta,
	type PermissionMode,
	wantsAiTitle
} from './chats.ts';

export type ChatRun = RunState & {
	id: string;
	root: string;
	/** Rust run id; undefined until started (and for a replayed transcript). */
	runId: number | undefined;
	startedAt: number;
	/** The chat's agent this run started with (Ask, a custom agent; null: none): a later pick needs a new run. */
	agent?: string | null;
};

type Listener = (id: string, ev: AgentEvent) => void;

/**
 * What a request sends: the prompt (text and attached-context block) and image files. `files`:
 * the attached files (workspace-relative), for the rules a new run picks (rules.rs globs, AGENTS.md).
 */
export type OutgoingMessage = { text: string; images: string[]; files?: string[] };
/** A request waiting for the running turn to end. `label` is what the user typed. */
export type QueuedMessage = OutgoingMessage & { n: number; label: string };

class Chats {
	list = $state<ChatMeta[]>([]);
	/** The folder `list` belongs to. */
	root = $state<string | null>(null);
	loaded = $state(false);
	runs = $state<Record<string, ChatRun>>({});
	/** The chats the history lists: side chats stay in their drawer until kept. */
	visible = $derived(this.list.filter((c) => !c.side_of));
	sorted = $derived(sortChats(this.visible));
	/** Unanswered permission prompts of this folder's chats. */
	pendingCount = $derived(Object.values(this.runs).reduce((n, r) => n + (r.root === this.root ? r.pending.length : 0), 0));

	/** Requests typed while a turn ran, by run key, oldest first. */
	queues = $state<Record<string, QueuedMessage[]>>({});

	/**
	 * Chats in "Allow all" (`bypassPermissions`) until the app quits, by run key. Never saved:
	 * chats.json is in the folder, so a repository could ship one that turns every prompt off.
	 */
	allowAll = $state<Record<string, true>>({});
	/** The user confirmed "Allow all" once in this app session. */
	allowAllConfirmed = false;

	#listeners = new Set<Listener>();
	#saving: Promise<unknown> = Promise.resolve();
	#queued = 0;
	/** The images of the last request sent per run key (Retry sends them again). */
	#lastImages = new Map<string, { text: string; images: string[] }>();
	/** Chats (run keys) whose AI title was already tried this session: one try each. */
	#titled = new Set<string>();

	get(id: string): ChatMeta | undefined {
		return this.list.find((c) => c.id === id);
	}

	run(id: string): ChatRun | undefined {
		return this.root ? this.runs[runKey(this.root, id)] : undefined;
	}

	onEvent(fn: Listener): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	/** Defaults for a new chat (the composer's initial picks). */
	defaults(): { model: string | null; permissionMode: PermissionMode } {
		const mode = settings.get<string>('kingu.agent.permissionMode');
		return {
			model: settings.get<string>('kingu.agent.model')?.trim() || null,
			permissionMode: PERMISSION_MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : 'default'
		};
	}

	async load() {
		const root = workspace.root;
		this.root = root;
		this.loaded = false;
		if (!root) {
			this.list = [];
			return;
		}
		try {
			const list = await invoke<ChatMeta[]>('chats_load');
			if (workspace.root !== root) return;
			this.list = list;
		} catch (e) {
			this.list = [];
			notifications.error(t('chat.loadFailed', { error: String(e) }));
		}
		this.loaded = true;
		void this.#dropSideChats(root).then(() => this.#resumeCutOff(root));
	}

	/** Side chats whose drawer is gone (Kingu quit, another folder was opened): discarded, unless one's agent is still live. */
	async #dropSideChats(root: string) {
		for (const c of this.list.filter((c) => c.side_of && (this.runs[runKey(root, c.id)]?.ended ?? true))) {
			if (this.root !== root) return;
			await this.remove(c.id);
		}
	}

	/** Folders whose cut-off chats were looked at in this app session (once each). */
	#resumeChecked = new Set<string>();

	/** Chats Kingu quit in the middle of: continued (kingu.chat.resumeWorkOnRestart), else just no longer marked working. */
	async #resumeCutOff(root: string) {
		if (this.#resumeChecked.has(root)) return;
		this.#resumeChecked.add(root);
		const cut = chatsToResume(this.list, (id) => !!this.runs[runKey(root, id)]);
		if (!cut.length) return;
		for (const c of cut) this.#patch(root, c.id, { working: false });
		if (settings.get<boolean>('kingu.chat.resumeWorkOnRestart') !== true) return;
		let sent = 0;
		for (const c of cut) if (await this.send(c.id, { text: RESUME_PROMPT, images: [], files: [] })) sent++;
		if (sent) status.flash(t('adeWorkflow.chatsResumed', { count: sent }));
	}

	/** Saves the open folder's list (in order: one write at a time). Runs of another folder are not saved here. */
	#save(next: ChatMeta[], root: string | null) {
		if (!root || root !== this.root) return;
		this.list = next;
		const snapshot = $state.snapshot(next);
		this.#saving = this.#saving.then(() => invoke('chats_save', { chats: snapshot }).catch((e) => notifications.error(t('chat.saveFailed', { error: String(e) }))));
	}

	#patch(root: string, id: string, patch: Partial<Omit<ChatMeta, 'id'>>) {
		if (root === this.root && this.get(id)) this.#save(patchChat(this.list, id, patch, Date.now()), root);
	}

	/** Loads the saved transcript of a chat that has no run in memory (after a restart). */
	async open(id: string) {
		const root = this.root;
		if (!root || this.runs[runKey(root, id)] || !this.get(id)) return;
		try {
			const events = await invoke<AgentEvent[]>('chat_transcript_load', { id });
			if (this.runs[runKey(root, id)]) return;
			const meta = this.get(id);
			const s = replayTranscript(events);
			// A rewound or forked chat continues where Rust said, not from the transcript's last session.
			if (meta?.resume_at) s.sessionId = meta.session_id;
			else s.sessionId ??= meta?.session_id ?? null;
			this.runs[runKey(root, id)] = { ...s, id, root, runId: undefined, startedAt: meta?.updated_at ?? 0 };
		} catch (e) {
			clientLog('info', `chat ${id}: transcript not loaded: ${e}`);
		}
	}

	async create(input: { prompt: string; cwd: ChatCwd; model: string | null; permissionMode: RunPermissionMode; message: OutgoingMessage; runtime?: string; agent?: string | null }): Promise<string | undefined> {
		const root = workspace.root;
		if (!root || !input.prompt.trim()) return;
		if (root !== this.root) await this.load();
		const allowAll = input.permissionMode === 'bypassPermissions';
		const meta = newChat({ prompt: input.prompt, cwd: input.cwd, model: input.model, permissionMode: allowAll ? 'default' : (input.permissionMode as PermissionMode), runtime: input.runtime, agent: input.agent }, Date.now());
		if (allowAll) this.allowAll[runKey(root, meta.id)] = true;
		this.#save([...this.list, meta], root);
		await this.#saving;
		this.#lastImages.set(runKey(root, meta.id), input.message);
		await this.#start(root, meta, input.message.text, null, input.message.images, input.message.files);
		return meta.id;
	}

	/**
	 * A chat that continues Claude Code session `sessionId`, run in `cwd` of the open folder (AI
	 * Vault › Continue here): it opens empty and its first message resumes that session. The chat
	 * that already continues it is reused.
	 */
	async adopt(input: { title: string; sessionId: string; cwd: ChatCwd }): Promise<string | undefined> {
		const root = workspace.root;
		if (!root) return;
		if (root !== this.root) await this.load();
		const same = (c: ChatCwd) => c.kind === input.cwd.kind && (c.kind === 'folder' || (input.cwd.kind === 'task' && c.slug === input.cwd.slug));
		const existing = this.list.find((c) => c.session_id === input.sessionId && same(c.cwd));
		if (existing) return existing.id;
		const { model, permissionMode } = this.defaults();
		const title = input.title.trim().slice(0, MAX_TITLE) || 'Chat';
		const meta: ChatMeta = { ...newChat({ prompt: title, cwd: input.cwd, model, permissionMode }, Date.now()), title, title_auto: false, session_id: input.sessionId };
		this.#save([...this.list, meta], root);
		await this.#saving;
		return this.get(meta.id) ? meta.id : undefined;
	}

	async #start(root: string, meta: ChatMeta, prompt: string, resume: string | null, images: string[], files: string[] = []) {
		const key = runKey(root, meta.id);
		const prev = this.runs[key];
		if (prev && !prev.ended) throw new Error(t('chat.alreadyRunning'));
		const run: ChatRun = { ...initialRun(), id: meta.id, root, runId: undefined, startedAt: Date.now(), agent: meta.agent ?? null };
		// Same session: keep the timeline so far.
		if (prev && resume) {
			run.items = prev.items;
			run.decisions = prev.decisions;
			run.result = prev.result;
			run.sessionId = prev.sessionId;
			run.commands = prev.commands;
			run.context = prev.context;
		}
		this.runs[key] = run;
		const state = this.runs[key];
		const cwd = chatCwdPath(root, meta.cwd);
		await prepareMcp();
		const mcp = mcpServers(cwd);
		const plugins = await skillPlugins(cwd);
		let savedSession = meta.session_id;
		// After a rewind or fork: this run continues the session only up to that message (in a fork of it).
		const resumeAt = resume && resume === meta.session_id ? (meta.resume_at ?? null) : null;
		const onEvent = new Channel<AgentEvent>();
		// chat.tools.global.autoApprove: tool prompts answered here (not questions, not Kingu's always-ask checks).
		const autoApprove = autoApprover(() => settings.get<boolean>('chat.tools.global.autoApprove') === true);
		onEvent.onmessage = (ev) => {
			applyEvent(state, ev);
			for (const fn of this.#listeners) fn(meta.id, ev);
			const approve = autoApprove(ev);
			if (approve && state.runId !== undefined) {
				const runId = state.runId;
				queueMicrotask(() => void invoke('agent_answer_permission', { runId, requestId: approve, decision: 'allow', message: null, answers: null }).catch((e) => clientLog('info', `chat ${meta.id}: auto-approve: ${e}`)));
			}
			// Not shown in the chat (session start, stderr, SDK messages it does not know): logged.
			if (ev.kind === 'raw' || ev.kind === 'stderr') clientLog('info', `chat ${meta.id}: ${ev.kind}: ${ev.line.slice(0, 500)}`);
			if ((ev.kind === 'result' || ev.kind === 'exit') && shouldDrain(this.queues[key]?.length ?? 0, state)) queueMicrotask(() => void this.#drain(root, meta.id));
			if ((ev.kind === 'system' || ev.kind === 'result') && ev.session_id && ev.session_id !== savedSession) {
				savedSession = ev.session_id;
				this.#patch(root, meta.id, { session_id: ev.session_id, resume_at: null });
			}
			if (ev.kind === 'result' || ev.kind === 'exit') this.#patch(root, meta.id, { last_run: runSummary({ ...state, slug: meta.id }, Date.now(), state.startedAt), working: false });
			// The chat's first answer (its timeline keeps earlier runs): time for an AI title.
			if (ev.kind === 'result' && !ev.is_error && state.items.filter((i) => i.kind === 'result').length === 1) void this.#aiTitle(root, meta.id, ev.result);
		};
		try {
			state.runId = await invoke<number>('agent_start', {
				root,
				cwd,
				chatId: meta.id,
				prompt,
				// Another agent picks its own model (no model picker for it: runtimes.ts).
				model: runtimeOf(meta) === CLAUDE_RUNTIME ? meta.model : null,
				permissionMode: this.allowAll[key] ? 'bypassPermissions' : meta.permission_mode,
				resume,
				resumeAt,
				mcpServers: Object.keys(mcp).length ? mcp : null,
				plugins: plugins.length ? plugins : null,
				images: images.length ? images : null,
				// Rust sends it only when off: the host's safety checks are on by default.
				safetyChecks: settings.get<boolean>('kingu.agent.safetyChecks') !== false,
				// The rules files (rules.rs) for these attached files; null leaves them out.
				rules: settings.get<boolean>('kingu.chat.rules.enabled') !== false ? files : null,
				runtime: runtimeOf(meta),
				// Ask or a custom agent (Rust looks the name up among the folder's agent files).
				agent: meta.agent ?? null,
				// Configure Tools: what the chat runs without (chatTools.ts).
				disabledTools: meta.disabled_tools?.length ? meta.disabled_tools : null,
				onEvent
			});
			clientLog('info', `agent run ${state.runId} started for chat ${meta.id}`);
			this.#patch(root, meta.id, { working: true });
		} catch (e) {
			applyEvent(state, { kind: 'error', message: String(e) });
			applyEvent(state, { kind: 'exit', code: null, signal: null, stopped: false });
			throw e;
		}
	}

	/** A message: into the live run, else a new run resuming the chat's session. */
	async send(id: string, message: OutgoingMessage): Promise<boolean> {
		const root = this.root;
		const meta = this.get(id);
		if (!root || !meta || !message.text.trim()) return false;
		await this.open(id);
		let run = this.runs[runKey(root, id)];
		this.#lastImages.set(runKey(root, id), message);
		try {
			// Another agent was picked since this run started: a new run continues the session with it
			// (its instructions and tools are fixed at the start). A busy turn keeps going: steered in.
			if (run && !run.ended && (run.agent ?? null) !== (meta.agent ?? null) && !turnBusy(run)) {
				await this.stopAndWait(id);
				run = this.runs[runKey(root, id)];
			}
			const plan = chatSendPlan(run, meta.session_id);
			if (plan.kind === 'send') {
				if (run?.runId === undefined) throw new Error(t('team.agent.stillStarting'));
				await invoke('agent_send', { runId: run.runId, text: message.text, images: message.images.length ? message.images : null });
				this.#patch(root, id, { working: true });
			} else await this.#start(root, meta, message.text, plan.resume, message.images, message.files);
			return true;
		} catch (e) {
			notifications.error(t('chat.sendFailed', { error: String(e) }));
			return false;
		}
	}

	/**
	 * Sends now, or while a turn runs (`how`): queues it (VS Code's Add to Queue), steers (into the
	 * running session now: the SDK reads it at its next opportunity) or stops the turn and sends.
	 * 'queued' or whether it was sent.
	 */
	async submit(id: string, message: OutgoingMessage, label: string, how: SendHow = 'queue'): Promise<'queued' | boolean> {
		const root = this.root;
		if (!root) return false;
		const key = runKey(root, id);
		const busy = turnBusy(this.runs[key]);
		if (how === 'stop' && busy) await this.interrupt(id);
		if (how !== 'queue') return this.send(id, message);
		if (busy || this.queues[key]?.length) {
			this.queues[key] = [...(this.queues[key] ?? []), { ...message, label, n: ++this.#queued }];
			return 'queued';
		}
		return this.send(id, message);
	}

	queue(id: string): QueuedMessage[] {
		return (this.root && this.queues[runKey(this.root, id)]) || [];
	}

	unqueue(id: string, n: number) {
		if (!this.root) return;
		const key = runKey(this.root, id);
		this.queues[key] = (this.queues[key] ?? []).filter((q) => q.n !== n);
	}

	/** Edit on a queued row: takes it out of the queue for the input. */
	takeQueued(id: string, n: number): QueuedMessage | undefined {
		const item = this.queue(id).find((q) => q.n === n);
		if (item) this.unqueue(id, n);
		return item;
	}

	/**
	 * Moves a queued request to `index` in the queue (Cursor's drag to reorder); the queue's
	 * order is the order they are sent in.
	 */
	moveQueued(id: string, n: number, index: number) {
		if (!this.root) return;
		const key = runKey(this.root, id);
		const list = this.queues[key] ?? [];
		const from = list.findIndex((q) => q.n === n);
		if (from >= 0) this.queues[key] = moveItem(list, from, index);
	}

	/**
	 * Puts a request back in the queue at `index` (an edited queued message, or one whose edit was
	 * cancelled), keeping its number. When the turn ended meanwhile, the queue's head goes now.
	 */
	requeue(id: string, item: QueuedMessage, index: number) {
		const root = this.root;
		if (!root) return;
		const key = runKey(root, id);
		const list = [...(this.queues[key] ?? []).filter((q) => q.n !== item.n)];
		list.splice(Math.max(0, Math.min(index, list.length)), 0, item);
		this.queues[key] = list;
		if (!turnBusy(this.runs[key])) queueMicrotask(() => void this.#drain(root, id));
	}

	/**
	 * Send Now on a queued row: out of the queue and into the running session (`steer`, the
	 * agent reads it at its next opportunity), or the turn is stopped first (`stop`, for runtimes
	 * that cannot steer).
	 */
	async sendQueuedNow(id: string, n: number, how: 'steer' | 'stop' = 'steer'): Promise<boolean> {
		const item = this.takeQueued(id, n);
		if (!item) return false;
		if (how === 'stop' && turnBusy(this.run(id))) await this.interrupt(id);
		const sent = await this.send(id, { text: item.text, images: item.images });
		if (!sent && this.root) {
			const key = runKey(this.root, id);
			this.queues[key] = [item, ...(this.queues[key] ?? [])];
		}
		return sent;
	}

	/** Sends the queue's head once the turn is over (the rest follow turn by turn). */
	async #drain(root: string, id: string) {
		const key = runKey(root, id);
		const run = this.runs[key];
		const head = this.queues[key]?.[0];
		if (!head || root !== this.root || turnBusy(run)) return;
		this.queues[key] = this.queues[key].slice(1);
		const sent = await this.send(id, { text: head.text, images: head.images, files: head.files });
		if (!sent) this.queues[key] = [head, ...(this.queues[key] ?? [])];
	}

	/** Retry: the last request again, with its images when they are still known. */
	async retry(id: string): Promise<boolean> {
		const root = this.root;
		const run = this.run(id);
		const last = run && lastRequest(buildTurns(run));
		if (!root || !last) return false;
		const text = withoutImagesLine(last.sent);
		const known = this.#lastImages.get(runKey(root, id));
		return (await this.submit(id, { text, images: known?.text === text ? known.images : [] }, last.text)) !== false;
	}

	/** The text and images of the last request sent, while known (Retry sends the images again). */
	lastSent(id: string): OutgoingMessage | undefined {
		return this.root ? this.#lastImages.get(runKey(this.root, id)) : undefined;
	}

	/** Stops the chat's run and waits for its end; false when it did not end in time. */
	async stopAndWait(id: string, timeoutMs = 8000): Promise<boolean> {
		const run = this.run(id);
		if (!run || run.ended) return true;
		if (run.runId === undefined) return false;
		const ended = new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				off();
				resolve(this.run(id)?.ended ?? true);
			}, timeoutMs);
			const off = this.onEvent((chat, ev) => {
				if (chat !== id || ev.kind !== 'exit') return;
				clearTimeout(timer);
				off();
				resolve(true);
			});
		});
		await this.stop(id);
		return ended;
	}

	/**
	 * After Rust rewrote the chat's transcript (a rewind or its Redo): the timeline is the saved
	 * one again, and the next run continues the conversation from `resume`. Its queue is dropped.
	 */
	async reload(id: string, resume: ForkPoint) {
		const root = this.root;
		if (!root || !this.get(id)) return;
		const key = runKey(root, id);
		const events = await invoke<AgentEvent[]>('chat_transcript_load', { id }).catch(() => [] as AgentEvent[]);
		const s = replayTranscript(events);
		const meta = rewoundMeta(resume);
		s.sessionId = meta.session_id;
		this.runs[key] = { ...s, id, root, runId: undefined, startedAt: this.get(id)?.updated_at ?? 0 };
		delete this.queues[key];
		this.#lastImages.delete(key);
		this.#patch(root, id, meta);
	}

	/**
	 * Import Chat: the chat file at `path` (Export Chat's, or VS Code's) becomes a new chat of this
	 * folder, its history shown; its next message starts a new session. Returns its id and title.
	 */
	async importFile(path: string): Promise<{ id: string; title: string } | undefined> {
		const root = this.root;
		if (!root) return;
		const now = Date.now();
		const id = newChatId(now);
		const got = await invoke<{ title: string; prompt: string; model: string | null; permission_mode: PermissionMode | null; created_at: number }>('chat_import', { path, newId: id });
		const base = newChat({ prompt: got.prompt || got.title, cwd: { kind: 'folder' }, model: got.model, permissionMode: got.permission_mode }, now, id);
		const title = renamedChatTitle('', got.title) ?? base.title;
		this.#save([...this.list, { ...base, title, title_auto: false, created_at: Math.min(got.created_at, now) }], root);
		await this.#saving;
		return { id, title };
	}

	/**
	 * Fork Conversation: a new chat with this chat's conversation before request `before` (all of
	 * it with null), titled "Forked: …"; its first message continues from there. The source chat
	 * is unchanged. Returns the new chat's id.
	 */
	async fork(id: string, before: number | null, opts: { side?: boolean } = {}): Promise<string | undefined> {
		const root = this.root;
		const meta = this.get(id);
		if (!root || !meta) return;
		const now = Date.now();
		const newId = newChatId(now);
		try {
			const point = await invoke<ForkPoint>('chat_fork', { id, newId, before });
			const title = opts.side ? t('chatTranscript.side.title', { title: meta.title }) : forkTitle(meta.title, t('chatRewind.forkedPrefix'), (title) => t('chatRewind.forkedTitle', { title }));
			const fork: ChatMeta = { ...meta, id: newId, title: renamedChatTitle('', title) ?? meta.title, ...rewoundMeta(point), created_at: now, updated_at: now, last_run: null, working: false, side_of: opts.side ? id : null };
			this.#save([...this.list, fork], root);
			await this.#saving;
			return newId;
		} catch (e) {
			notifications.error(t('chatRewind.forkFailed', { error: String(e) }));
			return undefined;
		}
	}

	async answer(id: string, requestId: string, decision: Decision, message?: string, answers?: Record<string, string>) {
		const run = this.run(id);
		if (run?.runId === undefined) return;
		await invoke('agent_answer_permission', { runId: run.runId, requestId, decision, message: message?.trim() || null, answers: answers ?? null }).catch((e) =>
			notifications.error(t('chat.answerFailed', { error: String(e) }))
		);
	}

	async interrupt(id: string) {
		const run = this.run(id);
		if (run?.runId !== undefined && !run.ended) await invoke('agent_interrupt', { runId: run.runId }).catch((e) => notifications.error(e));
	}

	async stop(id: string) {
		const run = this.run(id);
		if (run?.runId !== undefined && !run.ended) await invoke('agent_stop', { runId: run.runId }).catch((e) => notifications.error(e));
	}

	/** The chat's model: changed in the live session right away, else used by its next run. */
	async setModel(id: string, model: string): Promise<'live' | 'next' | null> {
		return this.#setOption(id, { model: model.trim() || null }, { model: model.trim() || null });
	}

	/** "Allow all" stays in memory (`allowAll`); the chat keeps an Agent mode it can save. */
	async setPermissionMode(id: string, mode: RunPermissionMode): Promise<'live' | 'next' | null> {
		const meta = this.get(id);
		if (!this.root || !meta) return null;
		const key = runKey(this.root, id);
		if (mode === 'bypassPermissions') {
			const when = await this.#setOption(id, { permission_mode: meta.permission_mode === 'plan' ? 'default' : meta.permission_mode }, { permissionMode: mode });
			if (when) this.allowAll[key] = true;
			return when;
		}
		const when = await this.#setOption(id, { permission_mode: mode }, { permissionMode: mode });
		if (when) delete this.allowAll[key];
		return when;
	}

	/**
	 * The chat's agent (VS Code's Ask or a custom agent; null: Agent / Plan by the permission mode).
	 * Its instructions and tools are fixed when a run starts, so a live session that is idle ends
	 * now and the next message continues it in a new run; a busy one at the next message after it.
	 */
	async setAgent(id: string, agent: string | null): Promise<'next' | null> {
		const root = this.root;
		const meta = this.get(id);
		if (!root || !meta) return null;
		if ((meta.agent ?? null) === agent) return 'next';
		this.#patch(root, id, { agent });
		const run = this.run(id);
		if (run && !run.ended && (run.agent ?? null) !== agent && !turnBusy(run)) await this.stopAndWait(id);
		return 'next';
	}

	/**
	 * Configure Tools (chatTools.ts): the tools the chat runs without. A run's tools are fixed when
	 * it starts, so an idle live session ends now and the next message continues it in a new run;
	 * a busy one keeps its tools until then.
	 */
	async setDisabledTools(id: string, tools: string[]): Promise<boolean> {
		const root = this.root;
		const meta = this.get(id);
		if (!root || !meta) return false;
		const before = meta.disabled_tools ?? [];
		if (before.length === tools.length && before.every((t, i) => t === tools[i])) return false;
		this.#patch(root, id, { disabled_tools: tools });
		const run = this.run(id);
		if (run && !run.ended && !turnBusy(run)) await this.stopAndWait(id);
		return true;
	}

	/** The chat runs with "Allow all". */
	isAllowAll(id: string): boolean {
		return !!this.root && !!this.allowAll[runKey(this.root, id)];
	}

	async #setOption(id: string, patch: Partial<ChatMeta>, wire: { model?: string | null; permissionMode?: RunPermissionMode }): Promise<'live' | 'next' | null> {
		const root = this.root;
		if (!root || !this.get(id)) return null;
		const run = this.run(id);
		const when = optionChange(run, run?.runId);
		if (when === 'live' && (wire.model || wire.permissionMode)) {
			try {
				await invoke('agent_set_options', { runId: run!.runId, model: wire.model ?? null, permissionMode: wire.permissionMode ?? null });
			} catch (e) {
				notifications.error(t('chat.optionFailed', { error: String(e) }));
				return null;
			}
		}
		this.#patch(root, id, patch);
		return when;
	}

	/** A side chat kept as a chat of its own: it joins the history. */
	keepSideChat(id: string) {
		if (this.root && this.get(id)?.side_of) this.#patch(this.root, id, { side_of: null });
	}

	rename(id: string, input: string) {
		const meta = this.get(id);
		const title = meta && renamedChatTitle(meta.title, input);
		// A title the user chose: an AI title never replaces it.
		if (title && this.root) this.#patch(this.root, id, { title, title_auto: false });
	}

	/**
	 * After the first answer of a chat that still has its first-prompt title (kingu.chat.aiTitles):
	 * a 3–6 word title from the source-control AI agent, tried once per chat. Rust runs it only
	 * when the user set that agent up; any failure leaves the title as it is.
	 */
	async #aiTitle(root: string, id: string, answer: string | null) {
		const key = runKey(root, id);
		const meta = this.get(id);
		if (root !== this.root || !meta || !wantsAiTitle(meta) || this.#titled.has(key) || settings.get<boolean>('kingu.chat.aiTitles') === false) return;
		this.#titled.add(key);
		try {
			const answerText = await invoke<string | null>('ai_chat_title', { prompt: chatTitlePrompt(meta.prompt, answer) });
			const title = answerText && parseChatTitle(answerText);
			const now = this.get(id);
			// Renamed (or another folder opened) meanwhile: keep that.
			if (!title || root !== this.root || !now || !wantsAiTitle(now)) return;
			this.#patch(root, id, { title, updated_at: now.updated_at });
		} catch (e) {
			clientLog('info', `chat ${id}: no AI title: ${String(e).slice(0, 200)}`);
		}
	}

	/** Deletes the chat and its transcript; refused (by Rust too) while its agent runs. */
	async remove(id: string): Promise<boolean> {
		const root = this.root;
		const meta = this.get(id);
		if (!root || !meta) return false;
		const run = this.run(id);
		if (run && !run.ended) {
			notifications.error(t('chat.stopFirst'));
			return false;
		}
		try {
			await invoke('chat_transcript_delete', { id, sessionId: meta.session_id });
		} catch (e) {
			notifications.error(t('chat.deleteFailed', { error: String(e) }));
			return false;
		}
		delete this.runs[runKey(root, id)];
		delete this.queues[runKey(root, id)];
		delete this.allowAll[runKey(root, id)];
		this.#save(removeChat(this.list, id), root);
		return true;
	}
}

export const chats = new Chats();
