import { fail, type Actions } from '@sveltejs/kit';
import { api } from '#lib/server/api.ts';
import { apiFail } from '#lib/server/forms.ts';
import { plausibleRepoUrl, type Page, type ProjectInfo } from '#lib/admin.ts';
import type { PageServerLoad } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = { 'Content-Type': 'application/json' };

export const load: PageServerLoad = async ({ locals, url }) => {
	const cursor = url.searchParams.get('cursor');
	const q = new URLSearchParams({ limit: '100' });
	if (cursor) q.set('cursor', cursor);
	const page = await api<Page<ProjectInfo>>(locals.token!, `/v1/projects?${q}`);
	return { projects: page.items, nextCursor: page.next_cursor, paged: !!cursor };
};

function read(f: FormData) {
	return {
		name: String(f.get('name') ?? '').trim(),
		repo_url: String(f.get('repo_url') ?? '').trim(),
		default_base_ref: String(f.get('default_base_ref') ?? '').trim() || 'main'
	};
}

function invalid(p: ReturnType<typeof read>): string | null {
	if (!p.name || [...p.name].length > 200) return 'ตั้งชื่อโปรเจกต์ (ไม่เกิน 200 ตัวอักษร)';
	if (!plausibleRepoUrl(p.repo_url)) return 'Repo URL ต้องเป็น https://, ssh:// หรือ git@host:path และห้ามมีรหัสผ่าน';
	if (p.default_base_ref.length > 255 || /\s/.test(p.default_base_ref)) return 'Base branch ไม่ถูกต้อง';
	return null;
}

// Owners and leads create and edit; only owners delete. The server enforces both.
export const actions: Actions = {
	create: async ({ request, locals }) => {
		const p = read(await request.formData());
		const err = invalid(p);
		if (err) return fail(400, { error: err, draft: p });
		try {
			const created = await api<ProjectInfo>(locals.token!, '/v1/projects', { method: 'POST', headers: json, body: JSON.stringify(p) });
			return { created: created.name };
		} catch (e) {
			const r = apiFail(e);
			if (r.status === 409) return fail(409, { error: `มีโปรเจกต์ชื่อ ${p.name} อยู่แล้ว`, draft: p });
			return r;
		}
	},
	update: async ({ request, locals }) => {
		const f = await request.formData();
		const id = String(f.get('id') ?? '');
		const p = read(f);
		const err = invalid(p);
		if (!UUID.test(id)) return fail(400, { error: 'ข้อมูลไม่ถูกต้อง' });
		if (err) return fail(400, { error: err });
		try {
			await api(locals.token!, `/v1/projects/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify(p) });
		} catch (e) {
			const r = apiFail(e, 'ไม่พบโปรเจกต์นี้');
			if (r.status === 409) return fail(409, { error: `มีโปรเจกต์ชื่อ ${p.name} อยู่แล้ว` });
			return r;
		}
		return { updated: p.name };
	},
	delete: async ({ request, locals }) => {
		const f = await request.formData();
		const id = String(f.get('id') ?? '');
		const name = String(f.get('name') ?? '');
		// Typed confirmation: the server deletes every task and run of the project.
		if (!UUID.test(id)) return fail(400, { error: 'ข้อมูลไม่ถูกต้อง' });
		if (String(f.get('confirm') ?? '').trim() !== name) return fail(400, { error: `พิมพ์ชื่อโปรเจกต์ “${name}” ให้ตรงเพื่อยืนยันการลบ` });
		try {
			const r = await api<{ tasks: number }>(locals.token!, `/v1/projects/${id}`, { method: 'DELETE' });
			return { deleted: name, tasks: r.tasks };
		} catch (e) {
			return apiFail(e, 'ไม่พบโปรเจกต์นี้ (อาจถูกลบไปแล้ว)');
		}
	}
};
