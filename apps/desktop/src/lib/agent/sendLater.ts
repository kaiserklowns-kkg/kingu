// Send Later (VS Code 1.147): a message scheduled to go to a chat at a chosen time. Mirrors
//   src/vs/workbench/contrib/sessions/browser/scheduledChatTimePicker.ts   the time picker's choices
//   src/vs/workbench/contrib/sessions/common/scheduledChatRequest.ts      parseScheduledChatTime; context captured now
//   src/vs/workbench/contrib/chat/browser/widget/chatScheduledRequestTime.ts  "Sends in …" / "Today at …"
// VS Code hands the request to the agent host's Automations; Kingu keeps it in this machine's
// localStorage and the panel's scheduler (sendLater.svelte.ts) sends it into the chat when due
// (queued after a running turn, as a request typed then would be).
// Kingu-only: `/later <when> <message>` schedules from the input in a few words (parseLaterCommand).
// Pure, so `bun test` covers it.

import type { OutgoingMessage } from './chats.svelte.ts';

export type ScheduledMessage = {
	id: string;
	/** The folder the chat belongs to (chats are per folder). */
	root: string;
	chatId: string;
	/** What was typed (the row's text, and what Edit puts back in the input). */
	label: string;
	/** The request as it goes: its attached context read when it was scheduled (VS Code captures it then too). */
	message: OutgoingMessage;
	/** When it is sent (ms since the epoch). */
	runAt: number;
	createdAt: number;
	/** It came due and could not be sent: it waits for Send Now or Reschedule instead of being retried. */
	failed?: boolean;
};

const MINUTE = 60_000;
/** Older than this past due and never sent (the folder was never opened again): dropped. */
const STALE_MS = 30 * 24 * 60 * MINUTE;

/** The picker's choices, VS Code's order: In 5 / 10 / 15 / 30 Minutes, In 1 Hour, In 24 Hours, Tomorrow Morning (9:00). */
export type LaterPreset = { id: 'm5' | 'm10' | 'm15' | 'm30' | 'h1' | 'h24' | 'tomorrow'; at: number };

export function laterPresets(now: Date): LaterPreset[] {
	const mins: [LaterPreset['id'], number][] = [
		['m5', 5],
		['m10', 10],
		['m15', 15],
		['m30', 30],
		['h1', 60],
		['h24', 24 * 60]
	];
	return [...mins.map(([id, m]) => ({ id, at: now.getTime() + m * MINUTE })), { id: 'tomorrow', at: tomorrowMorning(now) }];
}

/** 9:00 tomorrow, this device's time. */
export function tomorrowMorning(now: Date): number {
	const d = new Date(now);
	d.setDate(d.getDate() + 1);
	d.setHours(9, 0, 0, 0);
	return d.getTime();
}

/** `YYYY-MM-DDTHH:MM` (a datetime-local input) as this device's time; undefined for an invalid or DST-skipped time (VS Code's parseScheduledChatTime). */
export function parseLocalDateTime(value: string): Date | undefined {
	const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(value.trim());
	if (!m) return undefined;
	const [y, mo, d, h, mi] = m.slice(1).map(Number);
	const date = new Date(y, mo - 1, d, h, mi);
	return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d && date.getHours() === h && date.getMinutes() === mi ? date : undefined;
}

/** A Date as a datetime-local input's value. */
export function toLocalDateTime(at: number): string {
	const d = new Date(at);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The row's relative time (VS Code's getScheduledRequestTimeLabel): due, under a minute, or the whole minutes / hours / days left. */
export type RelativeLater = { kind: 'due' } | { kind: 'soon' } | { kind: 'minutes' | 'hours' | 'days'; n: number };

export function relativeLater(runAt: number, now: number): RelativeLater {
	const left = runAt - now;
	if (left <= 0) return { kind: 'due' };
	if (left < MINUTE) return { kind: 'soon' };
	const minutes = Math.floor(left / MINUTE);
	if (minutes < 60) return { kind: 'minutes', n: minutes };
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? { kind: 'hours', n: hours } : { kind: 'days', n: Math.floor(hours / 24) };
}

/** The row's exact time (VS Code's getScheduledRequestAbsoluteTimeLabel): today, tomorrow, a weekday this week, else the date. */
export type AbsoluteLater = { kind: 'today'; clock: string } | { kind: 'tomorrow'; clock: string } | { kind: 'weekday'; day: string; clock: string } | { kind: 'date'; day: string; clock: string };

export function absoluteLater(runAt: number, now: number, locale?: string): AbsoluteLater {
	const date = new Date(runAt);
	const today = new Date(now);
	const days = Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86_400_000);
	const clock = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
	if (days === 0) return { kind: 'today', clock };
	if (days === 1) return { kind: 'tomorrow', clock };
	if (days > 1 && days < 7) return { kind: 'weekday', day: date.toLocaleDateString(locale, { weekday: 'short' }), clock };
	const day = date.toLocaleDateString(locale, date.getFullYear() === today.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
	return { kind: 'date', day, clock };
}

