// VS Code 1.145's cron schedules for local automations, ported from
// src/vs/platform/agentHost/common/automationCron.ts (the grammar, the description and the next
// occurrence in a time zone) and the trigger presets of
// src/vs/workbench/contrib/sessions/providers/agentHost/browser/agentHostAutomationStore.ts
// (`scheduleTrigger`: Hourly / Daily / Weekdays / Weekly become a cron expression in the local
// time zone). Pure (no runes, no Tauri) so `bun test` covers it.
//
// Grammar (VS Code docs agents/run/automations.md "Cron expression syntax"): exactly five fields
// (minute hour day-of-month month day-of-week); `*`, lists, ascending ranges, positive steps on `*`
// or a range (`*/30`, `0-59/15`); month and weekday names; weekday 0 and 7 are Sunday. Steps from
// a single value (`5/15`), seconds and `@daily` are refused. When both day fields are restricted
// (neither is exactly `*`) either one matches; the month field still applies to both.

import { locale, t } from '#lib/i18n/index.ts';

const MINUTE_MS = 60_000;
const DATE_SEARCH_STEP_MS = 12 * 60 * MINUTE_MS;
const MAX_SEARCH_MS = 10 * 366 * 24 * 60 * MINUTE_MS;

const MONTH_NAMES = new Map([['JAN', 1], ['FEB', 2], ['MAR', 3], ['APR', 4], ['MAY', 5], ['JUN', 6], ['JUL', 7], ['AUG', 8], ['SEP', 9], ['OCT', 10], ['NOV', 11], ['DEC', 12]]);
const WEEKDAY_NAMES = new Map([['SUN', 0], ['MON', 1], ['TUE', 2], ['WED', 3], ['THU', 4], ['FRI', 5], ['SAT', 6]]);

type CronField = { values: ReadonlySet<number>; unrestricted: boolean };
export type AutomationCron = { minute: CronField; hour: CronField; dayOfMonth: CronField; month: CronField; dayOfWeek: CronField };
type LocalDateParts = { minute: number; hour: number; dayOfMonth: number; month: number; dayOfWeek: number };

/**
 * How an automation is triggered (VS Code's `AutomationInterval` for local automations, without
 * `once`): `manual` runs only on Run now; the presets and `cron` are a five-field expression in
 * `schedule`. A saved Cron stays Cron even when it matches a preset (VS Code keeps the kind).
 */
export type TriggerKind = 'manual' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'cron';
export const TRIGGER_KINDS: readonly TriggerKind[] = ['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'cron'];

/** The `schedule` text of a Manual automation (an older Kingu reads it as an invalid schedule and never runs it). */
export const MANUAL_SCHEDULE = 'manual';

class CronError extends Error {}
const fail = (message: string): never => {
	throw new CronError(message);
};

/** The machine's IANA time zone (VS Code: `Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'`). */
export function localTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

/** The expression's error in the UI language, or null when it is valid (an empty one is incomplete, not wrong). */
export function cronError(expression: string, timeZone: string): string | null {
	if (!expression.trim()) return null;
	try {
		parseAutomationCron(expression);
		createDateFormatter(timeZone);
		return null;
	} catch (e) {
		if (e instanceof CronError) return e.message;
		throw e;
	}
}

export function isValidCron(expression: string, timeZone: string): boolean {
	return !!expression.trim() && cronError(expression, timeZone) === null;
}

export function parseAutomationCron(expression: string): AutomationCron {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) fail(t('cron.error.fields'));
	const cron: AutomationCron = {
		minute: parseField(fields[0]!, t('cron.field.minute'), 0, 59),
		hour: parseField(fields[1]!, t('cron.field.hour'), 0, 23),
		dayOfMonth: parseField(fields[2]!, t('cron.field.dayOfMonth'), 1, 31),
		month: parseField(fields[3]!, t('cron.field.month'), 1, 12, MONTH_NAMES),
		dayOfWeek: parseField(fields[4]!, t('cron.field.dayOfWeek'), 0, 7, WEEKDAY_NAMES, (v) => (v === 7 ? 0 : v))
	};
	if (!hasPossibleCalendarDay(cron)) fail(t('cron.error.calendar'));
	return cron;
}

