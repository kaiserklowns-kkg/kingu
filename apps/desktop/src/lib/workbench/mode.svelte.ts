// Which layout the window shows: the IDE workbench or the Agents layout (VS Code's Agents window,
// in-window here). Switching only flips `mode`: the workbench stays mounted (hidden), so editors,
// terminals and the workbench layout keep their state; the Agents layout keeps its own parts.

import { SessionHistory, type AgentsFilter, type AppMode } from './titlebar';

const KEY = 'kingu.appMode';

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
	sessionsWidth = $state(300);
	panelWidth = $state(420);
	/** The Agents side bar shows only this group (a click on an agents status section). */
	filter = $state<AgentsFilter>('all');
	/** Unix ms each session was last looked at (for "unread"). */
	viewedAt = $state<Record<string, number>>({});
	canGoBack = $state(false);
	canGoForward = $state(false);
	#history = new SessionHistory();

	constructor() {
		const s = readSaved();
		if (s.mode === 'agents' || s.mode === 'workbench') this.mode = s.mode;
		if (typeof s.activeSession === 'string') this.activeSession = s.activeSession;
		if (typeof s.sessionsVisible === 'boolean') this.sessionsVisible = s.sessionsVisible;
		if (typeof s.panelVisible === 'boolean') this.panelVisible = s.panelVisible;
		if (typeof s.sessionsWidth === 'number') this.sessionsWidth = s.sessionsWidth;
		if (typeof s.panelWidth === 'number') this.panelWidth = s.panelWidth;
		if (s.viewedAt && typeof s.viewedAt === 'object') this.viewedAt = s.viewedAt;
		if (this.activeSession) this.#history.record(this.activeSession);
		$effect.root(() => {
			$effect(() => {
				const snapshot: Saved = {
					mode: this.mode,
					activeSession: this.activeSession,
					sessionsVisible: this.sessionsVisible,
					panelVisible: this.panelVisible,
					sessionsWidth: this.sessionsWidth,
					panelWidth: this.panelWidth,
					viewedAt: { ...this.viewedAt }
				};
				try {
					localStorage.setItem(KEY, JSON.stringify(snapshot));
				} catch {
					// Storage can be unavailable; the mode then resets on the next launch.
				}
			});
		});
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
