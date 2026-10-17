import { api, type Project } from '#lib/server/api.ts';
import type { Task } from '#lib/board.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const token = locals.token!;
	const [tasks, projects] = await Promise.all([
		api<{ items: Task[] }>(token, '/v1/tasks?limit=500'),
		api<{ items: Project[] }>(token, '/v1/projects?limit=500')
	]);
	return { tasks: tasks.items, projects: projects.items.map((p) => ({ id: p.id, name: p.name })) };
};
