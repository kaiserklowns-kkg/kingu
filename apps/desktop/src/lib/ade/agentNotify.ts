// When to tell the user about an agent while they look elsewhere (Orca's notifications): it needs a
// permission answer, finished a turn and waits for review, or failed. Pure, so `bun test` covers it.

import type { TaskStatus } from './model';
import { t } from '#lib/i18n/index.ts';

export type Notice = { title: string; body: string; kind: 'attention' | 'finished' };

/** A task's status for notifications: a waiting agent that asks you a question is told apart. */
export type NoticeState = TaskStatus | 'question';
export const noticeState = (status: TaskStatus, question?: boolean): NoticeState => (status === 'waiting' && question ? 'question' : status);

/** `kingu.agent.notifications.events`: `attention` leaves out finished turns. */
export function noticeFor(prev: NoticeState | undefined, next: NoticeState, task: { title: string; lastEvent?: string }, events = 'all'): Notice | null {
	if (prev === undefined || prev === next) return null;
	if (next === 'question') return { title: t('ade.notify.questionTitle', { task: task.title }), body: task.lastEvent || t('ade.notify.questionBody'), kind: 'attention' };
	if (next === 'waiting') return { title: t('ade.notify.permissionTitle', { task: task.title }), body: task.lastEvent || t('ade.notify.permissionBody'), kind: 'attention' };
	if (next === 'failed') return { title: t('ade.notify.failedTitle', { task: task.title }), body: task.lastEvent || t('ade.notify.failedBody'), kind: 'attention' };
	if ((prev === 'running' || prev === 'question') && next === 'review' && events !== 'attention') return { title: t('ade.notify.finishedTitle', { task: task.title }), body: task.lastEvent || t('ade.notify.finishedBody'), kind: 'finished' };
	return null;
}

export type NotifySettings = { enabled: boolean; suppressWhenFocused: boolean };

/**
 * Whether a task's notice is shown: never with notifications off; with Suppress While Focused (Orca's
 * default) not for the task on screen while the window is focused, otherwise always.
 */
export function shouldNotify(s: NotifySettings, focused: boolean, viewing: boolean): boolean {
	if (!s.enabled) return false;
	return !(s.suppressWhenFocused && focused && viewing);
}

/** `kingu.agent.notifications.sound` → the notification's sound name (macOS), or none. */
export function notificationSound(setting: string | undefined): string | undefined {
	if (!setting || setting === 'none') return undefined;
	// mac-notification-sys plays the system default for this name.
	return setting === 'default' ? 'NSUserNotificationDefaultSoundName' : setting;
}
