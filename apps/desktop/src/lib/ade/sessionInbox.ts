// Inbox mode (VS Code 1.146, `sessions.list.inboxEnabled`) over every agent Kingu watches: the
// tasks of the open folder and of the other added projects (their CLI in a terminal, or an
// agent-host run), the chats, and the agent CLIs in SSH terminals. Pure, so `bun test` covers the
// sorting, triage and folding; ./sessionInbox.svelte.ts gathers the entries from the stores.
//
// VS Code source:
// - src/vs/workbench/contrib/sessions/common/sessionInbox.ts: the sections (Inbox, Working, On
//   hold, Acknowledged), `getSessionInboxSection` (a working session stays in Working), the triage
//   states (`done` / `untilActivity` keep the activity they were decided on; `hold`; `snoozed`
//   until a time) and `isSessionInboxStateCurrent` (new activity ends a dismissal; Put on Hold
//   lasts until resumed; a snooze ends at its time).
// - src/vs/workbench/contrib/sessions/common/sessionAttentionService.ts and
//   browser/sessionAttentionService.ts: priority Now (needs input), Next, Later.
// - src/vs/workbench/contrib/sessions/browser/views/sessionsListActions.ts: the Snooze choices
//   (10 / 30 minutes, an hour, tomorrow 9:00, a week at 9:00, until new activity).
// - docs agents/run/sessions/organize-sessions.md "Triage sessions with Inbox mode".
// Orca source (mobile "Needs you", 1.4.272):
// - src/shared/bots/needs-you-fold.ts: approvals first and never folded, then the first five, a
//   "Show N more" footer only when it hides two or more, a focused row never hidden.
// - mobile/src/bots/items/phone-needs-you-asks.ts: approvals first, then the other asks.

/** What the agent waits for, or that it is working. `review`: it finished a turn to look at. */
export type InboxNeed = 'approval' | 'question' | 'failed' | 'review' | 'working';

export type InboxSource = 'task' | 'chat' | 'ssh';

/**
 * Kingu only: an approval answered from the inbox row (Allow once / Deny), for a chat's or an
 * agent-host task's own permission prompt. Questions and terminal prompts open where they were asked.
 */
export type InboxAnswer = { runId: number; requestId: string; tool: string; summary: string };

export type InboxEntry = {
	/** Stable across polls: `task:<root>:<slug>`, `chat:<root>:<id>`, `ssh:<tab id>`. */
	key: string;
	source: InboxSource;
	need: InboxNeed;
	title: string;
	/** The question, the tool asking, the error or the latest line. */
	detail: string;
	/** Project folder name or SSH host label. */
	where: string;
	/** Unix ms of its latest activity. */
	updatedAt: number;
	/** Changes with new activity; a dismissal or "until new activity" snooze ends when it does. */
	activity: string;
	answer?: InboxAnswer;
};

export type TriageState = { kind: 'done' | 'untilActivity'; activity: string } | { kind: 'hold' } | { kind: 'snoozed'; until: number };

export type InboxSection = 'inbox' | 'working' | 'onHold' | 'acknowledged';
export const INBOX_SECTIONS: readonly InboxSection[] = ['inbox', 'working', 'onHold', 'acknowledged'];

/** VS Code `InboxNotificationPriority`: Now (needs input), Next, Later. */
export function priorityOf(need: InboxNeed): number {
	return need === 'approval' || need === 'question' ? 0 : need === 'failed' ? 1 : 2;
}

/** Whether a triage decision still applies (VS Code `isSessionInboxStateCurrent`). */
export function isTriageCurrent(state: TriageState, entry: InboxEntry | undefined, now: number): boolean {
	if (state.kind === 'hold') return true;
	if (state.kind === 'snoozed') return state.until > now;
	// Keep the decision until the session is seen again.
	if (!entry) return true;
	return state.activity === entry.activity;
}