function hasPossibleCalendarDay(cron: AutomationCron): boolean {
	if (cron.dayOfMonth.unrestricted || !cron.dayOfWeek.unrestricted) return true;
	const maximumDayByMonth = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	for (const month of cron.month.values) for (const day of cron.dayOfMonth.values) if (day <= maximumDayByMonth[month]!) return true;
	return false;
}

function parseField(field: string, label: string, minimum: number, maximum: number, names: ReadonlyMap<string, number> = new Map(), normalize: (v: number) => number = (v) => v): CronField {
	const values = new Set<number>();
	for (const segment of field.split(',')) {
		if (!segment) fail(t('cron.error.emptySegment', { field: label }));
		const stepParts = segment.split('/');
		if (stepParts.length > 2) fail(t('cron.error.invalidStep', { field: label }));
		const step = stepParts[1] === undefined ? 1 : parsePositiveInteger(stepParts[1], label);
		const base = stepParts[0]!;
		let start: number;
		let end: number;
		if (base === '*') {
			start = minimum;
			end = maximum;
		} else {
			const range = base.split('-');
			if (range.length === 1) {
				if (stepParts.length > 1) fail(t('cron.error.stepBase', { field: label, min: minimum, max: maximum }));
				start = parseValue(range[0]!, label, minimum, maximum, names);
				end = start;
			} else if (range.length === 2) {
				start = parseValue(range[0]!, label, minimum, maximum, names);
				end = parseValue(range[1]!, label, minimum, maximum, names);
				if (start > end) fail(t('cron.error.ascending', { field: label }));
			} else {
				return fail(t('cron.error.invalidRange', { field: label }));
			}
		}
		for (let value = start; value <= end; value += step) values.add(normalize(value));
	}
	return { values, unrestricted: field === '*' };
}

function parseValue(value: string, label: string, minimum: number, maximum: number, names: ReadonlyMap<string, number>): number {
	const named = names.get(value.toUpperCase());
	const parsed = named ?? (/^\d+$/.test(value) ? Number(value) : Number.NaN);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) fail(t('cron.error.range', { field: label, min: minimum, max: maximum }));
	return parsed;
}

function parsePositiveInteger(value: string, label: string): number {
	const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
	if (!Number.isInteger(parsed) || parsed <= 0) fail(t('cron.error.positiveStep', { field: label }));
	return parsed;
}

function createDateFormatter(timeZone: string): Intl.DateTimeFormat {
	try {
		return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' });
	} catch {
		return fail(t('cron.error.timeZone'));
	}
}

