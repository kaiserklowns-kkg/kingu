// What the team server sees of an ADE task: metadata only (status, branch, agent, diff stats).
// Never the prompt, file names or contents.
import type { TaskStatus as TeamStatus, TeamTaskInput } from '#lib/team/team.ts';
import { aggregateStats, type TaskStatus, type TaskView } from './model.ts';

const STATUS: Record<TaskStatus, TeamStatus> = {
	running: 'running',
	waiting: 'needs_input',
	review: 'review',
	done: 'done',
	failed: 'failed'
};

/** `folder` disambiguates tasks with the same slug in different repositories. */
export function toTeamTask(view: TaskView, folder: string): TeamTaskInput {
	const { meta, stat } = view;
	const totals = stat ? aggregateStats(stat.files) : undefined;
	const finished = view.status === 'done' || view.status === 'failed' ? (meta.merged_at ?? meta.updated_at) : null;
	return {
		id: `${folder}:${meta.slug}`,
		title: meta.title,
		status: STATUS[view.status],
		branch: `kingu/${meta.slug}`,
		agent: meta.agent,
		model: meta.model,
		additions: totals?.added,
		deletions: totals?.deleted,
		filesChanged: totals?.files,
		startedAt: meta.created_at,
		finishedAt: finished
	};
}

/** Changes worth sending: everything but timestamps that move on every save. */
export function syncKey(t: TeamTaskInput): string {
	return JSON.stringify([t.title, t.status, t.branch, t.agent, t.model, t.additions, t.deletions, t.filesChanged, t.finishedAt]);
}
