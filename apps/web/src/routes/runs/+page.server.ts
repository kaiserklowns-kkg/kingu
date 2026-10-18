import { api } from '#lib/server/api.ts';
import type { Run } from '#lib/runs.ts';
import type { PageServerLoad } from './$types';

export type { Run };

export const load: PageServerLoad = async ({ locals }) => {
	const runs = await api<{ items: Run[] }>(locals.token!, '/v1/runs?limit=200');
	return { runs: runs.items };
};
