// Orca's Memory Saver (Settings → Browser; its `shared/browser/guest-lifecycle/browser-memory-saver.ts`
// and `main/browser/guest-lifecycle/browser-page-idle-discard.ts`): a browser tab nobody looked at
// for some awake hours has its page freed (the native view closes; the tab stays) and loads again
// when the tab is shown. The page itself may refuse (edits, playing media: Rust
// `floating_browser_discardable`); a tab the user keeps coming back to is left alone.

export const DEFAULT_MEMORY_SAVER_HOURS = 4;
export const MIN_MEMORY_SAVER_HOURS = 1;
export const MAX_MEMORY_SAVER_HOURS = 168;
/** Orca frees at most this many pages at once, and starts no more while that many are being asked. */
const BATCH = 4;
/** Orca's `revisits <= 15`: a tab shown again more often than this is in use, whatever the clock says. */
const MAX_REVISITS = 15;
/** A page that refused (it was edited, it plays audio) is asked again this much later while it stays hidden. */
export const MEMORY_SAVER_RETRY_MS = 15 * 60_000;

export type MemorySaverPolicy = { enabled: boolean; idleMs: number };

/** Whole hours in range; a missing or malformed value is the default (Orca's `getEffectiveBrowserMemorySaverHours`). */
export function memorySaverHours(hours: unknown): number {
	if (typeof hours !== 'number' || !Number.isFinite(hours)) return DEFAULT_MEMORY_SAVER_HOURS;
	return Math.min(MAX_MEMORY_SAVER_HOURS, Math.max(MIN_MEMORY_SAVER_HOURS, Math.round(hours)));
}

/** `kingu.browser.memorySaver` (on unless switched off) and `kingu.browser.memorySaverHours`. */
export function memorySaverPolicy(enabled: unknown, hours: unknown): MemorySaverPolicy {
	return { enabled: enabled !== false, idleMs: memorySaverHours(hours) * 60 * 60_000 };
}

/**
 * Time that passes only while the machine is awake (Orca's awake clock): a laptop closed overnight
 * must not free every tab in the morning. Each `tick` adds the time since the last one, at most
 * `maxStep`: a longer gap means the timers were asleep.
 */
export function createAwakeClock(wall: () => number, maxStep: number) {
	let last = wall();
	let awake = 0;
	const step = () => {
		const now = wall();
		awake += Math.min(Math.max(0, now - last), maxStep);
		last = now;
	};
	return {
		tick: step,
		now(): number {
			step();
			return awake;
		}
	};
}

type Page = {
	/** Awake-clock time the page went hidden; null while shown. */
	hiddenAt: number | null;
	/** Not asked before this (a refusal waits for the retry). */
	notBefore: number;
	revisits: number;
	/** Freed, or being asked: nothing more to do until it is shown again. */
	consumed: boolean;
	/** Frees the page if it still may be; false when it stays. */
	free: () => Promise<boolean>;
};

type Timer = unknown;

/** The clock and timers are passed in, so the policy is tested without waiting. */
export function createMemorySaver(sources: { now: () => number; setTimer: (run: () => void, ms: number) => Timer; clearTimer: (t: Timer) => void }) {
	const pages = new Map<string, Page>();
	let policy = memorySaverPolicy(undefined, undefined);
	let timer: Timer | undefined;
	let pending = 0;

	const due = (p: Page): number | null => (p.hiddenAt === null || p.consumed || p.revisits > MAX_REVISITS ? null : Math.max(p.hiddenAt + policy.idleMs, p.notBefore));

	function schedule() {
		if (timer !== undefined) sources.clearTimer(timer);
		timer = undefined;
		if (!policy.enabled || pending >= BATCH) return;
		let next: number | null = null;
		for (const p of pages.values()) {
			const at = due(p);
			if (at !== null && (next === null || at < next)) next = at;
		}
		if (next !== null) timer = sources.setTimer(pump, Math.max(0, next - sources.now()));
	}

	function pump() {
		timer = undefined;
		if (policy.enabled) {
			const now = sources.now();
			// Longest hidden first, a bounded batch: never a sweep of every tab at once.
			const ready = [...pages.entries()]
				.map(([id, p]) => ({ id, p, at: due(p) }))
				.filter((e): e is { id: string; p: Page; at: number } => e.at !== null && e.at <= now)
				.sort((a, b) => a.at - b.at);
			for (const { id, p } of ready) {
				if (pending >= BATCH) break;
				p.consumed = true;
				pending += 1;
				let freed = false;
				void p
					.free()
					.then((ok) => (freed = ok))
					.catch(() => {})
					.finally(() => {
						pending -= 1;
						// Still this hidden spell: a page that refused is asked again later.
						if (!freed && pages.get(id) === p && p.hiddenAt !== null) {
							p.consumed = false;
							p.notBefore = sources.now() + MEMORY_SAVER_RETRY_MS;
						}
						schedule();
					});
			}
		}
		schedule();
	}

	return {
		/** The tab is shown or hidden now (also its first report). `free` is the tab's latest. */
		report(id: string, visible: boolean, free: () => Promise<boolean>) {
			const prev = pages.get(id);
			if (prev && (prev.hiddenAt === null) === visible) {
				prev.free = free;
				return;
			}
			pages.set(id, {
				hiddenAt: visible ? null : sources.now(),
				notBefore: 0,
				revisits: (prev?.revisits ?? 0) + (prev && visible ? 1 : 0),
				consumed: false,
				free
			});
			schedule();
		},
		/** The tab closed. */
		close(id: string) {
			pages.delete(id);
			schedule();
		},
		/** A changed setting moves every waiting deadline at once; freed pages stay freed. */
		configure(next: MemorySaverPolicy) {
			if (next.enabled === policy.enabled && next.idleMs === policy.idleMs) return;
			policy = next;
			schedule();
		},
		/** Tabs waiting to be freed (hidden, not freed yet, not in constant use). */
		waiting(): number {
			let n = 0;
			for (const p of pages.values()) if (due(p) !== null) n += 1;
			return n;
		}
	};
}

const TICK_MS = 60_000;
let shared: ReturnType<typeof createMemorySaver> | undefined;

/** The app's one Memory Saver, on the awake clock. */
export function browserMemorySaver(): ReturnType<typeof createMemorySaver> {
	if (shared) return shared;
	const clock = createAwakeClock(() => Date.now(), 2 * TICK_MS);
	setInterval(clock.tick, TICK_MS);
	shared = createMemorySaver({ now: clock.now, setTimer: (run, ms) => setTimeout(run, ms), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) });
	return shared;
}
