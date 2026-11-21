import { defineEnvVars } from '@sveltejs/kit/env';
import { parseProviders } from './lib/oidc.ts';

export const variables = defineEnvVars({
	KINGU_API_URL: {
		description: 'Base URL of the Kingu team server (apps/server). Only this server process talks to it; the token never reaches browser JS.',
		schema: (value) => {
			const v = (value ?? '').trim() || 'http://127.0.0.1:8787';
			const u = new URL(v);
			if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('KINGU_API_URL must be http(s)');
			return v.replace(/\/+$/, '');
		}
	},
	KINGU_OIDC_ISSUER: {
		description: 'OIDC issuer for "Sign in with SSO" (same value as the team server\'s KINGU_OIDC_ISSUER). Unset hides the button.',
		schema: (value) => {
			const v = (value ?? '').trim();
			if (!v) return '';
			const u = new URL(v);
			const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
			if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('KINGU_OIDC_ISSUER must be https');
			return v;
		}
	},
	KINGU_OIDC_CLIENT_ID: {
		description: 'OAuth client id registered at the identity provider (the team server\'s KINGU_OIDC_CLIENT_ID).',
		schema: (value) => (value ?? '').trim()
	},
	KINGU_OIDC_CLIENT_SECRET: {
		description: 'Client secret, for confidential clients. Optional: the login uses PKCE either way.',
		schema: (value) => (value ?? '').trim()
	},
	KINGU_OIDC_PROVIDERS: {
		description:
			'Further identity providers, one button each: a JSON array of {"id","name","issuer","client_id","client_secret"} (each issuer also listed in the team server\'s KINGU_OIDC_PROVIDERS, which maps it to an org).',
		schema: (value) => {
			const v = (value ?? '').trim();
			parseProviders(v, { issuer: '', clientId: '', clientSecret: '' });
			return v;
		}
	}
});
