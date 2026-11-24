// Continue after a usage limit (Orca 1.4.271): when a chat's turn stops on the agent's usage
// limit, the chat says which limit and when it resets, offers Continue, and continues by itself at
// the reset (`kingu.chat.autoContinueAfterUsageLimit`, on by default like Orca's
// nativeChatAutoContinueAfterUsageLimit). Pure, so `bun test` covers it.
//
// Ported from Orca:
//   src/main/claude/structured/journal/claude-limit-line.ts       (Claude's limit line)
//   src/main/claude/structured/journal/claude-usage-limits.ts     (pooled 429, rate_limit_event)
//   src/main/codex/structured/catalog/codex-usage-limits.ts       ("try again at 3:05 PM.")
//   src/shared/agent-session/failures/agent-session-usage-limit.ts (resets within a month)
//   src/shared/native-chat/transcript/continuation/native-chat-usage-limit-cut.ts (the message,
//     the one-day overdue rule)

import type { AgentEvent, TimelineEvent } from './events';

/** `session`: the rolling few-hour limit · `weekly` · `weeklyModel`: one model's weekly limit · `credits`: extra usage. */
export type UsageLimitWindow = 'session' | 'weekly' | 'weeklyModel' | 'credits';
export const USAGE_LIMIT_WINDOWS: readonly UsageLimitWindow[] = ['session', 'weekly', 'weeklyModel', 'credits'];

export type UsageLimit = { window?: UsageLimitWindow; resetsAt?: number };

/** What chats.json keeps (Rust `chats::UsageLimitCut`): when the turn stopped, and the limit. */
export type UsageLimitCut = { at: number; resets_at?: number | null; window?: UsageLimitWindow | null; auto_off?: boolean };

/** What the agent is sent to continue (Orca's NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE, word for word). */
export const CONTINUE_MESSAGE = 'Continue where you left off.';

/** How long after its reset a cut is still continued automatically; older ones stay manual (Orca). */
export const MAX_OVERDUE_MS = 24 * 60 * 60 * 1000;
/** Past this, a reset is not one a person waits for, so it is left out (Orca). */
const MAX_RESET_WAIT_MS = 31 * 24 * 60 * 60 * 1000;

/** A reset worth saying, as epoch ms: finite, positive and within a month of `now`. */
export function usageLimitResetsAt(value: unknown, now: number): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 && value - now <= MAX_RESET_WAIT_MS ? Math.round(value) : undefined;
}

// --- Claude Code's own limit line -----------------------------------------------------------

const LEGACY_LIMIT = /^Claude AI usage limit reached\|(\d{9,11})\s*$/i;
const HIT_LIMIT = /^You(?:'|’)ve hit your (?:[\w-]+ )*limit\b/i;
const RESET = /\bresets (?:([A-Z][a-z]{2}) (\d{1,2}), (?:(\d{4}), )?)?(\d{1,2})(?::(\d{2}))? ?(am|pm)\b(?: \(([^)]+)\))?/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_MS = 24 * 60 * 60 * 1000;

type WallClock = { year: number; month: number; day: number; hour: number; minute: number };

/** The wall clock in `zone` (undefined: this machine's) at `epoch`; undefined for an unknown zone. */
function zonedDate(epoch: number, zone: string | undefined): WallClock | undefined {
	try {
		const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(epoch);
		const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
		return { year: part('year'), month: part('month') - 1, day: part('day'), hour: part('hour'), minute: part('minute') };
	} catch {
		return undefined;
	}
}

/** The epoch whose wall clock in `zone` is `clock`, corrected twice for the zone's offset there. */
function zonedEpoch(clock: WallClock, zone: string | undefined): number | undefined {
	const target = Date.UTC(clock.year, clock.month, clock.day, clock.hour, clock.minute);
	let epoch = target;
	for (let pass = 0; pass < 2; pass++) {
		const seen = zonedDate(epoch, zone);
		if (!seen) return undefined;
		epoch += target - Date.UTC(seen.year, seen.month, seen.day, seen.hour, seen.minute);
	}
	return epoch;
}

function claudeResetAt(text: string, now: number): number | undefined {
	const m = RESET.exec(text);
	if (!m) return undefined;
	const [, monthName, dayText, yearText, hourText, minuteText, meridiem, zone] = m;
	const hour = (Number(hourText) % 12) + (meridiem?.toLowerCase() === 'pm' ? 12 : 0);
	const minute = minuteText ? Number(minuteText) : 0;
	if (hour > 23 || minute > 59) return undefined;
	const today = zonedDate(now, zone);
	if (!today) return undefined;
	if (!monthName) {
		// A time alone: its next occurrence.
		const at = zonedEpoch({ ...today, hour, minute }, zone);
		if (at === undefined) return undefined;
		if (at > now) return at;
		const next = new Date(Date.UTC(today.year, today.month, today.day) + DAY_MS);
		return zonedEpoch({ year: next.getUTCFullYear(), month: next.getUTCMonth(), day: next.getUTCDate(), hour, minute }, zone);
	}
	const month = MONTHS.indexOf(monthName.toLowerCase());
	if (month < 0) return undefined;
	return zonedEpoch({ year: yearText ? Number(yearText) : today.year, month, day: Number(dayText), hour, minute }, zone);
}

