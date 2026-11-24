// `managedCli`: the agent CLIs Kingu can install itself (Rust `agent/managed_cli`), as the disk
// says now. `load()` reads the list (no network); `look(agent)` also asks the publisher for its
// latest release, as the chat's install card and the Settings row do so they can say what an
// install downloads. Nothing is downloaded until `install(agent)`: the user's Install button.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { clientLog } from '#lib/client-log.ts';
import { agentRuntimes } from './runtimes.svelte.ts';
import { installFor, isRunning, parseRoute, parseStatus, parseStatuses, type AntigravityRoute, type ManagedStatus } from './managedCli.ts';

class ManagedCli {
	list = $state<ManagedStatus[]>([]);
	/** Where a new Antigravity chat runs here (Rust `antigravity_chat_route`); null until asked. */
	antigravity = $state<AntigravityRoute | null>(null);
	#asked: Promise<void> | null = null;
	#looking = new Map<string, Promise<void>>();

	/** Reads the list once and follows changes (install progress, a finished install or removal). */
	load(): Promise<void> {
		return (this.#asked ??= (async () => {
			void listen<unknown>('managed-cli:changed', (e) => {
				const next = parseStatus(e.payload);
				if (next) this.#put(next);
			}).catch(() => {});
			await this.refresh();
		})());
	}

	async refresh(): Promise<void> {
		try {
			const next = parseStatuses(await invoke('managed_cli_list'));
			// A lookup's answer (version, size) outlives a plain re-read of the disk.
			this.list = next.map((s) => ({ ...s, ...(s.version === null ? this.#known(s.agent) : {}) }));
		} catch (e) {
			clientLog('info', `managed agent CLIs not listed: ${e}`);
		}
		await this.refreshRoute();
	}

	/** Asks again where Antigravity chats run (an install, a removal or a setting may move them). */
	async refreshRoute(): Promise<void> {
		try {
			this.antigravity = parseRoute(await invoke('antigravity_chat_route'));
		} catch (e) {
			clientLog('info', `antigravity route unknown: ${e}`);
		}
	}

	/** The install a chat on `runtimeId` needs (Antigravity's follows its route). */
	forRuntime(runtimeId: string): ManagedStatus | undefined {
		return installFor(this.list, runtimeId, this.antigravity);
	}

	of(agent: string): ManagedStatus | undefined {
		return this.list.find((s) => s.agent === agent);
	}

	#known(agent: string): Partial<ManagedStatus> {
		const s = this.of(agent);
		return s?.version ? { version: s.version, downloadBytes: s.downloadBytes, downloadHost: s.downloadHost } : {};
	}

	#put(next: ManagedStatus) {
		const before = this.of(next.agent);
		this.list = this.list.some((s) => s.agent === next.agent) ? this.list.map((s) => (s.agent === next.agent ? next : s)) : [...this.list, next];
		// An install or a removal settled: the chat's agents and the CLI pickers read the disk again.
		if (isRunning(before) && !isRunning(next)) {
			void agentRuntimes.refresh();
			void this.refreshRoute();
		}
	}

	/** Asks the publisher for `agent`'s latest release (its version and download size); once at a time. */
	look(agent: string): Promise<void> {
		const running = this.#looking.get(agent);
		if (running) return running;
		const p = (async () => {
			try {
				const next = parseStatus(await invoke('managed_cli_status', { agent }));
				if (next) this.#put(next);
			} catch (e) {
				clientLog('info', `managed ${agent} not looked up: ${e}`);
			} finally {
				this.#looking.delete(agent);
			}
		})();
		this.#looking.set(agent, p);
		return p;
	}

	async #act(command: string, args: Record<string, unknown>): Promise<void> {
		const next = parseStatus(await invoke(command, args));
		if (next) this.#put(next);
	}

	/** The user pressed Install: the download starts; progress arrives as events. */
	install(agent: string): Promise<void> {
		return this.#act('managed_cli_install', { agent });
	}

	cancel(agent: string, operation: number): Promise<void> {
		return this.#act('managed_cli_cancel', { agent, operation });
	}

	async remove(agent: string): Promise<void> {
		await this.#act('managed_cli_remove', { agent });
		await agentRuntimes.refresh();
	}
}

export const managedCli = new ManagedCli();
