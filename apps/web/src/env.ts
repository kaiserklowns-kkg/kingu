import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	KINGU_API_URL: {
		description: 'Base URL of the Kingu team server (apps/server). Only this server process talks to it; the token never reaches browser JS.',
		schema: (value) => {
			const v = (value ?? '').trim() || 'http://127.0.0.1:8787';
			const u = new URL(v);
			if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('KINGU_API_URL must be http(s)');
			return v.replace(/\/+$/, '');
		}
	}
});
