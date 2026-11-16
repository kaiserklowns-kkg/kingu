// Bitbucket: Connect… / Disconnect (Orca's Settings › Integrations › Bitbucket): an access token,
// or an email with an API token, checked with Bitbucket's `GET /user` and kept in the keychain
// (Rust bitbucket.rs). A folder whose origin is on bitbucket.org then finds, shows and creates its
// task pull requests there. The secret never stays in the webview.
import { invoke } from '@tauri-apps/api/core';
import { t } from '#lib/i18n/index.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';

export type BitbucketStatus = { configured: boolean; source: 'environment' | 'stored' | 'none'; account: string | null; auth_mode: string | null; email: string | null; base_url: string | null };

export async function connectBitbucket(): Promise<boolean> {
	const mode = await quick.choose({
		placeholder: t('forge.bitbucket.mode'),
		items: [
			{ id: 'basic', label: t('forge.bitbucket.modeBasic'), description: t('forge.bitbucket.modeBasicHint') },
			{ id: 'token', label: t('forge.bitbucket.modeToken'), description: t('forge.bitbucket.modeTokenHint') }
		]
	});
	if (!mode) return false;
	let args: Record<string, string | null> = { authMode: mode.id, accessToken: null, email: null, apiToken: null, baseUrl: null };
	if (mode.id === 'token') {
		const token = await quick.input({ placeholder: t('forge.bitbucket.accessToken'), password: true, hint: (v) => (v.trim() ? t('forge.bitbucket.connectHint') : t('forge.bitbucket.accessToken')) });
		if (!token) return false;
		args = { ...args, accessToken: token };
	} else {
		const email = await quick.input({ placeholder: t('forge.bitbucket.email'), hint: (v) => (v.trim() ? t('forge.bitbucket.next') : t('forge.bitbucket.email')) });
		if (!email) return false;
		const apiToken = await quick.input({ placeholder: t('forge.bitbucket.apiToken'), password: true, hint: (v) => (v.trim() ? t('forge.bitbucket.connectHint') : t('forge.bitbucket.apiToken')) });
		if (!apiToken) return false;
		args = { ...args, email, apiToken };
	}
	try {
		const s = await invoke<BitbucketStatus>('bitbucket_connect', args);
		status.flash(t('forge.bitbucket.connected', { account: s.account ?? 'Bitbucket' }), 6000);
		return true;
	} catch (e) {
		notifications.error(String(e));
		return false;
	}
}

export async function disconnectBitbucket() {
	try {
		await invoke('bitbucket_disconnect');
		status.flash(t('forge.bitbucket.disconnected'), 4000);
	} catch (e) {
		notifications.error(String(e));
	}
}

export function installBitbucketCommands(): () => void {
	const off = [
		commands.register({ id: 'kingu.bitbucket.connect', title: 'Bitbucket: Connect…', category: 'Agents', run: () => void connectBitbucket() }),
		commands.register({ id: 'kingu.bitbucket.disconnect', title: 'Bitbucket: Disconnect', category: 'Agents', run: () => void disconnectBitbucket() })
	];
	return () => off.forEach((u) => u());
}
