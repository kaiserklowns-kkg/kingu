// Notification center (VS Code's notifications, Orca's toasts): errors and warnings show as a
// toast at the bottom right and stay listed behind the status bar's bell until cleared.
import { pushNotice, type Notice, type Severity } from './notifications';
import { playSignal } from './signals.svelte';

const TOAST_MS: Record<Severity, number> = { info: 6000, warning: 8000, error: 10000 };

class Notifications {
	list = $state<Notice[]>([]);
	toasts = $state<Notice[]>([]);
	unread = $state(0);
	/** Do Not Disturb: notices are still listed, but no toast pops up. */
	quiet = $state(false);
	#seq = 0;

	push(message: string, severity: Severity = 'info') {
		const next = pushNotice(this.list, { id: ++this.#seq, severity, message, at: Date.now(), count: 1 });
		this.list = next;
		this.unread++;
		if (severity === 'error') playSignal('error');
		if (this.quiet) return;
		const n = next[0];
		this.toasts = [...this.toasts.filter((t) => t.id !== n.id && t.message !== n.message), n].slice(-3);
		setTimeout(() => this.dismiss(n.id), TOAST_MS[severity]);
	}

	dismiss(id: number) {
		this.toasts = this.toasts.filter((t) => t.id !== id);
	}

	remove(id: number) {
		this.list = this.list.filter((n) => n.id !== id);
		this.dismiss(id);
	}

	clear() {
		this.list = [];
		this.toasts = [];
		this.unread = 0;
	}

	markRead() {
		this.unread = 0;
	}
}

export const notifications = new Notifications();
