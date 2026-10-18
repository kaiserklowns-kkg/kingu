// Workflow statuses you set on tasks (Orca's workspace statuses): the board's Todo / In progress /
// In review / Done columns, or your own from `kingu.board.statuses`. Apart from the agent's run
// status, so a task can wait on review or be parked while its agent is idle. Pure, so `bun test`
// covers it.

import { t } from '#lib/i18n/index.ts';

/** Orca's DEFAULT_WORKSPACE_STATUSES ids, in board order. */
export const DEFAULT_WORKFLOW = ['todo', 'in-progress', 'in-review', 'completed'] as const;
/** Orca's DEFAULT_WORKSPACE_STATUS_ID: a task with no status (or an unknown one) sits here. */
export const DEFAULT_WORKFLOW_ID = 'in-progress';
/** Rust `tasks::valid_workflow_status`. */
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_COLUMNS = 12;

export type WorkflowStatus = { id: string; label: string };

/** A column title as an id: `Waiting on QA` → `waiting-on-qa`. */
export function workflowId(label: string): string {
	return label
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
		.replace(/-+$/, '');
}

/** The built-in columns' names in the UI language; your own column shows what you typed. */
export function workflowLabel(id: string, typed?: string): string {
	switch (id) {
		case 'todo':
			return t('adeWorkflow.todo');
		case 'in-progress':
			return t('adeWorkflow.inProgress');
		case 'in-review':
			return t('adeWorkflow.inReview');
		case 'completed':
			return t('adeWorkflow.done');
	}
	return typed ?? id;
}

/**
 * `kingu.board.statuses` as columns: each entry an id (`in-review`) or a title (`Waiting on QA`,
 * made an id), duplicates and bad entries dropped, at most 12. Empty or unusable: the defaults.
 */
export function workflowStatuses(setting: unknown): WorkflowStatus[] {
	const seen = new Set<string>();
	const out: WorkflowStatus[] = [];
	for (const entry of Array.isArray(setting) ? setting : []) {
		if (typeof entry !== 'string' || !entry.trim()) continue;
		const typed = entry.trim();
		const id = ID.test(typed) ? typed : workflowId(typed);
		if (!ID.test(id) || seen.has(id)) continue;
		seen.add(id);
		out.push({ id, label: workflowLabel(id, typed) });
		if (out.length === MAX_COLUMNS) break;
	}
	return out.length ? out : DEFAULT_WORKFLOW.map((id) => ({ id, label: workflowLabel(id) }));
}

/** Orca's getDefaultWorkspaceStatusId: `in-progress` when it is a column, else the first one. */
export function defaultWorkflowId(statuses: readonly WorkflowStatus[]): string {
	return statuses.some((s) => s.id === DEFAULT_WORKFLOW_ID) ? DEFAULT_WORKFLOW_ID : (statuses[0]?.id ?? DEFAULT_WORKFLOW_ID);
}

/** The task's column: its saved status when that is a column, else the default one. */
export function workflowOf(meta: { workflow_status?: string | null }, statuses: readonly WorkflowStatus[]): string {
	const s = meta.workflow_status;
	return s && statuses.some((c) => c.id === s) ? s : defaultWorkflowId(statuses);
}

/** Tasks per column, in column order (each task in exactly one). */
export function workflowColumns<T extends { meta: { workflow_status?: string | null } }>(views: readonly T[], statuses: readonly WorkflowStatus[]): { status: WorkflowStatus; tasks: T[] }[] {
	const by = new Map<string, T[]>(statuses.map((s) => [s.id, []]));
	for (const v of views) by.get(workflowOf(v.meta, statuses))?.push(v);
	return statuses.map((s) => ({ status: s, tasks: by.get(s.id) ?? [] }));
}

/**
 * `kingu.board.autoStatus`: where a task's pull request moves it. An open PR moves it to
 * `in-review`, a merged one to `completed`, and only forward (a column further right stays);
 * null when nothing moves (no PR, a closed one, or that column is not on the board).
 */
export function autoWorkflow(current: string, pr: { state: string | null; merged: boolean }, statuses: readonly WorkflowStatus[]): string | null {
	const target = pr.merged || pr.state === 'MERGED' ? 'completed' : pr.state === 'OPEN' ? 'in-review' : null;
	if (!target || target === current) return null;
	const order = statuses.map((s) => s.id);
	const to = order.indexOf(target);
	if (to < 0) return null;
	const from = order.indexOf(current);
	return from > to ? null : target;
}
