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

/** One terminal rings at most this often (a shell beeps on every failed tab completion). */
export const BELL_THROTTLE_MS = 10_000;

/**
 * Orca's notifications.terminalBell (`kingu.agent.notifications.terminalBell`, default off): a
 * bell (BEL) from a terminal you are not looking at marks its tab and notifies, at most once per
 * BELL_THROTTLE_MS per terminal. `mark`: the tab's dot; `notify`: the system notification too.
 */
export function bellAction(enabled: boolean, visible: boolean, lastAt: number | undefined, now: number): { mark: boolean; notify: boolean } {
	if (!enabled || visible) return { mark: false, notify: false };
	return { mark: true, notify: lastAt === undefined || now - lastAt >= BELL_THROTTLE_MS };
}

/**
 * An agent chat's notice for one of its events (VS Code's chatWindowNotifier): a permission prompt,
 * a question or an MCP server's request needs you, a turn finished (left out with `events` = `attention`) or failed.
 */
export function chatNoticeFor(ev: { kind: string; tool?: string; is_error?: boolean }, title: string, events = 'all'): Notice | null {
	if (ev.kind === 'permission_request') {
		return ev.tool === 'AskUserQuestion'
			? { title: t('chat.notify.questionTitle', { title }), body: t('chat.notify.questionBody'), kind: 'attention' }
			: { title: t('chat.notify.approvalTitle', { title }), body: t('chat.notify.approvalBody'), kind: 'attention' };
	}
	// An MCP server's form or sampling request waits for the user like a question.
	if (ev.kind === 'mcp_request') return { title: t('chat.notify.questionTitle', { title }), body: t('chat.notify.questionBody'), kind: 'attention' };
	if (ev.kind !== 'result') return null;
	if (ev.is_error) return { title: t('chat.notify.failedTitle', { title }), body: t('chat.notify.failedBody'), kind: 'attention' };
	return events === 'attention' ? null : { title: t('chat.notify.finishedTitle', { title }), body: t('chat.notify.finishedBody'), kind: 'finished' };
}
