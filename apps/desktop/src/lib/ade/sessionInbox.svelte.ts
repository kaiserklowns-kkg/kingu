// The Inbox page's store (VS Code 1.146 Inbox mode; Orca's "Needs you"): reads the stores Kingu
// already keeps — the open folder's tasks (`adeTasks.views`, which merge the task's CLI hooks,
// its terminal panes and its agent-host run), the other added projects' tasks (`projects.all`),
// the chats' runs (`chats.runs`, every folder) and the agent CLIs in SSH terminals
// (`sshProjects.agents`, judged by `remoteAgentStatus` and their hook state) — into one list
// (sessionInbox.ts). Triage (dismiss, hold, snooze) is kept in localStorage, per machine, like
// VS Code's profile-local triage. `sessions.list.inboxEnabled` (off by default, as in VS Code)
// shows the Inbox entry in the side bar.

import { invoke } from '@tauri-apps/api/core';
import { settings } from '#lib/settings/settings.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { clientLog } from '#lib/client-log.ts';
import { t } from '#lib/i18n/index.ts';
import { chats } from '#lib/agent/chats.svelte.ts';
import { agents } from '#lib/agent/agents.svelte.ts';
import { openChat } from '#lib/agent/chatCommands.svelte.ts';
import type { RunState } from '#lib/agent/events.ts';
import { adeTasks } from './tasks.svelte.ts';
import { projects } from './projects.svelte.ts';
import { sshProjects } from './sshProjects.svelte.ts';
import { sshHosts } from './sshHosts.svelte.ts';
import { remoteAgentStatus } from './sshRemote.ts';
import { isQuestionTool, questionText } from './agentHooks.ts';
import { adeLayout } from './adeLayout.svelte.ts';
import type { TaskView } from './model.ts';
import { buildInbox, parseTriage, snoozeState, type InboxEntry, type InboxNeed, type SnoozeChoice, type TriageState } from './sessionInbox.ts';

const STORE = 'kingu.sessionInbox.triage';
export const INBOX_SETTING = 'sessions.list.inboxEnabled';

const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const firstLine = (s: string | undefined | null) => (s ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, 200) ?? '';

function load(): Record<string, TriageState> {
	try {
		return parseTriage(JSON.parse(localStorage.getItem(STORE) ?? '{}'));
	} catch {
		return {};
	}
}

/** A task's need, from its board status (needs you / failed / to review / working); done ones leave. */
function taskNeed(v: TaskView): InboxNeed | null {
	switch (v.status) {
		case 'waiting':
			return v.runtime?.question ? 'question' : 'approval';
		case 'failed':
			return 'failed';
		case 'review':
			return 'review';
		case 'running':
			return 'working';
		default:
			return null;
	}
}

/** The first permission prompt of an agent-host run, answerable from the row (Kingu only); questions are not. */
function answerOf(run: (RunState & { runId: number | undefined }) | undefined) {
	const p = run?.pending.find((x) => x.kind === 'permission_request');
	if (!run || run.runId === undefined || !p || isQuestionTool(p.tool)) return undefined;
	return { runId: run.runId, requestId: p.request_id, tool: p.tool, summary: firstLine(p.title ?? p.input_summary) };
}

function taskEntry(root: string, v: TaskView): InboxEntry | null {
	const need = taskNeed(v);
	if (!need) return null;
	const run = agents.list.find((r) => r.slug === v.meta.slug && r.root === root);
	const answer = need === 'approval' ? answerOf(run) : undefined;
	const updatedAt = Math.max(v.runtime?.updatedAt ?? 0, v.meta.updated_at ?? 0);
	return {
		key: `task:${root}:${v.meta.slug}`,
		source: 'task',
		need,
		title: v.meta.title || v.meta.slug,
		detail: firstLine(need === 'failed' ? (v.runtime?.error ?? v.runtime?.lastEvent) : v.runtime?.lastEvent),
		where: base(root),
		updatedAt,
		activity: `${need}:${updatedAt}:${v.runtime?.pendingPermissions ?? 0}`,
		...(answer ? { answer } : {})
	};
}