function readLocalDateParts(formatter: Intl.DateTimeFormat, timestamp: number): LocalDateParts {
	const parts = new Map(formatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
	const weekday = WEEKDAY_NAMES.get((parts.get('weekday') ?? '').toUpperCase());
	if (weekday === undefined) throw new Error('Automation schedule could not resolve the local weekday.');
	return { minute: Number(parts.get('minute')), hour: Number(parts.get('hour')), dayOfMonth: Number(parts.get('day')), month: Number(parts.get('month')), dayOfWeek: weekday };
}

function matchesDate(cron: AutomationCron, parts: LocalDateParts): boolean {
	if (!cron.month.values.has(parts.month)) return false;
	const dayOfMonthMatches = cron.dayOfMonth.values.has(parts.dayOfMonth);
	const dayOfWeekMatches = cron.dayOfWeek.values.has(parts.dayOfWeek);
	if (cron.dayOfMonth.unrestricted) return cron.dayOfWeek.unrestricted || dayOfWeekMatches;
	if (cron.dayOfWeek.unrestricted) return dayOfMonthMatches;
	return dayOfMonthMatches || dayOfWeekMatches;
}

const matchesTime = (cron: AutomationCron, parts: LocalDateParts) => cron.minute.values.has(parts.minute) && cron.hour.values.has(parts.hour);

/**
 * The first occurrence strictly after `after` (to the minute) in `timeZone`. Walks minutes on a
 * matching local date and jumps 12 hours otherwise, backfilling a jump that lands on a matching
 * date so its earliest minutes are not skipped (VS Code `nextAutomationCronOccurrence`).
 */
export function nextAutomationCronOccurrence(expression: string, timeZone: string, after: Date | number): Date {
	const cron = parseAutomationCron(expression);
	const formatter = createDateFormatter(timeZone);
	const afterMs = typeof after === 'number' ? after : after.getTime();
	let candidate = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
	const searchEnd = candidate + MAX_SEARCH_MS;
	let minuteSearchEnd = candidate;
	while (candidate < searchEnd) {
		const parts = readLocalDateParts(formatter, candidate);
		const dateMatches = matchesDate(cron, parts);
		if (dateMatches && matchesTime(cron, parts)) return new Date(candidate);
		if (dateMatches || candidate < minuteSearchEnd) {
			candidate += MINUTE_MS;
			continue;
		}
		const jumped = Math.min(candidate + DATE_SEARCH_STEP_MS, searchEnd);
		if (matchesDate(cron, readLocalDateParts(formatter, jumped))) {
			minuteSearchEnd = jumped;
			candidate += MINUTE_MS;
		} else candidate = jumped;
	}
	throw new Error(`Automation schedule has no occurrence within ten years: ${expression}`);
}

/** The next `n` occurrences after `after` (the form's preview); empty when the expression is invalid. */
export function nextCronOccurrences(expression: string, timeZone: string, after: number, n: number): number[] {
	if (!isValidCron(expression, timeZone)) return [];
	const out: number[] = [];
	let at = after;
	try {
		while (out.length < n) {
			at = nextAutomationCronOccurrence(expression, timeZone, at).getTime();
			out.push(at);
		}
	} catch {
		// No occurrence within ten years: what was found is the preview.
	}
	return out;
}

// --- Description (VS Code `describeAutomationCron`): the same calendar and clock constraints the scheduler uses.

/** The `Intl` locale of the UI language. */
const intlLocale = () => (locale() === 'th' ? 'th-TH' : 'en-US');

export function describeAutomationCron(expression: string, lang = intlLocale()): string {
	const cron = parseAutomationCron(expression);
	const minutes = [...cron.minute.values].sort((a, b) => a - b);
	const hours = [...cron.hour.values].sort((a, b) => a - b);
	const clock = new Intl.DateTimeFormat(lang, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
	const hourClock = new Intl.DateTimeFormat(lang, { hour: 'numeric', timeZone: 'UTC' });
	const monthNames = new Intl.DateTimeFormat(lang, { month: 'long', calendar: 'gregory', timeZone: 'UTC' });
	const weekdayNames = new Intl.DateTimeFormat(lang, { weekday: 'long', timeZone: 'UTC' });
	const formatClock = (hour: number, minute: number) => clock.format(new Date(Date.UTC(2024, 0, 1, hour, minute)));
	const formatHour = (hour: number) => hourClock.format(new Date(Date.UTC(2024, 0, 1, hour)));
	const hourDescription = hours.length === 1 ? t('cron.describe.singleHour', { hour: formatHour(hours[0]!) }) : t('cron.describe.hours', { hours: describeValues(hours, formatHour) });
	const minuteCadence = cadence(minutes, 60);
	const hourCadence = cadence(hours, 24);
	let time: string;
	if (minutes.length === 60) {
		time = hours.length === 24 ? t('cron.describe.everyMinute') : t('cron.describe.minutesDuring', { hours: hourDescription });
	} else if (minuteCadence !== undefined) {
		time = hours.length === 24 ? t('cron.describe.minuteCadence', { n: minuteCadence }) : t('cron.describe.minuteCadenceDuring', { n: minuteCadence, hours: hourDescription });
	} else if (hours.length === 24) {
		time = minutes.length === 1 ? t('cron.describe.minuteHourly', { minute: minutes[0]! }) : t('cron.describe.minutesHourly', { minutes: describeValues(minutes) });
	} else if (minutes.length === 1 && minutes[0] === 0 && hourCadence !== undefined) {
		time = t('cron.describe.hourCadence', { n: hourCadence });
	} else if (minutes.length * hours.length <= 6) {
		time = t('cron.describe.times', { times: describeList(hours.flatMap((h) => minutes.map((m) => formatClock(h, m)))) });
	} else {
		time = minutes.length === 1 ? t('cron.describe.minuteDuring', { minute: minutes[0]!, hours: hourDescription }) : t('cron.describe.minutesDuringHours', { minutes: describeValues(minutes), hours: hourDescription });
	}

	const days = [...cron.dayOfMonth.values].sort((a, b) => a - b);
	const weekdays = [...cron.dayOfWeek.values].sort((a, b) => a - b);
	const monthDays = days.length === 1 ? t('cron.describe.monthDay', { day: days[0]! }) : t('cron.describe.monthDays', { days: describeValues(days) });
	const weekDays = t('cron.describe.weekdays', { days: describeValues(weekdays, (d) => weekdayNames.format(new Date(Date.UTC(2024, 0, 7 + d)))) });
	let date: string;
	if (cron.dayOfMonth.unrestricted && cron.dayOfWeek.unrestricted) date = t('cron.describe.everyDay');
	else if (cron.dayOfMonth.unrestricted) date = weekDays;
	else if (cron.dayOfWeek.unrestricted) date = monthDays;
	else date = t('cron.describe.additionalDays', { monthDays, weekDays });
	if (cron.month.values.size !== 12) {
		const months = [...cron.month.values].sort((a, b) => a - b);
		return t('cron.describe.inMonths', { months: describeValues(months, (m) => monthNames.format(new Date(Date.UTC(2024, m - 1, 1)))), time, date });
	}
	return t('cron.describe.runs', { time, date });
}

/** The description, or null for an invalid expression. */
export function describeCron(expression: string): string | null {
	try {
		return describeAutomationCron(expression);
	} catch {
		return null;
	}
}

function describeValues(values: readonly number[], format: (v: number) => string = String): string {
	if (values.length >= 3 && values.every((v, i) => i === 0 || v === values[i - 1]! + 1)) return t('cron.describe.range', { from: format(values[0]!), to: format(values[values.length - 1]!) });
	return describeList(values.map(format));
}

function describeList(items: readonly string[]): string {
	return items.length === 1 ? items[0]! : t('cron.describe.list', { head: items.slice(0, -1).join(t('cron.describe.separator')), last: items[items.length - 1]! });
}

function cadence(values: readonly number[], span: number): number | undefined {
	if (values.length < 2) return undefined;
	const step = values[1]! - values[0]!;
	return step > 1 && span % step === 0 && values.length === span / step && values.every((v, i) => v === i * step) ? step : undefined;
}

// --- Presets (VS Code agentHostAutomationStore `scheduleTrigger` / the reverse projection).

export type PresetFields = { hour: number; minute: number; /** 0 = Sunday. */ day: number };

/** The cron expression of a preset (Manual and Cron have none). */
export function presetExpression(kind: TriggerKind, f: PresetFields): string | null {
	switch (kind) {
		case 'hourly':
			return `${f.minute} * * * *`;
		case 'daily':
			return `${f.minute} ${f.hour} * * *`;
		case 'weekdays':
			return `${f.minute} ${f.hour} * * 1-5`;
		case 'weekly':
			return `${f.minute} ${f.hour} * * ${f.day}`;
		default:
			return null;
	}
}

/** A preset's hour, minute and day read back from its expression (editing it), or null. */
export function presetFields(expression: string): PresetFields | null {
	const [minute, hour, , , day] = expression.trim().split(/\s+/);
	const num = (v: string | undefined, max: number) => (v !== undefined && /^\d+$/.test(v) && Number(v) <= max ? Number(v) : null);
	const m = num(minute, 59);
	if (m === null) return null;
	const h = hour === '*' ? 0 : num(hour, 23);
	if (h === null) return null;
	const dayName = day ? WEEKDAY_NAMES.get(day.toUpperCase()) : undefined;
	const d = dayName ?? (day === '*' || day === '1-5' ? 0 : num(day, 7));
	return { minute: m, hour: h, day: d === null ? 0 : d % 7 };
}

/** The five fields of a pasted expression, or null when it isn't five fields (the form splits a paste across its inputs). */
export function splitCron(text: string): string[] | null {
	const fields = text.trim().split(/\s+/);
	return fields.length === 5 && fields.every(Boolean) ? fields : null;
}
