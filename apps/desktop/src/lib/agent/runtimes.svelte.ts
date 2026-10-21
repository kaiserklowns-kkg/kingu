// `agentRuntimes.list`: the chat's agents found on PATH (Rust `agent_runtimes`), asked when the
// chat panel opens and again on `refresh()` (after installing an agent). Claude Code is always in it.

import { invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { CLAUDE, featuresOf, parseRuntimes, type RuntimeFeatures, type RuntimeInfo } from './runtimes.ts';

class AgentRuntimes {
	list = $state<RuntimeInfo[]>([CLAUDE]);
	#asked: Promise<void> | null = null;

	/** Asks Rust once (later calls share the answer); `refresh` asks again. */
	load(): Promise<void> {
		return (this.#asked ??= this.refresh());
	}

	async refresh(): Promise<void> {
		try {
			this.list = parseRuntimes(await invoke('agent_runtimes'));
		} catch (e) {
			clientLog('info', `agent runtimes not listed: ${e}`);
		}
	}

	features(id: string): RuntimeFeatures {
		return featuresOf(this.list, id);
	}
}

export const agentRuntimes = new AgentRuntimes();