/** Claude Code's limit line ("Claude AI usage limit reached|<s>", "You've hit your session limit · resets 3pm (Zone)"); null for other text. */
export function claudeLimitLine(text: string, now: number): UsageLimit | null {
	const trimmed = text.trim();
	const legacy = LEGACY_LIMIT.exec(trimmed)?.[1];
	if (legacy) {
		const resetsAt = usageLimitResetsAt(Number(legacy) * 1000, now);
		return resetsAt ? { resetsAt } : {};
	}
	const hit = HIT_LIMIT.exec(trimmed)?.[0].toLowerCase();
	if (!hit) return null;
	const window: UsageLimitWindow | undefined = / session /.test(hit) ? 'session' : / weekly /.test(hit) ? 'weekly' : undefined;
	const resetsAt = usageLimitResetsAt(claudeResetAt(trimmed, now), now);
	return { ...(window ? { window } : {}), ...(resetsAt ? { resetsAt } : {}) };
}

const POOLED_LIMIT = /all available accounts have exhausted a shared session or weekly usage limit/i;
const POOLED_RESET = /earliest reset at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)/i;

/** A pool of Claude accounts that are all spent (a 429 in prose). */
export function pooledLimit(text: string, now: number): UsageLimit | null {
	if (!POOLED_LIMIT.test(text)) return null;
	const at = POOLED_RESET.exec(text)?.[1];
	const resetsAt = at ? usageLimitResetsAt(Date.parse(at), now) : undefined;
	return resetsAt ? { resetsAt } : {};
}

// --- Codex ----------------------------------------------------------------------------------

