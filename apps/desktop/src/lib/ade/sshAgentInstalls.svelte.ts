// Agent CLIs Kingu installs on SSH hosts (Rust ssh_agent_install.rs; sshAgentInstall.ts has the
// views): each host's listing, read when SSH Hosts › Agents opens or the missing-agent prompt
// offers an install, then kept current by `ssh-agent-install:changed`. Nothing is installed until
// the user presses Install there, or answers Install to the question the prompt asks.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { t } from '#lib/i18n/index.ts';
import { clientLog } from '#lib/client-log.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { askText, hostAgentView, isBusy, mayOffer, parseHostAgents, parseHostStatus, parseNever, setNever, withStatus, type HostAgentStatus, type HostAgents } from './sshAgentInstall';

export const EVENT = 'ssh-agent-install:changed';
const NEVER_KEY = 'kingu.ssh.agentInstallNever';

function readNever(): Record<string, string[]> {
	try {
		return parseNever(localStorage.getItem(NEVER_KEY));
	} catch {
		return {};
	}
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

class SshAgentInstalls {
	hosts = $state<Record<string, HostAgents>>({});
	checking = $state<Record<string, boolean>>({});
	errors = $state<Record<string, string>>({});
	/** SSH Hosts: the hosts whose Agents panel is open. */
	open = $state<Record<string, boolean>>({});
	never = $state<Record<string, string[]>>(readNever());
	#listening = false;
	#waiters = new Map<string, ((s: HostAgentStatus) => void)[]>();

	#listen() {
		if (this.#listening) return;
		this.#listening = true;
		void listen<unknown>(EVENT, (e) => {
			const s = parseHostStatus(e.payload);
			if (s) this.#put(s);
		}).catch(() => {});
	}

	#put(s: HostAgentStatus) {
		const h = this.hosts[s.host];
		this.hosts[s.host] = h ? withStatus(h, s) : { host: s.host, platform: '', build: null, problem: null, agents: [s] };
		if (!isBusy(s)) {
			const key = `${s.host}\u0000${s.agent}`;
			const waiting = this.#waiters.get(key);
			this.#waiters.delete(key);
			for (const w of waiting ?? []) w(s);
		}
	}

	of(host: string, agent: string): HostAgentStatus | undefined {
		return this.hosts[host]?.agents.find((a) => a.agent === agent);
	}

	/** Asks the host what it has (and, with `lookup`, the publishers what an install downloads). */
	async check(host: string, lookup = true): Promise<HostAgents | null> {
		this.#listen();
		this.checking[host] = true;
		delete this.errors[host];
		try {
			const h = parseHostAgents(await invoke('ssh_agent_installs', { id: host, lookup }));
			if (h) this.hosts[host] = h;
			return h;
		} catch (e) {
			this.errors[host] = text(e);
			return null;
		} finally {
			delete this.checking[host];
		}
	}

	toggle(host: string) {
		this.open[host] = !this.open[host];
		if (this.open[host] && !this.hosts[host] && !this.checking[host]) void this.check(host);
	}

	async #act(command: string, args: Record<string, unknown>) {
		this.#listen();
		const s = parseHostStatus(await invoke(command, args));
		if (s) this.#put(s);
		return s;
	}

	/** The user pressed Install (or answered Install): the host downloads it; progress arrives as events. */
	install(host: string, agent: string) {
		return this.#act('ssh_agent_install', { id: host, agent });
	}

	cancel(host: string, agent: string, operation: number) {
		return this.#act('ssh_agent_install_cancel', { id: host, agent, operation });
	}

	remove(host: string, agent: string) {
		return this.#act('ssh_agent_remove', { id: host, agent });
	}

	/** Resolves once the install or removal of `agent` on `host` settles. */
	settled(host: string, agent: string): Promise<HostAgentStatus> {
		const now = this.of(host, agent);
		if (now && !isBusy(now)) return Promise.resolve(now);
		const key = `${host}\u0000${agent}`;
		return new Promise((resolve) => this.#waiters.set(key, [...(this.#waiters.get(key) ?? []), resolve]));
	}

	mayOffer(host: string, agent: string): boolean {
		return mayOffer(agent, host, this.never);
	}

	/** Never offer `agent` on `host` from the missing-agent prompt (`false`: offer again). */
	setNever(host: string, agent: string, on: boolean) {
		this.never = setNever(this.never, host, agent, on);
		try {
			localStorage.setItem(NEVER_KEY, JSON.stringify(this.never));
		} catch {
			// No storage: the answer holds for this run.
		}
	}

	/**
	 * The missing-agent prompt's "Install {agent} on {host}…": looks the host and the release up,
	 * asks Install / Not now / Never for this host, and on Install waits for the host to finish
	 * (progress in the status bar). True once the agent is installed there.
	 */
	async offer(host: string, label: string, agent: string): Promise<boolean> {
		status.flash(t('sshAgentInstall.checking'), 30_000);
		const h = await this.check(host);
		status.flash('');
		const s = this.of(host, agent);
		if (!h || !s) {
			notifications.error(t('sshAgentInstall.probeFailed', { error: this.errors[host] ?? '' }));
			return false;
		}
		if (s.source !== null) return true;
		if (!s.available) {
			notifications.info(t('sshAgentInstall.unavailable', { agent: s.label, host: label, reason: s.unavailable ?? h.problem ?? '' }));
			return false;
		}
		const pick = await quick.choose({
			placeholder: askText(s, label),
			items: [
				{ id: 'install', label: t('sshAgentInstall.askInstall'), description: '~/.kingu/agent-runtimes' },
				{ id: 'later', label: t('sshAgentInstall.askLater') },
				{ id: 'never', label: t('sshAgentInstall.askNever', { agent: s.label }) }
			]
		});
		if (pick?.id === 'never') this.setNever(host, agent, true);
		if (pick?.id !== 'install') return false;
		try {
			await this.install(host, agent);
		} catch (e) {
			notifications.error(t('sshAgentInstall.failed', { agent: s.label, error: text(e) }));
			return false;
		}
		const tick = $effect.root(() => {
			$effect(() => {
				const now = this.of(host, agent);
				if (now && isBusy(now)) status.flash(`${label}: ${hostAgentView(now).status ?? ''}`, 60_000);
			});
		});
		const done = await this.settled(host, agent);
		tick();
		status.flash('');
		if (done.operation?.phase === 'succeeded' && done.installedVersion) {
			notifications.info(t('sshAgentInstall.done', { agent: s.label, host: label }));
			return true;
		}
		if (done.operation?.phase === 'failed') notifications.error(t('sshAgentInstall.failed', { agent: s.label, error: done.operation.error ?? '' }));
		clientLog('info', `ssh agent install of ${agent} on ${host} ended ${done.operation?.phase ?? 'without an operation'}`);
		return false;
	}
}

export const sshAgentInstalls = new SshAgentInstalls();
