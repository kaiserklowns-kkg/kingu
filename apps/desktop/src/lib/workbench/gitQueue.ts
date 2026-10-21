// Git operations waiting behind another one in the same repository (Rust's git_queue emits
// `git-queue` when one starts and stops waiting). Pure bookkeeping, tested in gitQueue.test.ts.

export interface QueueEvent {
	repo: string;
	/** The operation that waits. */
	op: string;
	/** The operation it waits for. */
	running: string;
	waiting: boolean;
}

/** One entry per waiting operation (several of the same kind can wait at once). */
export type Waiters = readonly QueueEvent[];

/** `waiters` after `e`: a start adds it, a stop removes one matching wait. */
export function applyQueueEvent(waiters: Waiters, e: QueueEvent): QueueEvent[] {
	if (e.waiting) return [...waiters, e];
	const i = waiters.findIndex((w) => w.repo === e.repo && w.op === e.op);
	return i < 0 ? [...waiters] : [...waiters.slice(0, i), ...waiters.slice(i + 1)];
}

/** What the status bar names: the first waiter and what it waits for; `null` when none waits. */
export function firstWaiter(waiters: Waiters): { op: string; running: string; count: number } | null {
	const w = waiters[0];
	return w ? { op: w.op, running: w.running, count: waiters.length } : null;
}
