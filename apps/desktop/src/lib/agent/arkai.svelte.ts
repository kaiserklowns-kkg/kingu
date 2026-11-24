// `arkaiProviders.list`: Arkai's providers and their models (Rust `arkai_providers`), asked when an
// Arkai chat's model picker or Settings › Arkai opens and again on `refresh()` (after a key or the
// settings change). Keys go straight to the Keychain through Rust; the webview never reads one.

import { invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { parseArkaiProviders, parseArkaiRouters, type ArkaiProviderInfo, type ArkaiRouter } from './arkai.ts';

/** Rust `arkai::SETTING` and `arkai::ROUTER_SETTING`. */
const PROVIDERS_SETTING = 'kingu.arkai.providers';
const ROUTER_SETTING = 'chat.copilot.modelRouter.enabled';

class ArkaiProviders {
	list = $state<ArkaiProviderInfo[]>([]);
	/** The user's model routers (`chat.copilot.modelRouter.enabled`; empty when off). */
	routers = $state<ArkaiRouter[]>([]);
	loading = $state(false);
	#asked: Promise<void> | null = null;
	#seen = '';

	/**
	 * Asks Rust once per value of the settings the list comes from (later calls share the answer),
	 * so a provider added in Settings › Arkai or in settings.json shows up without a restart; it
	 * reads them, so an effect calling it runs again when they change. `refresh` always asks again.
	 */
	load(): Promise<void> {
		const seen = JSON.stringify([settings.get(PROVIDERS_SETTING) ?? null, settings.get(ROUTER_SETTING) ?? null]);
		if (seen !== this.#seen || !this.#asked) {
			this.#seen = seen;
			this.#asked = this.refresh();
		}
		return this.#asked;
	}

	async refresh(): Promise<void> {
		this.loading = true;
		try {
			const [providers, routers] = await Promise.all([invoke('arkai_providers'), invoke('arkai_model_routers').catch(() => [])]);
			this.list = parseArkaiProviders(providers);
			this.routers = parseArkaiRouters(routers);
		} catch (e) {
			clientLog('info', `arkai providers not listed: ${e}`);
		} finally {
			this.loading = false;
		}
	}

	async setKey(provider: string, key: string): Promise<void> {
		await invoke('arkai_set_key', { provider, key });
		await this.refresh();
	}

	async deleteKey(provider: string): Promise<void> {
		await invoke('arkai_delete_key', { provider });
		await this.refresh();
	}
}

export const arkaiProviders = new ArkaiProviders();
