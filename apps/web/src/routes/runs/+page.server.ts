import { api } from '#lib/server/api.ts';
import type { PageServerLoad } from './$types';

export type Run = {
	id: string;
	task_id: string;
	task_title: string;
	project_id: string;
	adapter: string;
	model: string | null;
	machine_id: string | null;
	started_at: string;
	ended_at: string | null;
	exit_reason: string | null;
	input_tokens: number;
	output_tokens: number;
};

export const load: PageServerLoad = async ({ locals }) => {
	const runs = await api<{ items: Run[] }>(locals.token!, '/v1/runs?limit=200');
	return { runs: runs.items };
};
