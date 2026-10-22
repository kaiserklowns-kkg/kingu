import { invoke } from '@tauri-apps/api/core';
import { KNOWN_BINS } from '#lib/ade/agentProfiles.ts';
import { clientLog } from '#lib/client-log.ts';
import type { SetupReport } from './setup.ts';

class Setup {
	report = $state<SetupReport | null>(null);
	checking = $state(false);
	error = $state<string | null>(null);
	#asked: Promise<void> | null = null;

	load(): Promise<void> {
		return (this.#asked ??= this.check());
	}

	async check(): Promise<void> {
		this.checking = true;
		this.error = null;
		try {
			this.report = await invoke<SetupReport>('setup_check', { cliNames: KNOWN_BINS });
		} catch (e) {
			this.error = String(e);
			clientLog('error', `setup check failed: ${e}`);
		} finally {
			this.checking = false;
		}
	}
}

export const setup = new Setup();
