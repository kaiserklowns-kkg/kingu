// Notification service (VS Code: INotificationService): toasts in the bottom-right corner and the
// notifications center behind the status bar bell. State and rules live in notificationsModel.ts.

import { SvelteSet } from 'svelte/reactivity';
import * as M from './notificationsModel';

export type { NotificationAction, NotificationInput, NotificationItem, Progress, Severity } from './notificationsModel';

const DND_KEY = 'kingu.notifications.doNotDisturb';

export type NotificationHandle = {
	readonly id: number;
	close(): void;
	update(patch: Partial<Pick<M.NotificationInput, 'message' | 'severity' | 'progress' | 'actions'>>): void;
};

/** What `withProgress` hands the task (VS Code's IProgress). */
export type ProgressReporter = { report(step: { message?: string; increment?: number }): void };

class Notifications {
	state = $state<M.NotificationsState>(M.createNotifications());
	/** Toasts under the mouse or holding focus: their timers wait (VS Code). */
	held = new SvelteSet<number>();
	#timer: ReturnType<typeof setInterval> | undefined;

	constructor() {
		try {
			this.state.doNotDisturb = localStorage.getItem(DND_KEY) === 'true';
		} catch {
			/* no storage (tests) */
		}
	}

	get items() {
		return this.state.items;
	}
	get toasts() {
		return M.visibleToasts(this.state);
	}
	get unread() {
		return M.unreadCount(this.state);
	}
	get doNotDisturb() {
		return this.state.doNotDisturb;
	}
	get centerVisible() {
		return this.state.centerVisible;
	}

	notify(input: M.NotificationInput): NotificationHandle {
		const item = M.addNotification(this.state, input, Date.now());
		this.#tick();
		const id = item.id;
		return {
			id,
			close: () => this.close(id),
			update: (patch) => {
				M.updateNotification(this.state, id, patch, Date.now());
				this.#tick();
			}
		};
	}

	info(message: string, opts: Omit<M.NotificationInput, 'severity' | 'message'> = {}) {
		return this.notify({ ...opts, severity: 'info', message });
	}
	warn(message: string, opts: Omit<M.NotificationInput, 'severity' | 'message'> = {}) {
		return this.notify({ ...opts, severity: 'warning', message });
	}
	error(message: string | unknown, opts: Omit<M.NotificationInput, 'severity' | 'message'> = {}) {
		return this.notify({ ...opts, severity: 'error', message: message instanceof Error ? message.message : String(message) });
	}

	/** VS Code's `prompt`: resolves with the chosen button's label, or undefined when closed. */
	prompt(severity: M.Severity, message: string, choices: string[], opts: { source?: string } = {}): Promise<string | undefined> {
		return new Promise((resolve) => {
			let done = false;
			const finish = (v: string | undefined) => {
				if (!done) (done = true), resolve(v);
			};
			const handle = this.notify({
				severity,
				message,
				source: opts.source,
				sticky: true,
				actions: choices.map((label) => ({ label, run: () => finish(label) }))
			});
			this.#onClose.set(handle.id, () => finish(undefined));
		});
	}

	/** VS Code's `withProgress({ location: Notification })`: a progress toast while `task` runs. */
	async withProgress<T>(opts: { title: string; source?: string; total?: number }, task: (progress: ProgressReporter) => Promise<T>): Promise<T> {
		let worked = 0;
		const progress: M.Progress = opts.total ? { total: opts.total, worked: 0 } : { infinite: true };
		const handle = this.notify({ severity: 'info', message: opts.title, source: opts.source, progress });
		try {
			return await task({
				report: ({ message, increment }) => {
					if (increment) worked += increment;
					handle.update({ message: message ? `${opts.title}: ${message}` : opts.title, progress: opts.total ? { total: opts.total, worked } : { infinite: true } });
				}
			});
		} finally {
			handle.close();
		}
	}

	#onClose = new Map<number, () => void>();

	close(id: number) {
		M.closeNotification(this.state, id);
		this.held.delete(id);
		this.#onClose.get(id)?.();
		this.#onClose.delete(id);
	}

	/** Runs a button and closes the notification, like VS Code. */
	runAction(id: number, action: M.NotificationAction) {
		void action.run();
		this.close(id);
	}

	/** The mouse or focus is on a toast: its timer waits, then starts over when released. */
	hold(id: number, on: boolean) {
		if (on) this.held.add(id);
		else {
			this.held.delete(id);
			const n = this.state.items.find((x) => x.id === id);
			if (n) n.shownAt = Date.now();
		}
	}

	hideToast(id: number) {
		M.hideToast(this.state, id);
	}

	clearAll() {
		for (const n of [...this.state.items]) this.close(n.id);
	}

	toggleExpanded(id: number) {
		const n = this.state.items.find((x) => x.id === id);
		if (n) n.expanded = !n.expanded;
	}

	setDoNotDisturb(on: boolean) {
		M.setDoNotDisturb(this.state, on);
		try {
			localStorage.setItem(DND_KEY, String(on));
		} catch {
			/* ignore */
		}
	}

	toggleCenter(show = !this.state.centerVisible) {
		M.setCenterVisible(this.state, show);
	}

	/** One timer while toasts are up; it hides the ones whose time ran out. */
	#tick() {
		if (this.#timer || typeof window === 'undefined') return;
		this.#timer = setInterval(() => {
			// VS Code waits while the window is in the background.
			if (typeof document !== 'undefined' && !document.hasFocus()) return;
			for (const id of M.expiredToasts(this.state, Date.now(), this.held)) M.hideToast(this.state, id);
			if (!M.visibleToasts(this.state).length) {
				clearInterval(this.#timer);
				this.#timer = undefined;
			}
		}, 500);
	}
}

export const notifications = new Notifications();
