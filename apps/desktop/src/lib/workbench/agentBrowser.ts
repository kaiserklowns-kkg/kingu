// Agent browser use, the pure part (agentBrowser.svelte.ts holds the state; Rust
// floating_browser/agent.rs drives the pages). VS Code 1.147's browser tools: an agent uses pages
// it opened (their own in-memory store) and tabs the user shared with Share with Agent; the tab
// shows while an agent drives it, with Stop (VS Code's "Sharing with Agent" toggle and border,
// `browserEditorChatFeatures.ts`). The replayable action log is Kingu's own.

/** `kingu.browser.agentTools`: browser tools for chat agents, off unless turned on. */
export const AGENT_BROWSER_SETTING = 'kingu.browser.agentTools';
/** Webview labels of pages an agent opened (Rust `agent::LABEL_PREFIX`). */
export const AGENT_LABEL_PREFIX = 'agent-browser-';

/** Rust `agent::Page`. */
export type AgentPage = { label: string; url: string; agentOpened: boolean; opener: string | null; stopped: boolean; driving: boolean };
/** Rust `agent::Step`. */
export type AgentStep = {
	tool: string;
	url?: string;
	nav?: string;
	ref?: string;
	selector?: string;
	element?: string;
	text?: string;
	key?: string;
	submit?: boolean;
	dblClick?: boolean;
	button?: string;
};
/** Rust `agent::LogEntry`. */
export type AgentLogEntry = { seq: number; atMs: number; session: string; page: string; step: AgentStep; ok: boolean; outcome: string; secret: boolean };
/** The `agent-browser` event. */
export type AgentBrowserEvent = { label: string; page: AgentPage | null; action: string | null; logged?: AgentLogEntry };

export const isAgentLabel = (label: string) => label.startsWith(AGENT_LABEL_PREFIX);

/** What the tab shows: an agent drives it now, may drive it, or was stopped. */
export type Indicator = { kind: 'driving' | 'shared' | 'stopped'; action: string | null; agentOpened: boolean } | null;

export function indicatorOf(page: AgentPage | null | undefined, action: string | null | undefined): Indicator {
	if (!page) return null;
	if (page.stopped) return { kind: 'stopped', action: null, agentOpened: page.agentOpened };
	return { kind: page.driving ? 'driving' : 'shared', action: page.driving ? (action ?? null) : null, agentOpened: page.agentOpened };
}

/** Steps that replay (navigations, clicks, typing; not reads, screenshots, failures or password typing), in order. */
export function replaySteps(log: readonly AgentLogEntry[], page: string): AgentStep[] {
	return log
		.filter((e) => e.page === page && e.ok && !e.secret && ['open', 'navigate', 'click', 'type'].includes(e.step.tool))
		.sort((a, b) => a.seq - b.seq)
		.map((e) => e.step);
}

/** "chat c-1" for `chat:/root:c-1`; a run's own key stays short. */
export function sessionName(key: string): string {
	const m = key.match(/^chat:.*:([^:]+)$/);
	if (m) return `chat ${m[1]}`;
	// An agent on an SSH host (Rust ssh_browser_relay.rs): `ssh:<host>:<run>`.
	const ssh = key.match(/^ssh:(.*):([0-9a-f]{8,64})$/);
	if (ssh) return `${ssh[1]} run ${ssh[2]!.slice(0, 8)}`;
	return key.replace(/^run:/, 'run ');
}

/** One log row: time, what, and how it went. */
export function logRow(e: AgentLogEntry, timeOf: (ms: number) => string = (ms) => new Date(ms).toLocaleTimeString()): { label: string; description: string } {
	const what = e.secret ? `${e.outcome} (password, not kept)` : e.outcome;
	return { label: `${e.ok ? '✓' : '✗'} ${what}`, description: `${timeOf(e.atMs)} · ${sessionName(e.session)} · ${e.step.tool}` };
}

/** The log of one page as JSON (Copy as JSON; Replay takes the same steps). */
export function logJson(log: readonly AgentLogEntry[], page: string): string {
	return JSON.stringify(
		log.filter((e) => e.page === page).map((e) => ({ at: new Date(e.atMs).toISOString(), session: e.session, ok: e.ok, outcome: e.outcome, step: e.step })),
		null,
		2
	);
}