function chatNeed(run: RunState): InboxNeed | null {
	if (run.pending.length) return run.pending.some((p) => p.kind === 'permission_request' && !isQuestionTool(p.tool)) ? 'approval' : 'question';
	if (run.mcpPending?.length || run.signIn) return 'question';
	if (run.status === 'running' || run.status === 'starting') return 'working';
	if (run.status === 'failed') return 'failed';
	if (run.status === 'idle' || run.status === 'done') return 'review';
	return null;
}

class SessionInbox {
	triage = $state<Record<string, TriageState>>(typeof localStorage === 'undefined' ? {} : load());
	/** Ticks so snoozes end on time. */
	now = $state(Date.now());
	/** "Show N more" opened on the Inbox section. */
	expanded = $state(false);
	/** The last triage change, for Undo (VS Code's notification Undo). */
	lastChange = $state<{ key: string; before: TriageState | undefined; label: string } | null>(null);
	enabled = $derived(settings.get<boolean>(INBOX_SETTING) === true);

	entries: InboxEntry[] = $derived.by(() => {
		const out: InboxEntry[] = [];
		const root = workspace.root;
		if (root) for (const v of adeTasks.views) {
			const e = taskEntry(root, v);
			if (e) out.push(e);
		}
		for (const { root: r, view } of projects.all) {
			const e = taskEntry(r, view);
			if (e) out.push(e);
		}
		for (const run of Object.values(chats.runs)) {
			// A transcript replayed after a restart is history, not activity of this session.
			if (run.runId === undefined) continue;
			const need = chatNeed(run);
			if (!need) continue;
			const meta = run.root === chats.root ? chats.get(run.id) : undefined;
			if (meta?.side_of) continue;
			const p = run.pending[0];
			const detail = p ? (isQuestionTool(p.tool) ? (questionText(p.input) ?? p.input_summary) : `${p.tool}: ${p.title ?? p.input_summary}`) : need === 'failed' ? (run.error ?? '') : '';
			const updatedAt = Math.max(meta?.updated_at ?? 0, run.startedAt);
			const answer = need === 'approval' ? answerOf(run) : undefined;
			out.push({
				key: `chat:${run.root}:${run.id}`,
				source: 'chat',
				need,
				title: meta?.title ?? t('inbox.chatUntitled'),
				detail: firstLine(detail),
				where: base(run.root),
				updatedAt,
				activity: `${need}:${run.items.length}:${run.pending.map((x) => x.request_id).join(',')}`,
				...(answer ? { answer } : {})
			});
		}
		for (const [id, a] of Object.entries(sshProjects.agents)) {
			const s = remoteAgentStatus(a, sshProjects.now);
			const need: InboxNeed | null = s === 'waiting' ? (a.hook?.question && !a.hook.permission ? 'question' : 'approval') : s === 'running' ? 'working' : s === 'review' ? 'review' : s === 'failed' ? 'failed' : null;
			if (!need) continue;
			const host = sshHosts.targets.find((x) => x.id === a.host)?.label ?? a.host;
			const req = a.hook?.request;
			const updatedAt = a.hook?.at ?? a.lastOutput ?? a.startedAt;
			out.push({
				key: `ssh:${id}`,
				source: 'ssh',
				need,
				title: a.name,
				detail: firstLine(need === 'approval' && req ? `${req.tool}: ${req.detail ?? ''}` : a.hook?.message),
				where: host,
				updatedAt,
				activity: `${need}:${a.hook?.at ?? 0}`
			});
		}
		return out;
	});

	view = $derived(buildInbox(this.entries, this.triage, this.now));
	/** The Inbox section's count (the side bar badge). */
	count = $derived(this.view.inbox.length);

