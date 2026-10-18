// What the team server sees of an ADE task: metadata only (status, branch, agent, diff stats, the
// issue it came from, and its runs' timings, tokens and cost). Never the prompt, file names or contents.
import type { TaskStatus as TeamStatus, TeamRunInput, TeamTaskInput } from '#lib/team/team.ts';
import { aggregateStats, type TaskStatus, type TaskView } from './model.ts';

const STATUS: Record<TaskStatus, TeamStatus> = {
	running: 'running',
	waiting: 'needs_input',
	review: 'review',
	done: 'done',
	failed: 'failed'
};

/** `folder` disambiguates tasks with the same slug in different repositories. */
export function toTeamTask(view: TaskView, folder: string, branch = `kingu/${view.meta.slug}`): TeamTaskInput {
	const { meta, stat } = view;
	const totals = stat ? aggregateStats(stat.files) : undefined;
	const finished = view.status === 'done' || view.status === 'failed' ? (meta.merged_at ?? meta.updated_at) : null;
	return {
		id: `${folder}:${meta.slug}`,
		title: meta.title,
		status: STATUS[view.status],
		branch,
		agent: meta.agent,
		model: meta.model,
		additions: totals?.added,
		deletions: totals?.deleted,
		filesChanged: totals?.files,
		startedAt: meta.created_at,
		finishedAt: finished,
		issue: meta.issue
	};
}

/** The task's latest run as tasks.json saved it; null until a run that knows its start has a turn done. */
export function toTeamRun(view: TaskView, folder: string): TeamRunInput | null {
	const { meta } = view;
	const r = meta.last_run;
	if (!r?.started_at) return null;
	return {
		taskId: `${folder}:${meta.slug}`,
		agent: meta.agent,
		model: meta.model,
		status: r.status,
		startedAt: r.started_at,
		at: r.at,
		inputTokens: r.input_tokens,
		outputTokens: r.output_tokens,
		costUsd: r.cost_usd
	};
}

/** Run changes worth sending (not `at` alone, which moves on every save). */
export function runKey(r: TeamRunInput): string {
	return JSON.stringify([r.startedAt, r.status, r.model, r.inputTokens, r.outputTokens, r.costUsd]);
}

/** Changes worth sending: everything but timestamps that move on every save. */
export function syncKey(t: TeamTaskInput): string {
	return JSON.stringify([t.title, t.status, t.branch, t.agent, t.model, t.additions, t.deletions, t.filesChanged, t.finishedAt, t.issue?.url ?? null]);
}
