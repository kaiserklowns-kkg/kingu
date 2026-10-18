// Automations model: pure types and the runner's decisions (no runes, no Tauri), so `bun test`
// covers catch-up, double runs and the guards without ever starting an agent. Shapes mirror Rust
// `agent/automations.rs` (`<root>/.kingu/automations.json`).

import { latestDue, parseSchedule, upcoming } from './schedule.ts';
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
	/** null = `kingu.agent.runMode` when it runs. */
	mode: RunMode | null;
	enabled: boolean;
	/** Run once on start when a run was due while Kingu was closed. */
	catch_up: boolean;
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

export type Decision = { id: string; due: number; action: 'run' } | { id: string; due: number; action: 'skip'; reason: string };

export function newAutomation(
	input: { id: string; name: string; prompt: string; schedule: string; base?: string | null; mode?: RunMode | null; catch_up?: boolean },
	now: number
): Automation {
	return {
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

/** The next run after `now` (for the list and `next_run_at`); null when off or unparsable. */
export function nextRunOf(a: Automation, now: number, handled?: number): number | null {
	if (!a.enabled) return null;
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
export function consentKey(root: string, a: Pick<Automation, 'id' | 'prompt' | 'schedule' | 'base' | 'mode'>): string {
	return JSON.stringify([root, a.id, a.prompt, a.schedule, a.base, a.mode]);
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