/** The stored list, well-formed entries only, those long past due dropped. */
export function parseScheduled(raw: string | null, now: number): ScheduledMessage[] {
	let v: unknown;
	try {
		v = raw ? JSON.parse(raw) : null;
	} catch {
		return [];
	}
	if (!Array.isArray(v)) return [];
	const str = (x: unknown): x is string => typeof x === 'string';
	return v.filter((e): e is ScheduledMessage => {
		const s = e as ScheduledMessage | null;
		return (
			!!s &&
			str(s.id) &&
			str(s.root) &&
			str(s.chatId) &&
			str(s.label) &&
			Number.isFinite(s.runAt) &&
			Number.isFinite(s.createdAt) &&
			!!s.message &&
			str(s.message.text) &&
			!!s.message.text.trim() &&
			Array.isArray(s.message.images) &&
			s.message.images.every(str) &&
			now - s.runAt < STALE_MS
		);
	});
}

/** The scheduled messages due by `now` in folder `root`, oldest first. */
export function dueMessages(items: readonly ScheduledMessage[], root: string | null, now: number): ScheduledMessage[] {
	return items.filter((s) => s.root === root && s.runAt <= now && !s.failed).sort((a, b) => a.runAt - b.runAt || a.createdAt - b.createdAt);
}

/** Chat `chatId`'s scheduled messages in `root`, soonest first. */
export function chatScheduled(items: readonly ScheduledMessage[], root: string | null, chatId: string | null): ScheduledMessage[] {
	return items.filter((s) => s.root === root && s.chatId === chatId).sort((a, b) => a.runAt - b.runAt || a.createdAt - b.createdAt);
}

/**
 * Kingu-only: a `/later` time in a few words, as this device's time:
 *   `10m` `90 min` `2h` `1h30m` `1d`   from now
 *   `14:30` `2:30pm` `9am`             today, or tomorrow once that time has passed
 *   `tomorrow` (9:00) `tomorrow 14:00`
 * null when the words are not a time.
 */
export function parseLaterTime(spec: string, now: Date): number | null {
	const s = spec.trim().toLowerCase();
	const span = /^(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?$/.exec(s);
	if (span && (span[1] || span[2] || span[3])) {
		const minutes = Number(span[1] ?? 0) * 1440 + Number(span[2] ?? 0) * 60 + Number(span[3] ?? 0);
		return minutes > 0 ? now.getTime() + minutes * MINUTE : null;
	}
	const tomorrow = /^tomorrow(?:\s+(.+))?$/.exec(s);
	if (tomorrow) {
		if (!tomorrow[1]) return tomorrowMorning(now);
		const clock = parseClock(tomorrow[1]);
		if (!clock) return null;
		const d = new Date(now);
		d.setDate(d.getDate() + 1);
		d.setHours(clock.h, clock.m, 0, 0);
		return d.getTime();
	}
	const clock = parseClock(s);
	if (!clock) return null;
	const d = new Date(now);
	d.setHours(clock.h, clock.m, 0, 0);
	if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
	return d.getTime();
}

/** `14:30`, `2:30pm`, `9am`, `9 pm` → hours and minutes; null otherwise. */
function parseClock(s: string): { h: number; m: number } | null {
	const c = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s.trim());
	if (!c || (!c[2] && !c[3])) return null;
	let h = Number(c[1]);
	const m = Number(c[2] ?? 0);
	if (m > 59) return null;
	if (c[3]) {
		if (h < 1 || h > 12) return null;
		h = (h % 12) + (c[3] === 'pm' ? 12 : 0);
	} else if (h > 23) return null;
	return { h, m };
}

/**
 * Kingu-only: `/later <when> <message>`. The time is the longest leading run of words that reads
 * as one (so `/later 1h 30m check` and `/later tomorrow 9am check` both work).
 * null when the input is not `/later`; `{ error }` when its time or message is missing.
 */
export function parseLaterCommand(text: string, now: Date): { at: number; message: string } | { error: 'time' | 'message' } | null {
	const m = /^\/later(?:\s+([\s\S]*))?$/i.exec(text.trim());
	if (!m) return null;
	const words = (m[1] ?? '').trim().split(/[ \t]+/);
	for (let n = Math.min(3, words.length); n > 0; n--) {
		const at = parseLaterTime(words.slice(0, n).join(' '), now);
		if (at === null) continue;
		const message = (m[1] ?? '').trim().replace(new RegExp(`^${words.slice(0, n).map(escape).join('[ \\t]+')}`), '').trim();
		return message ? { at, message } : { error: 'message' };
	}
	return { error: 'time' };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
