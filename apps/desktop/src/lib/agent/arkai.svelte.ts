// `arkaiProviders.list`: Arkai's providers and their models (Rust `arkai_providers`), asked when an
// Arkai chat's model picker or Settings › Arkai opens and again on `refresh()` (after a key or the
// settings change). Keys go straight to the Keychain through Rust; the webview never reads one.

import { invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { parseArkaiProviders, type ArkaiProviderInfo } from './arkai.ts';

class ArkaiProviders {
	list = $state<ArkaiProviderInfo[]>([]);
	loading = $state(false);
	#asked: Promise<void> | null = null;

	/** Asks Rust once (later calls share the answer); `refresh` asks again. */
	load(): Promise<void> {
		return (this.#asked ??= this.refresh());
	}

	async refresh(): Promise<void> {
		this.loading = true;
		try {
			this.list = parseArkaiProviders(await invoke('arkai_providers'));
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
