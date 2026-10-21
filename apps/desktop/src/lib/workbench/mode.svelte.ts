// Which layout the window shows: the IDE workbench or the Agents layout (VS Code's Agents window,
// in-window here). Switching only flips `mode`: the workbench stays mounted (hidden), so editors,
// terminals and the workbench layout keep their state; the Agents layout keeps its own parts.
// The layout, the session shown and what was read are kept per workspace (workspaceStorage), so
// a new window starts in the workbench; the side bars' widths are shared by every window.

import { SessionHistory, type AgentsFilter, type AppMode } from './titlebar';
import { workspaceStorage } from './workspaceStorage.svelte';

const KEY = 'kingu.appMode';
/** What each workspace keeps (the rest of Saved is shared). */
const WORKSPACE_KEYS = ['mode', 'activeSession', 'sessionsVisible', 'panelVisible', 'viewedAt'] as const;

type Saved = { mode?: AppMode; activeSession?: string | null; sessionsVisible?: boolean; panelVisible?: boolean; sessionsWidth?: number; panelWidth?: number; viewedAt?: Record<string, number> };

function readSaved(): Saved {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
	} catch {
		return {};
	}
}

class AppModeStore {
	mode = $state<AppMode>('workbench');
	/** Task slug shown in the Agents layout. */
	activeSession = $state<string | null>(null);
	/** Bumped by New Session so the Agents layout focuses its composer. */
	composeRequest = $state(0);
	sessionsVisible = $state(true);
	panelVisible = $state(true);
	sessionsWidth = $state(280);
	panelWidth = $state(360);
	/** The Agents side bar shows only this group (a click on an agents status section). */
	filter = $state<AgentsFilter>('all');
	/** Unix ms each session was last looked at (for "unread"). */
	viewedAt = $state<Record<string, number>>({});
	canGoBack = $state(false);
	canGoForward = $state(false);
	#history = new SessionHistory();

	constructor() {
		const s = readSaved();
		if (typeof s.sessionsWidth === 'number') this.sessionsWidth = s.sessionsWidth;
		if (typeof s.panelWidth === 'number') this.panelWidth = s.panelWidth;
		// An older build kept the rest here for every window: it goes to the first workspace opened.
		workspaceStorage.register(KEY, WORKSPACE_KEYS, (saved) => this.#show((saved ?? {}) as Saved), s);
		$effect.root(() => {
			$effect(() => {
				const snapshot: Saved = { sessionsWidth: this.sessionsWidth, panelWidth: this.panelWidth };
				try {
					localStorage.setItem(KEY, JSON.stringify(snapshot));
				} catch {
					// Storage can be unavailable; the widths then reset on the next launch.
				}
			});
			$effect(() => {
				const snapshot: Saved = {
					mode: this.mode,
					activeSession: this.activeSession,
					sessionsVisible: this.sessionsVisible,
					panelVisible: this.panelVisible,
					viewedAt: { ...this.viewedAt }
				};
				if (workspaceStorage.scope !== undefined) workspaceStorage.save(KEY, snapshot);
			});
		});
	}

	/** Another workspace in this window (or the first one): its layout and sessions, else the defaults. */
	#show(s: Saved) {
		this.mode = s.mode === 'agents' ? 'agents' : 'workbench';
		this.activeSession = typeof s.activeSession === 'string' ? s.activeSession : null;
		this.sessionsVisible = typeof s.sessionsVisible === 'boolean' ? s.sessionsVisible : true;
		this.panelVisible = typeof s.panelVisible === 'boolean' ? s.panelVisible : true;
		this.viewedAt = s.viewedAt && typeof s.viewedAt === 'object' ? s.viewedAt : {};
		this.filter = 'all';
		this.#history = new SessionHistory();
		if (this.activeSession) this.#history.record(this.activeSession);
		this.#sync();
	}

	get isAgents() {
		return this.mode === 'agents';
	}

	setMode(mode: AppMode) {
		this.mode = mode;
	}

	/** Shows a session in the Agents layout (recorded for back/forward). */
	openSession(slug: string) {
		this.activeSession = slug;
		this.#history.record(slug);
		this.markViewed(slug);
		this.#sync();
	}

	markViewed(slug: string) {
		this.viewedAt[slug] = Date.now();
	}

	back() {
		const slug = this.#history.back();
		if (slug) this.activeSession = slug;
		this.#sync();
	}

	forward() {
		const slug = this.#history.forward();
		if (slug) this.activeSession = slug;
		this.#sync();
	}

	/** A session was removed: forget it in the history and the viewed marks. */
	forget(slug: string) {
		this.#history.remove(slug);
		delete this.viewedAt[slug];
		if (this.activeSession === slug) this.activeSession = this.#history.current;
		this.#sync();
	}

	#sync() {
		this.canGoBack = this.#history.canGoBack;
		this.canGoForward = this.#history.canGoForward;
	}
}

export const appMode = new AppModeStore();
