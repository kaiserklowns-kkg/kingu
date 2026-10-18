// Status bar state for git operations queued behind another one in the same repository
// (IDE Source Control and ADE task actions share Rust's per-repository queue; see gitQueue.ts).

import { listen } from '@tauri-apps/api/event';
import { applyQueueEvent, firstWaiter, type QueueEvent } from './gitQueue';

class GitQueue {
	waiters = $state<QueueEvent[]>([]);
	first = $derived(firstWaiter(this.waiters));

	/** Listens for `git-queue`; returns the unlisten. */
	install(): () => void {
		const off = listen<QueueEvent>('git-queue', (e) => (this.waiters = applyQueueEvent(this.waiters, e.payload)));
		return () => void off.then((f) => f());
	}
}

export const gitQueue = new GitQueue();
