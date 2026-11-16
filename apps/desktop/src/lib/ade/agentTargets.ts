// The choices of the "Send to…" menu (agentTarget.svelte.ts). Pure.

export type TargetChoice =
	| { kind: 'task'; id: 'task'; agent: string; running: boolean }
	| { kind: 'taskDraft'; id: 'taskDraft'; agent: string }
	| { kind: 'pane'; id: string; agent: string | null; state: string; message?: string }
	| { kind: 'newTask'; id: 'newTask' }
	| { kind: 'copy'; id: 'copy' };

/**
 * The task's agent first (it starts if it isn't running), then "into its composer without
 * sending" while it runs, then the agents of its other panes, then a new task and the clipboard.
 * A task with nothing else running offers its agent alone (sent without asking).
 */
export function targetChoices(o: { task: { agent: string; running: boolean } | null; panes: { id: string; agent: string | null; state: string; message?: string }[] }): TargetChoice[] {
	const out: TargetChoice[] = [];
	if (o.task) {
		out.push({ kind: 'task', id: 'task', agent: o.task.agent, running: o.task.running });
		if (!o.panes.length) return out;
		if (o.task.running) out.push({ kind: 'taskDraft', id: 'taskDraft', agent: o.task.agent });
	}
	for (const p of o.panes) out.push({ kind: 'pane', id: `pane:${p.id}`, agent: p.agent, state: p.state, message: p.message });
	out.push({ kind: 'newTask', id: 'newTask' }, { kind: 'copy', id: 'copy' });
	return out;
}