const CODEX_LIMIT = /\byou(?:'|’)ve hit your usage limit\b|\busage limit (?:reached|exceeded)\b/i;
const TRY_AGAIN_AT = /\btry again at (?:([a-z]{3}) (\d{1,2})(?:st|nd|rd|th), (\d{4}) )?(\d{1,2}):(\d{2}) ([ap]m)\./i;

/** The reset Codex's error names ("try again at 3:05 PM." or "…at Jan 2nd, 2027 3:05 PM."), in this machine's time. */
export function codexResetFromText(text: string, now: number): number | undefined {
	const m = TRY_AGAIN_AT.exec(text);
	if (!m) return undefined;
	const [, monthName, dayText, yearText, hourText, minuteText, meridiem] = m;
	const hour = Number(hourText);
	const minute = Number(minuteText);
	if (hour < 1 || hour > 12 || minute > 59) return undefined;
	const today = new Date(now);
	const month = monthName ? MONTHS.indexOf(monthName.toLowerCase()) : today.getMonth();
	const day = dayText ? Number(dayText) : today.getDate();
	const year = yearText ? Number(yearText) : today.getFullYear();
	const at = new Date(year, month, day, (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0), minute);
	if (month < 0 || at.getMonth() !== month || at.getDate() !== day) return undefined;
	// The text drops seconds: the end of its minute is never before the real reset.
	const reset = at.getTime() + 60_000;
	return reset > now ? usageLimitResetsAt(reset, now) : undefined;
}

// --- Any agent --------------------------------------------------------------------------------

/** Other agents' quota errors (Gemini's RESOURCE_EXHAUSTED, "quota exceeded"): a limit with no reset. */
const OTHER_LIMIT = /\bquota exceeded\b|\bresource[_ ]exhausted\b|\bexceeded your current quota\b/i;

/** The usage limit an agent's error text names; null when it names none. */
export function usageLimitOfText(text: string, now: number): UsageLimit | null {
	const line = claudeLimitLine(text, now) ?? pooledLimit(text, now);
	if (line) {
		// Codex's "You've hit your usage limit… try again at 3:05 PM." reads as Claude's line too.
		const resetsAt = line.resetsAt ?? codexResetFromText(text, now);
		return resetsAt ? { ...line, resetsAt } : line;
	}
	if (CODEX_LIMIT.test(text)) {
		const resetsAt = codexResetFromText(text, now);
		return resetsAt ? { resetsAt } : {};
	}
	return OTHER_LIMIT.test(text) ? {} : null;
}

const CLAUDE_WINDOWS: Record<string, UsageLimitWindow> = {
	five_hour: 'session',
	seven_day: 'weekly',
	seven_day_opus: 'weeklyModel',
	seven_day_sonnet: 'weeklyModel',
	overage: 'credits'
};

/** A `raw` line holding Claude Code's `rate_limit_event` that rejected requests (no overage in use): its window and reset. */
export function rejectedRateLimit(line: string, now: number): UsageLimit | null {
	let msg: unknown;
	try {
		msg = JSON.parse(line);
	} catch {
		return null;
	}
	if (!msg || typeof msg !== 'object' || (msg as { type?: unknown }).type !== 'rate_limit_event') return null;
	const info = (msg as { rate_limit_info?: Record<string, unknown> }).rate_limit_info;
	if (!info || info.status !== 'rejected') return null;
	if (info.overageStatus === 'allowed' || info.overageStatus === 'allowed_warning' || info.isUsingOverage === true) return null;
	const window = typeof info.rateLimitType === 'string' ? CLAUDE_WINDOWS[info.rateLimitType] : undefined;
	const resetsAt = typeof info.resetsAt === 'number' ? usageLimitResetsAt(info.resetsAt * 1000, now) : undefined;
	return { ...(window ? { window } : {}), ...(resetsAt ? { resetsAt } : {}) };
}

/**
 * The usage limit the chat's latest turn stopped on, or null: that turn (after the last user
 * message) failed — an error result, an error, or a failed exit — and its words name a limit.
 * `rejected`: a `rate_limit_event` rejection the run saw, for the window and reset the words lack.
 */
export function turnUsageLimit(items: readonly (TimelineEvent | AgentEvent)[], now: number, rejected: UsageLimit | null = null): UsageLimit | null {
	let start = 0;
	for (let i = items.length - 1; i >= 0; i--) {
		const ev = items[i];
		if (ev.kind === 'message' && ev.role === 'user' && !ev.parent_tool_use_id) {
			start = i + 1;
			break;
		}
	}
	const texts: string[] = [];
	let failed = false;
	for (const ev of items.slice(start)) {
		if (ev.kind === 'result' && ev.is_error) {
			failed = true;
			if (ev.result) texts.push(ev.result);
		} else if (ev.kind === 'error') {
			failed = true;
			texts.push(ev.message);
		} else if (ev.kind === 'exit' && !ev.stopped && (ev.code ?? 0) !== 0) failed = true;
		else if (ev.kind === 'message' && ev.role === 'assistant' && !ev.parent_tool_use_id) texts.push(ev.text);
		else if (ev.kind === 'result' && !ev.is_error) return null;
	}
	if (!failed) return null;
	let found: UsageLimit | null = null;
	for (const text of texts.reverse()) {
		found = usageLimitOfText(text, now);
		if (found) break;
	}
	if (!found) return null;
	return { ...(rejected?.window ? { window: rejected.window } : {}), ...(rejected?.resetsAt ? { resetsAt: rejected.resetsAt } : {}), ...found };
}

/** The cut chats.json keeps for a limit found at `at`. */
export function cutOf(limit: UsageLimit, at: number): UsageLimitCut {
	return { at, resets_at: limit.resetsAt ?? null, window: limit.window ?? null };
}

/** When Kingu continues the cut by itself: a known reset after the turn ended, at most a day ago, not cancelled. */
export function autoContinueAt(cut: UsageLimitCut | null | undefined, now: number): number | null {
	const at = cut?.resets_at;
	if (!cut || cut.auto_off || typeof at !== 'number' || !Number.isFinite(at) || at <= cut.at || now - at > MAX_OVERDUE_MS) return null;
	return at;
}

/** The chat to continue next and when, among `chats` (no chat when none is scheduled). */
export function nextAutoContinue(chats: readonly { id: string; usage_limit?: UsageLimitCut | null }[], now: number): { id: string; at: number } | null {
	let next: { id: string; at: number } | null = null;
	for (const c of chats) {
		const at = autoContinueAt(c.usage_limit, now);
		if (at !== null && (!next || at < next.at)) next = { id: c.id, at };
	}
	return next;
}

/** Where a cut stands: `unknown` (no reset to wait for), `waiting` (before the reset), `ready`. */
export function limitPhase(cut: UsageLimitCut, now: number): 'unknown' | 'waiting' | 'ready' {
	if (typeof cut.resets_at !== 'number') return 'unknown';
	return now >= cut.resets_at ? 'ready' : 'waiting';
}

/** A reset time in the reader's clock: the time alone today, else with its day (Orca's formatUsageLimitResetClock). */
export function formatResetClock(resetsAt: number, now: number, locale?: string): string {
	const at = new Date(resetsAt);
	const today = at.toDateString() === new Date(now).toDateString();
	return new Intl.DateTimeFormat(locale, today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);
}
