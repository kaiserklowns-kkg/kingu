// Automation schedules: a few readable forms plus standard 5-field cron, all in the local time
// zone. Pure (no runes, no Tauri) so `bun test` covers parsing and the next-run arithmetic.
//
//   daily HH:MM               every day
//   weekdays HH:MM            Monday to Friday
//   weekly mon,thu HH:MM      the listed days (mon..sun)
//   every 30m | every 2h      a fixed interval (at least 15 minutes, at most 7 days)
//   m h dom mon dow           cron: `*`, lists, ranges, steps, month/day names; dom and dow
//                             both restricted (neither starting with `*`) match either one
//
// Wall-clock times: a time skipped by a DST jump runs at the shifted time (02:30 → 03:30); a time
// that occurs twice when clocks fall back runs once (the first). `every` counts real elapsed time.

export const MIN_INTERVAL_MS = 15 * 60_000;
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60_000;
/** A date matching dom/month/dow at least this often, else the schedule never runs (Feb 29 needs 8 years around 2100). */
const MAX_SEARCH_DAYS = 366 * 9;

export type CronFields = {
	minute: number[];
	hour: number[];
	dom: number[];
	month: number[];
	/** 0 = Sunday. */
	dow: number[];
	/** Vixie cron: when both dom and dow are restricted a day matches either; otherwise both must match. */
	either: boolean;
};

export type Schedule = { kind: 'every'; ms: number } | ({ kind: 'cron' } & CronFields);

export type ParseResult = { ok: true; schedule: Schedule } | { ok: false; error: string };

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

const HELP = 'ใช้ได้: daily 09:00, weekdays 09:00, weekly mon,thu 09:00, every 30m, every 2h หรือ cron 5 ช่อง (นาที ชั่วโมง วัน เดือน วันในสัปดาห์)';

class ScheduleError extends Error {}
const fail = (msg: string): never => {
	throw new ScheduleError(msg);
};

function parseTime(text: string): [number, number] {
	const m = /^(\d{1,2}):(\d{2})$/.exec(text);
	if (!m) fail(`เวลา "${text}" ต้องอยู่ในรูป HH:MM เช่น 09:00`);
	const h = Number(m![1]);
	const min = Number(m![2]);
	if (h > 23 || min > 59) fail(`เวลา "${text}" ไม่มีจริง (ชั่วโมง 0-23 นาที 0-59)`);
	return [h, min];
}

function atTime(h: number, min: number, dow: number[]): Schedule {
	return { kind: 'cron', minute: [min], hour: [h], dom: range(1, 31), month: range(1, 12), dow, either: false };
}

type FieldSpec = { name: string; lo: number; hi: number; names?: string[]; namesFrom?: number };
const FIELDS: FieldSpec[] = [
	{ name: 'นาที', lo: 0, hi: 59 },
	{ name: 'ชั่วโมง', lo: 0, hi: 23 },
	{ name: 'วันที่', lo: 1, hi: 31 },
	{ name: 'เดือน', lo: 1, hi: 12, names: MONTHS, namesFrom: 1 },
	// 7 is Sunday too.
	{ name: 'วันในสัปดาห์', lo: 0, hi: 7, names: DAYS, namesFrom: 0 }
];

function parseValue(text: string, f: FieldSpec): number {
	if (/^\d+$/.test(text)) {
		const n = Number(text);
		if (n < f.lo || n > f.hi) fail(`ช่อง${f.name}: ${n} อยู่นอกช่วง ${f.lo}-${f.hi}`);
		return n;
	}
	const i = f.names?.indexOf(text) ?? -1;
	if (i < 0) fail(`ช่อง${f.name}: ไม่รู้จัก "${text}"`);
	return i + f.namesFrom!;
}

