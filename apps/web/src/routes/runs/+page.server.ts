import { fail, type Actions } from '@sveltejs/kit';
import { api } from '#lib/server/api.ts';
import { apiFail } from '#lib/server/forms.ts';
import type { Run } from '#lib/runs.ts';
import type { PageServerLoad } from './$types';

export type { Run };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const load: PageServerLoad = async ({ locals }) => {
	const runs = await api<{ items: Run[] }>(locals.token!, '/v1/runs?limit=200');
	return { runs: runs.items };
};

export const actions: Actions = {
	// Ends a run whose desktop never reported its end (crash, offline). The server
	// allows the run's creator or an owner/lead.
	close: async ({ request, locals }) => {
		const id = String((await request.formData()).get('id') ?? '');
		if (!UUID.test(id)) return fail(400, { error: 'ข้อมูลไม่ถูกต้อง' });
		try {
			await api(locals.token!, `/v1/runs/${id}/close`, { method: 'POST' });
		} catch (e) {
			return apiFail(e, 'ไม่พบการรันนี้');
		}
		return { closed: id };
	}
};
