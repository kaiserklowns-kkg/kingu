// Run history: the shape of GET /v1/runs and cost totals per task, person and project.

export type Run = {
	id: string;
	task_id: string;
	task_title: string;
	project_id: string;
	project_name: string;
	source: string;
	external_ref: string | null;
	adapter: string;
	model: string | null;
	machine_id: string | null;
	started_at: string;
	ended_at: string | null;
	exit_reason: string | null;
	input_tokens: number;
	output_tokens: number;
	/** USD; null when the agent did not report a cost. */
	cost_usd: number | null;
	/** Member who ran it; null for runs recorded before it was kept. */
	created_by: string | null;
};

export type CostRow = { key: string; label: string; runs: number; cost: number; tokens: number; unknown: number };

export type CostTotals = { byTask: CostRow[]; byPerson: CostRow[]; byProject: CostRow[]; total: number; unknown: number };

function group(runs: Run[], keyOf: (r: Run) => [string, string]): CostRow[] {
	const rows = new Map<string, CostRow>();
	for (const r of runs) {
		const [key, label] = keyOf(r);
		const row = rows.get(key) ?? { key, label, runs: 0, cost: 0, tokens: 0, unknown: 0 };
		row.runs += 1;
		row.tokens += r.input_tokens + r.output_tokens;
		if (r.cost_usd == null) row.unknown += 1;
		else row.cost += r.cost_usd;
		rows.set(key, row);
	}
	return [...rows.values()].sort((a, b) => b.cost - a.cost || b.runs - a.runs || a.label.localeCompare(b.label));
}

/** Cost per task, person and project, highest first. Runs without a reported cost are counted as `unknown`. */
export function costTotals(runs: Run[]): CostTotals {
	return {
		byTask: group(runs, (r) => [r.task_id, r.external_ref ? `${r.task_title} (${r.external_ref})` : r.task_title]),
		byPerson: group(runs, (r) => [r.created_by ?? '', r.created_by ?? 'ไม่ทราบ']),
		byProject: group(runs, (r) => [r.project_id, r.project_name]),
		total: runs.reduce((n, r) => n + (r.cost_usd ?? 0), 0),
		unknown: runs.filter((r) => r.cost_usd == null).length
	};
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** `$0.4213`, or `—` when unknown. */
export function formatCost(v: number | null): string {
	return v == null ? '—' : usd.format(v);
}
