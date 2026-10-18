/**
 * `chats` — agent chats of the open folder (VS Code's chat sessions), separate from ADE tasks
 * (`adeTasks`): no worktree, no setup script, no tabs, and never a terminal or a CLI. Each chat
 * is one agent-host session, run in the open folder or one of its task worktrees.
 *
 *   chats.list / chats.sorted          ChatMeta[] of the open folder (chats.json), newest first
 *   chats.run(id)                      ChatRun | undefined: the chat's timeline (live, or replayed)
 *   chats.open(id)                     loads the saved transcript once (after a restart)
 *   chats.create({ prompt, cwd, model, permissionMode, message })  new chat + first run
 *   chats.send(id, message)            into the live run, else a new run resuming its session
 *   chats.submit(id, message, label, how)  while a turn runs: queue it (sent when the turn ends),
 *                                      steer (into the running session now) or stop and send
 *   chats.queue(id) / unqueue(id, n)   the chat's queued requests; takeQueued / sendQueuedNow
 *                                      (Edit / Send Immediately on a queued row)
 *   chats.retry(id)                    sends the last request again
 *   chats.setModel / setPermissionMode applied to the live session (SDK setModel / setPermissionMode)
 *                                      or saved for the next run; returns which. "Allow all"
 *                                      (`bypassPermissions`) is kept in memory only (`allowAll`)
 *   chats.answer / interrupt / stop / rename / remove / promote
 *
 * Runs are keyed by folder + chat id (`runKey`), so they keep streaming while another folder is
 * open; only the open folder's list is loaded and saved. Rust appends each run's events to the
 * chat's transcript and refuses a second live run of a chat or of its session.
 */

import { Channel, invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { runSummary } from '#lib/ade/model.ts';
import { mcpServers, skillPlugins } from '#lib/ade/mcp.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { applyEvent, initialRun, type AgentEvent, type Decision, type RunState } from './events';
import { buildTurns, lastRequest } from './chatParts.ts';
import { withoutImagesLine } from './chatPrompt.ts';
import { shouldDrain, turnBusy, type RunPermissionMode } from './chatInput.ts';
import type { SendHow } from './requestQueuing.ts';
import {
	chatCwdPath,
	chatSendPlan,
	newChat,
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
	type PermissionMode
} from './chats.ts';

export type ChatRun = RunState & {
	id: string;
	root: string;
	/** Rust run id; undefined until started (and for a replayed transcript). */
	runId: number | undefined;
	startedAt: number;
};

type Listener = (id: string, ev: AgentEvent) => void;

/** What a request sends: the prompt (text and attached-context block) and image files. */
export type OutgoingMessage = { text: string; images: string[] };
/** A request waiting for the running turn to end. `label` is what the user typed. */
export type QueuedMessage = OutgoingMessage & { n: number; label: string };

class Chats {
	list = $state<ChatMeta[]>([]);
	/** The folder `list` belongs to. */
	root = $state<string | null>(null);
	loaded = $state(false);
	runs = $state<Record<string, ChatRun>>({});
	sorted = $derived(sortChats(this.list));
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
			s.sessionId ??= meta?.session_id ?? null;
			this.runs[runKey(root, id)] = { ...s, id, root, runId: undefined, startedAt: meta?.updated_at ?? 0 };
		} catch (e) {
			clientLog('info', `chat ${id}: transcript not loaded: ${e}`);
		}
	}

	async create(input: { prompt: string; cwd: ChatCwd; model: string | null; permissionMode: RunPermissionMode; message: OutgoingMessage }): Promise<string | undefined> {
		const root = workspace.root;
		if (!root || !input.prompt.trim()) return;
		if (root !== this.root) await this.load();
		const allowAll = input.permissionMode === 'bypassPermissions';
		const meta = newChat({ prompt: input.prompt, cwd: input.cwd, model: input.model, permissionMode: allowAll ? 'default' : (input.permissionMode as PermissionMode) }, Date.now());
		if (allowAll) this.allowAll[runKey(root, meta.id)] = true;
		this.#save([...this.list, meta], root);
		await this.#saving;
		this.#lastImages.set(runKey(root, meta.id), input.message);
		await this.#start(root, meta, input.message.text, null, input.message.images);
		return meta.id;
	}

	async #start(root: string, meta: ChatMeta, prompt: string, resume: string | null, images: string[]) {
		const key = runKey(root, meta.id);
		const prev = this.runs[key];
		if (prev && !prev.ended) throw new Error(t('chat.alreadyRunning'));
		const run: ChatRun = { ...initialRun(), id: meta.id, root, runId: undefined, startedAt: Date.now() };
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
		const mcp = mcpServers(cwd);
		const plugins = await skillPlugins();
		let savedSession = meta.session_id;
		const onEvent = new Channel<AgentEvent>();
		onEvent.onmessage = (ev) => {
			applyEvent(state, ev);
			for (const fn of this.#listeners) fn(meta.id, ev);
			// Not shown in the chat (session start, stderr, SDK messages it does not know): logged.
			if (ev.kind === 'raw' || ev.kind === 'stderr') clientLog('info', `chat ${meta.id}: ${ev.kind}: ${ev.line.slice(0, 500)}`);
			if ((ev.kind === 'result' || ev.kind === 'exit') && shouldDrain(this.queues[key]?.length ?? 0, state)) queueMicrotask(() => void this.#drain(root, meta.id));
			if ((ev.kind === 'system' || ev.kind === 'result') && ev.session_id && ev.session_id !== savedSession) {
				savedSession = ev.session_id;
				this.#patch(root, meta.id, { session_id: ev.session_id });
			}
			if (ev.kind === 'result' || ev.kind === 'exit') this.#patch(root, meta.id, { last_run: runSummary({ ...state, slug: meta.id }, Date.now(), state.startedAt) });
		};
		try {
			state.runId = await invoke<number>('agent_start', {
				root,
				cwd,
				chatId: meta.id,
				prompt,
				model: meta.model,
				permissionMode: this.allowAll[key] ? 'bypassPermissions' : meta.permission_mode,
				resume,
				mcpServers: Object.keys(mcp).length ? mcp : null,
				plugins: plugins.length ? plugins : null,
				images: images.length ? images : null,
				onEvent
			});
			clientLog('info', `agent run ${state.runId} started for chat ${meta.id}`);
			this.#patch(root, meta.id, {});
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
		const run = this.runs[runKey(root, id)];
		this.#lastImages.set(runKey(root, id), message);
		try {
			const plan = chatSendPlan(run, meta.session_id);
			if (plan.kind === 'send') {
				if (run?.runId === undefined) throw new Error(t('team.agent.stillStarting'));
				await invoke('agent_send', { runId: run.runId, text: message.text, images: message.images.length ? message.images : null });
				this.#patch(root, id, {});
			} else await this.#start(root, meta, message.text, plan.resume, message.images);
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

	/** Send Immediately on a queued row: out of the queue and into the running session (steer). */
	async sendQueuedNow(id: string, n: number): Promise<boolean> {
		const item = this.takeQueued(id, n);
		if (!item) return false;
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
		const sent = await this.send(id, { text: head.text, images: head.images });
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

	rename(id: string, input: string) {
		const meta = this.get(id);
		const title = meta && renamedChatTitle(meta.title, input);
		if (title && this.root) this.#patch(this.root, id, { title });
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