	constructor() {
		if (typeof window === 'undefined') return;
		$effect.root(() => {
			$effect(() => {
				const snapshot = $state.snapshot(this.triage);
				try {
					localStorage.setItem(STORE, JSON.stringify(snapshot));
				} catch {
					// Storage blocked: triage lasts this run only.
				}
			});
			// New activity or an ended snooze returns the session to where its status puts it.
			$effect(() => {
				const expired = this.view.expired;
				if (!expired.length) return;
				const next = { ...this.triage };
				for (const k of expired) delete next[k];
				this.triage = next;
			});
		});
		setInterval(() => (this.now = Date.now()), 30_000);
	}

	#set(key: string, state: TriageState | undefined, label: string) {
		const before = this.triage[key];
		const next = { ...this.triage };
		if (state) next[key] = state;
		else delete next[key];
		this.triage = next;
		this.lastChange = { key, before, label };
	}

	/** Dismiss from Inbox: to Acknowledged until new activity; never stops or archives anything. */
	dismiss(e: InboxEntry) {
		this.#set(e.key, { kind: 'done', activity: e.activity }, t('inbox.done.dismissed', { title: e.title }));
	}

	hold(e: InboxEntry) {
		this.#set(e.key, { kind: 'hold' }, t('inbox.done.held', { title: e.title }));
	}

	snooze(e: InboxEntry, choice: SnoozeChoice) {
		this.#set(e.key, snoozeState(choice, e), t('inbox.done.snoozed', { title: e.title }));
	}

	/** Return to Inbox: clears the triage choice; the session goes where its status puts it. */
	resume(e: InboxEntry) {
		this.#set(e.key, undefined, t('inbox.done.returned', { title: e.title }));
	}

	undo() {
		const c = this.lastChange;
		if (!c) return;
		const next = { ...this.triage };
		if (c.before) next[c.key] = c.before;
		else delete next[c.key];
		this.triage = next;
		this.lastChange = null;
	}

	stateOf(key: string): TriageState | undefined {
		return this.triage[key];
	}

	/** Opens where the session lives: the task, the chat, or the SSH terminal. */
	open(e: InboxEntry) {
		const [kind, ...rest] = e.key.split(':');
		if (kind === 'ssh') return sshProjects.showTerminal(rest.join(':'));
		const id = rest.pop()!;
		const root = rest.join(':');
		if (kind === 'chat') {
			if (root === workspace.root) return openChat(id);
			return void status.flash(t('inbox.chatOtherFolder', { folder: base(root) }), 8000);
		}
		if (root !== workspace.root) return void projects.open(root, id);
		if (!appMode.isAgents) appMode.setMode('agents');
		adeLayout.page = null;
		adeTasks.openTask(id);
	}

	/**
	 * Kingu only: answers the row's permission prompt once (Allow) or refuses it (Deny), as the
	 * chat's own card would with "Allow" / "Deny". "Always" choices stay on the card.
	 */
	async answer(e: InboxEntry, allow: boolean) {
		const a = e.answer;
		if (!a) return;
		try {
			await invoke('agent_answer_permission', { runId: a.runId, requestId: a.requestId, decision: allow ? 'allow' : 'deny', message: null, answers: null });
			clientLog('info', `inbox: ${allow ? 'allowed' : 'denied'} ${a.tool} for ${e.key}`);
		} catch (err) {
			notifications.error(t('inbox.answerFailed', { error: String(err) }));
		}
	}
}

export const sessionInbox = new SessionInbox();

/** Palette commands (VS Code: they share the setting's availability gate). */
export function installSessionInbox(): () => void {
	const unregister = [
		commands.register({
			id: 'kingu.inbox.show',
			title: 'Agents: Show Inbox',
			category: 'Agents',
			when: () => sessionInbox.enabled,
			run: () => {
				if (!appMode.isAgents) appMode.setMode('agents');
				appMode.sessionsVisible = true;
				adeLayout.page = 'inbox';
			}
		})
	];
	return () => unregister.forEach((u) => u());
}
