import { error, fail, redirect, type Actions } from '@sveltejs/kit';
import { api, ApiError } from '#lib/server/api.ts';
import { apiFail } from '#lib/server/forms.ts';
import type { Task, TaskStatus } from '#lib/board.ts';
import type { Run } from '#lib/runs.ts';
import type { PageServerLoad } from './$types';

export type TaskDetail = Task & { project_name: string; source: string; external_ref: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: TaskStatus[] = ['backlog', 'running', 'needs_input', 'review', 'done', 'failed'];

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!UUID.test(params.id)) error(404, 'ไม่พบงานนี้');
	try {
		const [task, runs] = await Promise.all([
			api<TaskDetail>(locals.token!, `/v1/tasks/${params.id}`),
			api<{ items: Run[] }>(locals.token!, `/v1/runs?task_id=${params.id}&limit=100`)
		]);
		return { task, runs: runs.items };
	} catch (e) {
		if (e instanceof ApiError && e.status === 404) error(404, 'ไม่พบงานนี้ (อาจถูกลบไปแล้ว)');
		throw e;
	}
};

export const actions: Actions = {
	// Title, status and branch; any member but viewers (enforced by the server).
	update: async ({ request, locals, params }) => {
		const f = await request.formData();
		const title = String(f.get('title') ?? '').trim();
		const status = String(f.get('status') ?? '') as TaskStatus;
		const branch = String(f.get('branch') ?? '').trim();
		if (!title || [...title].length > 300) return fail(400, { error: 'ชื่องานต้องมี 1–300 ตัวอักษร' });
		if (!STATUSES.includes(status)) return fail(400, { error: 'เลือกสถานะ' });
		if (branch.length > 255 || /\s/.test(branch)) return fail(400, { error: 'ชื่อ branch ไม่ถูกต้อง' });
		const body: Record<string, string> = { title, status };
		// The API cannot clear a branch; an empty field leaves it as it is.
		if (branch) body.branch = branch;
		try {
			await api(locals.token!, `/v1/tasks/${params.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		} catch (e) {
			return apiFail(e, 'ไม่พบงานนี้ (อาจถูกลบไปแล้ว)');
		}
		return { saved: true };
	},
	close: async ({ request, locals }) => {
		const id = String((await request.formData()).get('id') ?? '');
		if (!UUID.test(id)) return fail(400, { error: 'ข้อมูลไม่ถูกต้อง' });
		try {
			await api(locals.token!, `/v1/runs/${id}/close`, { method: 'POST' });
		} catch (e) {
			return apiFail(e, 'ไม่พบการรันนี้');
		}
		return { closed: true };
	},
	// Owners and leads. A task the desktop syncs comes back on its next change.
	delete: async ({ locals, params }) => {
		try {
			await api(locals.token!, `/v1/tasks/${params.id}`, { method: 'DELETE' });
		} catch (e) {
			return apiFail(e, 'ไม่พบงานนี้ (อาจถูกลบไปแล้ว)');
		}
		redirect(303, '/');
	}
};
