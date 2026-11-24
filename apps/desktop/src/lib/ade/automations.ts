// Automations model: pure types and the runner's decisions (no runes, no Tauri), so `bun test`
// covers catch-up, double runs and the guards without ever starting an agent. Shapes mirror Rust
// `agent/automations.rs` (`<root>/.kingu/automations.json`).

import { latestDue, parseSchedule, upcoming } from './schedule.ts';
import { describeCron, isValidCron, localTimeZone, nextAutomationCronOccurrence, type TriggerKind } from './automationCron.ts';
import type { RunMode } from './agentCli.ts';
import { t } from '#lib/i18n/index.ts';

export type AutomationSkip = { at: number; reason: string };

export type Automation = {
	id: string;
	name: string;
	prompt: string;
	schedule: string;
	/** Branch to fork from; null = the folder's current branch when it runs. */
	base: string | null;
	/** Always `terminal`; nullable only for automations saved by an older Kingu. */
	mode: RunMode | null;
	enabled: boolean;
	/**
	 * Run once on start when a run was due while Kingu was closed (VS Code's misfire policy:
	 * on = `runOnce`, its default; off = `skip`).
	 */
	catch_up: boolean;
	/**
	 * VS Code 1.145's trigger: `manual`, a preset or `cron`, with `schedule` its five-field
	 * expression (automationCron.ts). Absent: a schedule in Kingu's own forms (schedule.ts).
	 */
	trigger?: TriggerKind | null;
	/** The IANA zone a trigger's expression is evaluated in (VS Code keeps a saved cron's zone); absent: this machine's. */
	time_zone?: string | null;
	/** Unix ms, like every timestamp here. */
	created_at: number;
	/** Due times before it never run (enabling never starts a backlog). */
	enabled_at: number | null;
	last_run_at: number | null;
	last_task_slug: string | null;
	/** Latest due time already handled (run or skipped). */
	last_due_at: number | null;
	next_run_at: number | null;
	last_skip: AutomationSkip | null;
};

/** A due run found later than this after its time counts as missed (Kingu was closed or asleep). */
export const MISSED_GRACE_MS = 5 * 60_000;
/**
 * VS Code's catch-up line for a trigger's occurrence (agentHostAutomationService.ts
 * `_claimDueRuns`: `nowTimestamp - scheduledFor >= 60_000` is a catch-up run).
 */
export const CATCH_UP_MS = 60_000;

/**
 * `handled`: due times up to it are done (a trigger's missed occurrences are all handled by the
 * one catch-up run, VS Code's `runOnce`); absent: up to `due`.
 */
export type Decision = ({ id: string; due: number; action: 'run' } | { id: string; due: number; action: 'skip'; reason: string }) & { handled?: number };

/** The zone a trigger runs in. */
export const zoneOf = (a: Pick<Automation, 'time_zone'>) => a.time_zone || localTimeZone();

/** Whether the automation can run on a schedule at all (Manual and invalid ones never do). */
export function isScheduled(a: Pick<Automation, 'trigger' | 'schedule' | 'time_zone'>): boolean {
	if (a.trigger === 'manual') return false;
	if (a.trigger) return isValidCron(a.schedule, zoneOf(a));
	return parseSchedule(a.schedule).ok;
}

/** What the list shows for the schedule: VS Code's description, or Kingu's own text. */
export function scheduleLabel(a: Pick<Automation, 'trigger' | 'schedule' | 'time_zone'>): string {
	if (a.trigger === 'manual') return t('cron.trigger.manualLabel');
	if (a.trigger) {
		const d = describeCron(a.schedule);
		if (!d) return a.schedule;
		return a.time_zone && a.time_zone !== localTimeZone() ? `${d} (${a.time_zone})` : d;
	}
	return a.schedule;
}

/** The first occurrence of a trigger after `from`, or null. */
function nextOccurrence(a: Automation, from: number): number | null {
	try {
		return nextAutomationCronOccurrence(a.schedule, zoneOf(a), from).getTime();
	} catch {
		return null;
	}
}

export function newAutomation(
	input: { id: string; name: string; prompt: string; schedule: string; base?: string | null; mode?: RunMode | null; catch_up?: boolean; trigger?: TriggerKind | null; time_zone?: string | null },
	now: number
): Automation {
	return {
		...(input.trigger ? { trigger: input.trigger, time_zone: input.time_zone ?? null } : {}),
		id: input.id,
		name: input.name.trim(),
		prompt: input.prompt.trim(),
		schedule: input.schedule.trim(),
		base: input.base || null,
		mode: input.mode ?? null,
		enabled: false,
		catch_up: input.catch_up ?? true,
		created_at: now,
		enabled_at: null,
		last_run_at: null,
		last_task_slug: null,
		last_due_at: null,
		next_run_at: null,
		last_skip: null
	};
}