function parseField(text: string, f: FieldSpec): number[] {
	const out = new Set<number>();
	for (const item of text.split(',')) {
		if (!item) fail(`ช่อง${f.name}: มีจุลภาคเกิน`);
		const [span, stepText, extra] = item.split('/');
		if (extra !== undefined) fail(`ช่อง${f.name}: "${item}" ไม่ถูกต้อง`);
		let step = 1;
		if (stepText !== undefined) {
			if (!/^\d+$/.test(stepText) || Number(stepText) < 1) fail(`ช่อง${f.name}: ระยะห่าง "${stepText}" ต้องเป็นจำนวนเต็มบวก`);
			step = Number(stepText);
		}
		let lo: number;
		let hi: number;
		if (span === '*') [lo, hi] = [f.lo, f.hi];
		else if (span.includes('-')) {
			const [a, b, more] = span.split('-');
			if (more !== undefined || !a || !b) fail(`ช่อง${f.name}: ช่วง "${span}" ไม่ถูกต้อง`);
			[lo, hi] = [parseValue(a, f), parseValue(b, f)];
			if (lo > hi) fail(`ช่อง${f.name}: ช่วง "${span}" ต้องเรียงจากน้อยไปมาก`);
		} else {
			lo = parseValue(span, f);
			// `5/15`: from 5 to the end of the range, every 15.
			hi = stepText !== undefined ? f.hi : lo;
		}
		for (let v = lo; v <= hi; v += step) out.add(v);
	}
	return [...out].sort((a, b) => a - b);
}

function parseCron(parts: string[]): Schedule {
	const [minute, hour, dom, month, dowRaw] = parts.map((p, i) => parseField(p, FIELDS[i]));
	const dow = [...new Set(dowRaw.map((d) => d % 7))].sort((a, b) => a - b);
	const either = !parts[2].startsWith('*') && !parts[4].startsWith('*');
	// Each run starts an agent: keep runs at least 15 minutes apart.
	const gaps = minute.slice(1).map((m, i) => m - minute[i]);
	const adjacentHours = hour.some((h) => hour.includes((h + 1) % 24));
	if (adjacentHours) gaps.push(60 - minute[minute.length - 1] + minute[0]);
	if (gaps.some((g) => g < 15)) fail('cron นี้รันถี่เกินไป: แต่ละรอบต้องห่างกันอย่างน้อย 15 นาที');
	return { kind: 'cron', minute, hour, dom, month, dow, either };
}

function parseInner(text: string): Schedule {
	const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) fail(`ยังไม่ได้ใส่ตารางเวลา — ${HELP}`);
	const [head, ...rest] = words;
	if (head === 'daily' || head === 'weekdays') {
		if (rest.length !== 1) fail(`"${head}" ต้องตามด้วยเวลา เช่น ${head} 09:00`);
		const [h, m] = parseTime(rest[0]);
		return atTime(h, m, head === 'daily' ? range(0, 6) : range(1, 5));
	}
	if (head === 'weekly') {
		if (rest.length !== 2) fail('"weekly" ต้องตามด้วยวันและเวลา เช่น weekly mon,thu 09:00');
		const days = rest[0].split(',').map((d) => {
			const i = DAYS.indexOf(d);
			if (i < 0) fail(`ไม่รู้จักวัน "${d}" (ใช้ mon tue wed thu fri sat sun)`);
			return i;
		});
		const [h, m] = parseTime(rest[1]);
		return atTime(h, m, [...new Set(days)].sort((a, b) => a - b));
	}
	if (head === 'every') {
		const m = rest.length === 1 ? /^(\d+)(m|h)$/.exec(rest[0]) : null;
		if (!m) fail('"every" ต้องตามด้วยจำนวนและหน่วย เช่น every 30m หรือ every 2h');
		const ms = Number(m![1]) * (m![2] === 'h' ? 3_600_000 : 60_000);
		if (ms < MIN_INTERVAL_MS) fail('ระยะห่างสั้นที่สุดคือ 15 นาที (every 15m)');
		if (ms > MAX_INTERVAL_MS) fail('ระยะห่างยาวที่สุดคือ 7 วัน (every 168h) — ใช้ weekly แทน');
		return { kind: 'every', ms };
	}
	if (words.length === 5 && /^[\d*]/.test(head)) {
		const s = parseCron(words);
		if (!nextRun(s, new Date(2000, 0, 1))) fail('cron นี้ไม่มีวันที่ตรงเลย (เช่น 31 กุมภาพันธ์)');
		return s;
	}
	return fail(`ไม่รู้จักตารางเวลา "${text.trim()}" — ${HELP}`);
}

