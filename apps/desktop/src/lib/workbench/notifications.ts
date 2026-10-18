// Pure helpers for the notification center (see notifications.svelte.ts).

export type Severity = 'info' | 'warning' | 'error';
export type Notice = { id: number; severity: Severity; message: string; at: number; count: number };

export const NOTICE_LIMIT = 50;

/** Newest first; the same message again bumps the newest notice's count instead of a duplicate. */
export function pushNotice(list: Notice[], notice: Notice, limit = NOTICE_LIMIT): Notice[] {
	const head = list[0];
	if (head && head.message === notice.message && head.severity === notice.severity) {
		return [{ ...head, at: notice.at, count: head.count + 1 }, ...list.slice(1)];
	}
	return [notice, ...list].slice(0, limit);
}
