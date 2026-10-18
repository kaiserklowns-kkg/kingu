// Notifications (VS Code: workbench/common/notifications.ts NotificationsModel and
// browser/parts/notifications/notificationsToasts.ts). Pure functions over a plain object, so the
// runes wrapper (notifications.svelte.ts) keeps it in `$state` and tests drive it with a fake clock.
//
// VS Code's rules: newest first; an identical notification replaces the older one; at most 3
// toasts; toasts hide after 10/12/15 s (info/warning/error) unless sticky or hovered; an error
// with buttons, an expanded one without buttons, and one with running progress are sticky; Do Not
// Disturb keeps every non-error notification out of the toasts (it still lands in the center).

export type Severity = 'info' | 'warning' | 'error';
export type NotificationAction = { label: string; run: () => unknown };
export type Progress = { infinite?: boolean; total?: number; worked?: number; done?: boolean };

export type NotificationInput = {
	severity: Severity;
	message: string;
	/** Who said it (a language server, Git…), shown under the message. */
	source?: string;
	/** Buttons, the first one primary (VS Code's `actions.primary`). */
	actions?: NotificationAction[];
	progress?: Progress;
	sticky?: boolean;
	/** VS Code's NotificationPriority.SILENT: straight to the center, never a toast. */
	silent?: boolean;
};

export type NotificationItem = NotificationInput & {
	id: number;
	actions: NotificationAction[];
	expanded: boolean;
	/** Shown as a toast now. */
	toast: boolean;
	/** When the toast's hide timer started (ms). */
	shownAt: number;
	/** Not yet seen in the center (drives the bell's dot). */
	unread: boolean;
};

export type NotificationsState = { items: NotificationItem[]; nextId: number; doNotDisturb: boolean; centerVisible: boolean };

export const MAX_TOASTS = 3;
export const PURGE_TIMEOUT: Record<Severity, number> = { info: 10000, warning: 12000, error: 15000 };

export function createNotifications(): NotificationsState {
	return { items: [], nextId: 1, doNotDisturb: false, centerVisible: false };
}

export function isSticky(n: Pick<NotificationItem, 'sticky' | 'severity' | 'actions' | 'expanded' | 'progress'>): boolean {
	if (n.sticky) return true;
	const hasActions = n.actions.length > 0;
	return (hasActions && n.severity === 'error') || (!hasActions && n.expanded) || (!!n.progress && !n.progress.done);
}

const sameContent = (a: NotificationInput, b: NotificationInput) => a.severity === b.severity && a.message === b.message && a.source === b.source && !a.progress && !b.progress;

/** Adds a notification on top; returns it. */
export function addNotification(s: NotificationsState, input: NotificationInput, now: number): NotificationItem {
	s.items = s.items.filter((n) => !sameContent(n, input));
	const quiet = input.silent || (s.doNotDisturb && input.severity !== 'error');
	const item: NotificationItem = {
		...input,
		actions: input.actions ?? [],
		id: s.nextId++,
		expanded: false,
		toast: !quiet && !s.centerVisible,
		shownAt: now,
		unread: !s.centerVisible
	};
	s.items.unshift(item);
	return item;
}

export function closeNotification(s: NotificationsState, id: number) {
	s.items = s.items.filter((n) => n.id !== id);
}

export function clearAll(s: NotificationsState) {
	s.items = [];
}

export function hideToast(s: NotificationsState, id: number) {
	const n = s.items.find((x) => x.id === id);
	if (n) n.toast = false;
}

export function hideAllToasts(s: NotificationsState) {
	for (const n of s.items) n.toast = false;
}

/** The toasts on screen: the newest MAX_TOASTS that want one, oldest first (newest at the bottom). */
export function visibleToasts(s: NotificationsState): NotificationItem[] {
	return s.items.filter((n) => n.toast).slice(0, MAX_TOASTS).reverse();
}

/** Ids of toasts whose time is up at `now`. `held` are hovered or focused toasts, which stay. */
export function expiredToasts(s: NotificationsState, now: number, held: ReadonlySet<number> = new Set()): number[] {
	return visibleToasts(s)
		.filter((n) => !isSticky(n) && !held.has(n.id) && now - n.shownAt >= PURGE_TIMEOUT[n.severity])
		.map((n) => n.id);
}

export function setDoNotDisturb(s: NotificationsState, on: boolean) {
	s.doNotDisturb = on;
	if (on) for (const n of s.items) if (n.severity !== 'error') n.toast = false;
}

/** Opening the center hides the toasts and marks everything read. */
export function setCenterVisible(s: NotificationsState, visible: boolean) {
	s.centerVisible = visible;
	if (visible) {
		hideAllToasts(s);
		for (const n of s.items) n.unread = false;
	}
}

export function unreadCount(s: NotificationsState): number {
	return s.items.filter((n) => n.unread).length;
}

/** Changes an existing notification in place (progress, message); restarts its toast timer. */
export function updateNotification(s: NotificationsState, id: number, patch: Partial<Pick<NotificationInput, 'message' | 'severity' | 'progress' | 'actions'>>, now: number) {
	const n = s.items.find((x) => x.id === id);
	if (!n) return;
	Object.assign(n, patch);
	n.shownAt = now;
}

/** Progress as a 0–100 percentage, or null for an infinite (indeterminate) bar. */
export function progressPercent(p: Progress | undefined): number | null {
	if (!p || p.infinite || !p.total) return null;
	return Math.max(0, Math.min(100, ((p.worked ?? 0) / p.total) * 100));
}