export function parseSchedule(text: string): ParseResult {
	try {
		return { ok: true, schedule: parseInner(text) };
	} catch (e) {
		if (e instanceof ScheduleError) return { ok: false, error: e.message };
		throw e;
	}
}

const asSchedule = (s: Schedule | string): Schedule | null => {
	if (typeof s !== 'string') return s;
	const r = parseSchedule(s);
	return r.ok ? r.schedule : null;
};

function dayMatches(s: CronFields, date: Date): boolean {
	if (!s.month.includes(date.getMonth() + 1)) return false;
	const dom = s.dom.includes(date.getDate());
	const dow = s.dow.includes(date.getDay());
	return s.either ? dom || dow : dom && dow;
}

/** The first run strictly after `after`, or null (an unparsable schedule, or no matching date). */
export function nextRun(schedule: Schedule | string, after: Date): Date | null {
	const s = asSchedule(schedule);
	if (!s) return null;
	const t0 = after.getTime();
	if (s.kind === 'every') return new Date(t0 + s.ms);
	const y = after.getFullYear();
	const m = after.getMonth();
	const d = after.getDate();
	// Start a day early: a time shifted forward by DST can land after a later-day start.
	for (let i = -1; i <= MAX_SEARCH_DAYS; i++) {
		// Noon is never inside a DST gap, so the date (not the time) is right here.
		const day = new Date(y, m, d + i, 12);
		if (!dayMatches(s, day)) continue;
		let best = Infinity;
		for (const h of s.hour) {
			for (const min of s.minute) {
				const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, min).getTime();
				if (t > t0 && t < best) best = t;
			}
		}
		if (best < Infinity) return new Date(best);
	}
	return null;
}

/** The next `n` runs after `after`. */
export function nextRuns(schedule: Schedule | string, after: Date, n: number): Date[] {
	const out: Date[] = [];
	let at = after;
	while (out.length < n) {
		const next = nextRun(schedule, at);
		if (!next) break;
		out.push(next);
		at = next;
	}
	return out;
}

const LOOKBACK_MS = [1, 32, 400, MAX_SEARCH_DAYS].map((d) => d * 24 * 3_600_000);

/**
 * The latest run time in `(from, now]` (Unix ms), or null when none is due. `every` counts from
 * `from`; cron looks back in growing windows so a long gap does not walk every occurrence.
 */
export function latestDue(schedule: Schedule | string, from: number, now: number): number | null {
	const s = asSchedule(schedule);
	if (!s || now <= from) return null;
	if (s.kind === 'every') {
		const k = Math.floor((now - from) / s.ms);
		return k >= 1 ? from + k * s.ms : null;
	}
	for (const back of LOOKBACK_MS) {
		let t = nextRun(s, new Date(Math.max(from, now - back)));
		if (!t || t.getTime() > now) {
			if (now - back <= from) return null;
			continue;
		}
		for (let next = nextRun(s, t); next && next.getTime() <= now; next = nextRun(s, next)) t = next;
		return t.getTime();
	}
	return null;
}

/**
 * The next run after `now` for a schedule handled up to `anchor`: `every` keeps its cadence from
 * the anchor, cron and the others just follow the clock.
 */
export function upcoming(schedule: Schedule | string, anchor: number, now: number): number | null {
	const s = asSchedule(schedule);
	if (!s) return null;
	if (s.kind === 'every') return anchor > now ? anchor + s.ms : anchor + (Math.floor((now - anchor) / s.ms) + 1) * s.ms;
	return nextRun(s, new Date(now))?.getTime() ?? null;
}