/** Due times up to this one are handled (or predate enabling). */
export function anchorOf(a: Automation, handled?: number): number {
	return Math.max(a.last_due_at ?? 0, handled ?? 0, a.enabled_at ?? a.created_at);
}

/**
 * What the runner does now. `lastRuns`: due times handled in this session but maybe not saved yet
 * (so a slow save never runs a window twice); `running(slug)`: that task's agent still works.
 * Disabled automations, bad schedules and a global switch off decide nothing.
 */
export function decide(
	list: Automation[],
	now: number,
	lastRuns: Record<string, number>,
	running: (slug: string) => boolean,
	globalEnabled = true
): Decision[] {
	if (!globalEnabled) return [];
	const out: Decision[] = [];
	for (const a of list) {
		if (!a.enabled) continue;
		if (a.trigger) {
			const d = decideTrigger(a, now, lastRuns[a.id], running);
			if (d) out.push(d);
			continue;
		}
		const parsed = parseSchedule(a.schedule);
		if (!parsed.ok) continue;
		const due = latestDue(parsed.schedule, anchorOf(a, lastRuns[a.id]), now);
		if (due === null) continue;
		if (now - due > MISSED_GRACE_MS && !a.catch_up) out.push({ id: a.id, due, action: 'skip', reason: t('adeTasks.automations.skipMissed') });
		else if (a.last_task_slug && running(a.last_task_slug))
			out.push({ id: a.id, due, action: 'skip', reason: t('adeTasks.automations.skipStillRunning', { slug: a.last_task_slug }) });
		else out.push({ id: a.id, due, action: 'run' });
	}
	return out;
}

/**
 * VS Code's trigger semantics: the first occurrence after the last handled one is due once its
 * time comes; found a minute or more late it is a catch-up run (Kingu was closed or asleep), which
 * runs once for every missed occurrence, or is skipped when catch-up is off; another run of the
 * same automation still working skips it ("An automation runs one session at a time").
 */
function decideTrigger(a: Automation, now: number, handledNow: number | undefined, running: (slug: string) => boolean): Decision | null {
	if (a.trigger === 'manual') return null;
	const due = nextOccurrence(a, anchorOf(a, handledNow));
	if (due === null || due > now) return null;
	const catchUp = now - due >= CATCH_UP_MS;
	if (catchUp && !a.catch_up) return { id: a.id, due, action: 'skip', reason: t('adeTasks.automations.skipMissed'), handled: now };
	if (a.last_task_slug && running(a.last_task_slug)) return { id: a.id, due, action: 'skip', reason: t('adeTasks.automations.skipStillRunning', { slug: a.last_task_slug }), handled: now };
	return { id: a.id, due, action: 'run', handled: now };
}

/** The next run after `now` (for the list and `next_run_at`); null when off or unparsable. */
export function nextRunOf(a: Automation, now: number, handled?: number): number | null {
	if (!a.enabled) return null;
	if (a.trigger === 'manual') return null;
	if (a.trigger) return nextOccurrence(a, Math.max(now, anchorOf(a, handled)));
	return upcoming(a.schedule, anchorOf(a, handled), now);
}

/** Title of the task a run creates: the automation's name and the local date and time. */
export function runTitle(name: string, at: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${name} ${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`;
}

/**
 * What the user agreed to when enabling: a repository can ship an enabled automations.json, so
 * the runner also needs this machine's confirmation of exactly this prompt, schedule, base, mode.
 */
export function consentKey(root: string, a: Pick<Automation, 'id' | 'prompt' | 'schedule' | 'base' | 'mode' | 'trigger' | 'time_zone'>): string {
	// A trigger and its zone are part of what was agreed to (an older automation's key is unchanged).
	return JSON.stringify(a.trigger ? [root, a.id, a.prompt, a.schedule, a.base, a.mode, a.trigger, a.time_zone ?? null] : [root, a.id, a.prompt, a.schedule, a.base, a.mode]);
}

export function formatWhen(at: number | null, now: number): string {
	if (at === null) return '—';
	const d = new Date(at);
	const p = (n: number) => String(n).padStart(2, '0');
	const today = new Date(now);
	const sameDay = d.toDateString() === today.toDateString();
	const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
	return sameDay ? t('adeTasks.automations.today', { time }) : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`;
}