/** VS Code `getSessionInboxSection`: a triaged session goes where it was put; otherwise working ones are Working. */
export function sectionOf(entry: InboxEntry, state: TriageState | undefined): InboxSection {
	if (state?.kind === 'done') return 'acknowledged';
	if (state) return 'onHold';
	return entry.need === 'working' ? 'working' : 'inbox';
}

export type InboxView = Record<InboxSection, InboxEntry[]> & {
	/** Triage keys no longer current (new activity, a snooze that ended): the store drops them. */
	expired: string[];
};

/** Sorted sections: priority, then newest first (VS Code: shared priority, then the ordering). */
export function buildInbox(entries: readonly InboxEntry[], triage: Readonly<Record<string, TriageState>>, now: number): InboxView {
	const view: InboxView = { inbox: [], working: [], onHold: [], acknowledged: [], expired: [] };
	const byKey = new Map(entries.map((e) => [e.key, e]));
	for (const [key, state] of Object.entries(triage)) if (!isTriageCurrent(state, byKey.get(key), now)) view.expired.push(key);
	for (const e of entries) {
		const state = triage[e.key];
		view[sectionOf(e, state && !view.expired.includes(e.key) ? state : undefined)].push(e);
	}
	for (const s of INBOX_SECTIONS) view[s].sort((a, b) => priorityOf(a.need) - priorityOf(b.need) || b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
	return view;
}

/** Orca `NEEDS_YOU_CAP`. */
export const NEEDS_YOU_CAP = 5;

export type Fold = { visible: InboxEntry[]; hidden: number; folds: boolean };

/**
 * Orca `needsYouFold`: approvals first and never hidden, then the first five, then a footer.
 * One hidden row isn't worth a footer; the row holding focus stays.
 */
export function foldInbox(rows: readonly InboxEntry[], expanded: boolean, focusedKey: string | null = null): Fold {
	const approvals = rows.filter((r) => r.need === 'approval');
	const ordered = [...approvals, ...rows.filter((r) => r.need !== 'approval')];
	const shown = Math.max(NEEDS_YOU_CAP, approvals.length);
	const folds = ordered.length - shown >= 2;
	const visible = ordered.filter((r, i) => !folds || expanded || i < shown || r.key === focusedKey);
	return { visible, hidden: ordered.length - visible.length, folds };
}

export type SnoozeId = '10m' | '30m' | '1h' | 'tomorrow' | 'week' | 'activity';
export type SnoozeChoice = { id: SnoozeId; until: number | 'untilActivity' };

/** VS Code's Snooze choices; "tomorrow morning" and "in one week" are at 9:00 local time. */
export function snoozeChoices(now: number): SnoozeChoice[] {
	const d = new Date(now);
	const morning = (days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 9).getTime();
	return [
		{ id: '10m', until: now + 10 * 60_000 },
		{ id: '30m', until: now + 30 * 60_000 },
		{ id: '1h', until: now + 60 * 60_000 },
		{ id: 'tomorrow', until: morning(1) },
		{ id: 'week', until: morning(7) },
		{ id: 'activity', until: 'untilActivity' }
	];
}

/** The triage state of a Snooze choice for `entry`. */
export function snoozeState(choice: SnoozeChoice, entry: InboxEntry): TriageState {
	return choice.until === 'untilActivity' ? { kind: 'untilActivity', activity: entry.activity } : { kind: 'snoozed', until: choice.until };
}

/** Saved triage (localStorage may hold anything): only well-formed states. */
export function parseTriage(raw: unknown): Record<string, TriageState> {
	const out: Record<string, TriageState> = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
	for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!v || typeof v !== 'object') continue;
		const s = v as Record<string, unknown>;
		if ((s.kind === 'done' || s.kind === 'untilActivity') && typeof s.activity === 'string') out[key] = { kind: s.kind, activity: s.activity };
		else if (s.kind === 'hold') out[key] = { kind: 'hold' };
		else if (s.kind === 'snoozed' && typeof s.until === 'number' && Number.isFinite(s.until)) out[key] = { kind: 'snoozed', until: s.until };
	}
	return out;
}
