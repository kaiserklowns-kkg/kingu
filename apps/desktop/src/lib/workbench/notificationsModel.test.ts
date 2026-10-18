/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
	addNotification,
	closeNotification,
	createNotifications,
	expiredToasts,
	isSticky,
	MAX_TOASTS,
	progressPercent,
	PURGE_TIMEOUT,
	setCenterVisible,
	setDoNotDisturb,
	unreadCount,
	updateNotification,
	visibleToasts
} from './notificationsModel';

const noop = () => {};

describe('notification queue (VS Code NotificationsModel / NotificationsToasts)', () => {
	test('newest first; identical notifications collapse into the newest', () => {
		const s = createNotifications();
		addNotification(s, { severity: 'info', message: 'a' }, 0);
		addNotification(s, { severity: 'error', message: 'b' }, 1);
		addNotification(s, { severity: 'info', message: 'a' }, 2);
		expect(s.items.map((n) => n.message)).toEqual(['a', 'b']);
		// Same text from another source is a different notification.
		addNotification(s, { severity: 'info', message: 'a', source: 'gopls' }, 3);
		expect(s.items).toHaveLength(3);
	});

	test('at most three toasts, oldest on top; closing one shows the next', () => {
		const s = createNotifications();
		for (const m of ['1', '2', '3', '4']) addNotification(s, { severity: 'info', message: m }, 0);
		expect(visibleToasts(s).map((n) => n.message)).toEqual(['2', '3', '4']);
		expect(MAX_TOASTS).toBe(3);
		closeNotification(s, s.items[0].id);
		expect(visibleToasts(s).map((n) => n.message)).toEqual(['1', '2', '3']);
	});

	test('toasts time out by severity unless sticky or held', () => {
		const s = createNotifications();
		const info = addNotification(s, { severity: 'info', message: 'i' }, 0);
		const err = addNotification(s, { severity: 'error', message: 'e' }, 0);
		const held = addNotification(s, { severity: 'warning', message: 'w' }, 0);
		expect(expiredToasts(s, PURGE_TIMEOUT.info - 1)).toEqual([]);
		expect(expiredToasts(s, PURGE_TIMEOUT.info)).toEqual([info.id]);
		expect(expiredToasts(s, PURGE_TIMEOUT.error, new Set([held.id])).sort()).toEqual([info.id, err.id].sort());
		const withButton = addNotification(s, { severity: 'error', message: 'x', actions: [{ label: 'Retry', run: noop }] }, 0);
		expect(isSticky(withButton)).toBe(true);
		expect(expiredToasts(s, 60_000)).not.toContain(withButton.id);
	});

	test('progress keeps a toast up until done', () => {
		const s = createNotifications();
		const n = addNotification(s, { severity: 'info', message: 'Indexing', progress: { infinite: true } }, 0);
		expect(isSticky(n)).toBe(true);
		expect(progressPercent(n.progress)).toBeNull();
		updateNotification(s, n.id, { progress: { total: 4, worked: 1 } }, 100);
		expect(progressPercent(s.items[0].progress)).toBe(25);
		updateNotification(s, n.id, { progress: { total: 4, worked: 4, done: true } }, 200);
		expect(isSticky(s.items[0])).toBe(false);
		expect(expiredToasts(s, 200 + PURGE_TIMEOUT.info)).toEqual([n.id]);
	});

	test('Do Not Disturb keeps everything but errors out of the toasts', () => {
		const s = createNotifications();
		const before = addNotification(s, { severity: 'warning', message: 'w' }, 0);
		setDoNotDisturb(s, true);
		expect(s.items.find((n) => n.id === before.id)!.toast).toBe(false);
		addNotification(s, { severity: 'info', message: 'quiet' }, 0);
		addNotification(s, { severity: 'error', message: 'loud' }, 0);
		expect(visibleToasts(s).map((n) => n.message)).toEqual(['loud']);
		expect(s.items).toHaveLength(3);
		addNotification(s, { severity: 'error', message: 'silent', silent: true }, 0);
		expect(visibleToasts(s).map((n) => n.message)).toEqual(['loud']);
	});

	test('opening the center hides toasts and marks all read', () => {
		const s = createNotifications();
		addNotification(s, { severity: 'info', message: 'a' }, 0);
		addNotification(s, { severity: 'info', message: 'b' }, 0);
		expect(unreadCount(s)).toBe(2);
		setCenterVisible(s, true);
		expect(unreadCount(s)).toBe(0);
		expect(visibleToasts(s)).toEqual([]);
		// While the center is open new ones land there, not as toasts.
		addNotification(s, { severity: 'error', message: 'c' }, 0);
		expect(visibleToasts(s)).toEqual([]);
		expect(unreadCount(s)).toBe(0);
	});
});
