import { fail, type Actions } from '@sveltejs/kit';
import { api, ApiError } from '#lib/server/api.ts';
import type { PageServerLoad } from './$types';

export type TeamSnap = {
	snap_id: string;
	name: string;
	version: string;
	git_url: string;
	git_ref: string | null;
	commit_sha: string;
	manifest_sha256: string;
	permissions: { network: boolean; fs: string; secrets: string[] };
	approved_by: string;
	approved_at: string;
	required: boolean;
	note: string | null;
};

const SNAP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const load: PageServerLoad = async ({ locals }) => {
	const snaps = await api<{ items: TeamSnap[] }>(locals.token!, '/v1/snaps');
	return { snaps: snaps.items };
};

export const actions: Actions = {
	// The server enforces owner/lead; the page only hides the button for others.
	remove: async ({ request, locals }) => {
		const id = String((await request.formData()).get('snap_id') ?? '');
		if (!SNAP_ID.test(id)) return fail(400, { error: 'snap id ไม่ถูกต้อง' });
		try {
			await api(locals.token!, `/v1/snaps/${id}`, { method: 'DELETE' });
		} catch (e) {
			if (e instanceof ApiError && e.status === 403) return fail(403, { error: 'เฉพาะ owner หรือ lead ที่ถอน snap ออกจากทีมได้' });
			if (e instanceof ApiError && e.status === 404) return fail(404, { error: `ไม่พบ snap ${id} (อาจถูกถอนไปแล้ว)` });
			return fail(502, { error: 'ถอน snap ไม่สำเร็จ ลองใหม่อีกครั้ง' });
		}
		return { removed: id };
	}
};
