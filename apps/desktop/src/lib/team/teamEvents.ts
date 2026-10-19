// Live updates from the team server, pure parts (testable with `bun test`): which `team://event`
// kinds refresh which view. Rust forwards ids only; views re-read what they show.

/** Mirrors `team::events::TeamEvent` in Rust. */
export type TeamEvent = {
	server: string;
	kind: string;
	id: number | null;
	project_id: string | null;
	task_id: string | null;
	snap_id: string | null;
};

/** Mirrors `team::events::StreamState`. */
export type StreamState = 'connected' | 'reconnecting' | 'off';

export type Timers = {
	set: (fn: () => void, ms: number) => unknown;
	clear: (handle: unknown) => void;
};

const realTimers: Timers = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
};

export const SNAP_RELOAD_DEBOUNCE_MS = 250;

/**
 * Debounced reload of the team Snap catalog on `snap.*` and `reset` (the server could not replay
 * what was missed), and when the stream (re)connects, since a first connection replays nothing.
 * Task and run events have no team view on the desktop yet, so they are ignored.
 */
export function createSnapEventRouter(reload: () => void, debounceMs = SNAP_RELOAD_DEBOUNCE_MS, timers: Timers = realTimers) {
	return createTeamEventRouter('snap.', reload, debounceMs, timers);
}

/** The same for any team list: a debounced reload on `<prefix>*` events, `reset` and a (re)connect. */
export function createTeamEventRouter(prefix: string, reload: () => void, debounceMs = SNAP_RELOAD_DEBOUNCE_MS, timers: Timers = realTimers) {
	let timer: unknown;
	let pending = false;
	let state: StreamState = 'off';
	const soon = () => {
		if (pending) timers.clear(timer);
		pending = true;
		timer = timers.set(() => {
			pending = false;
			reload();
		}, debounceMs);
	};
	return {
		/** Returns whether the event triggers a reload. */
		event(e: Pick<TeamEvent, 'kind'>): boolean {
			if (e.kind === 'reset' || e.kind.startsWith(prefix)) {
				soon();
				return true;
			}
			return false;
		},
		stream(next: StreamState | undefined) {
			const prev = state;
			state = next ?? 'off';
			if (state === 'connected' && prev !== 'connected') soon();
		},
		dispose() {
			if (pending) timers.clear(timer);
			pending = false;
		}
	};
}

/** The focus reload is only a fallback for when live updates are down. */
export const needsFocusReload = (state: StreamState | undefined) => state !== 'connected';
