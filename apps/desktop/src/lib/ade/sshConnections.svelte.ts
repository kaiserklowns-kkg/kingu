// SSH host connections (Orca's `ssh:connect` / `ssh:disconnect` and its connection states): one
// HostConnection (sshConnection.ts) per saved host, dialled through Rust's `ssh_connect` (a probe
// over the shared system-ssh connection). A connected host is probed every `KEEPALIVE_MS`; one
// that stops answering is redialled on Orca's ladder, and again at once when the network returns.
// Listeners hear a host become connected (sshProjects.svelte.ts reads its worktrees again).
import { invoke } from '@tauri-apps/api/core';
import { DISCONNECTED, HostConnection, KEEPALIVE_MS, type SshState } from './sshConnection';

type Listener = (id: string, state: SshState, previous: SshState) => void;

class SshConnections {
	states = $state<Record<string, SshState>>({});
	#hosts = new Map<string, HostConnection>();
	#connecting = new Map<string, Promise<boolean>>();
	#probing = new Set<string>();
	#listeners = new Set<Listener>();
	#keepalive: ReturnType<typeof setInterval> | undefined;

	state(id: string): SshState {
		return this.states[id] ?? DISCONNECTED;
	}

	/** Hears every state change of every host. */
	onChange(fn: Listener): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	#host(id: string): HostConnection {
		let h = this.#hosts.get(id);
		if (!h) {
			h = new HostConnection({
				probe: (interactive) => invoke<void>('ssh_connect', { id, interactive }),
				now: () => Date.now(),
				setTimer: (run, ms) => setTimeout(run, ms),
				clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
				sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
				publish: (state) => {
					const previous = this.state(id);
					this.states[id] = state;
					for (const fn of this.#listeners) fn(id, state, previous);
				}
			});
			this.#hosts.set(id, h);
		}
		return h;
	}

	/**
	 * Connects host `id`; one dial at a time per host, whoever asks (Orca's shared in-flight
	 * connect). `user`: the user asked, so a passphrase may be asked and a Disconnect is lifted.
	 */
	connect(id: string, user = true): Promise<boolean> {
		const running = this.#connecting.get(id);
		if (running) return running;
		const p = this.#host(id)
			.connect(user)
			.finally(() => this.#connecting.delete(id));
		this.#connecting.set(id, p);
		return p;
	}

	/** Disconnect: closes the shared connection and stops redialling until the user connects again. */
	async disconnect(id: string) {
		this.#host(id).disconnect();
		await invoke('ssh_disconnect', { id }).catch(() => {});
	}

	/**
	 * A command on the host just failed. That says nothing by itself (git may have refused), so a
	 * connected host is probed once: no answer is a drop, and the ladder takes over.
	 */
	async suspect(id: string) {
		const h = this.#host(id);
		if (h.state.status !== 'connected' || this.#probing.has(id)) return;
		this.#probing.add(id);
		try {
			// The keepalive's own probe: one interval to answer (a dial gets Orca's 30 s).
			await invoke('ssh_keepalive', { id });
		} catch {
			h.dropped();
		} finally {
			this.#probing.delete(id);
		}
	}

	forget(id: string) {
		this.#hosts.get(id)?.disconnect();
		this.#hosts.delete(id);
		delete this.states[id];
	}

	install(): () => void {
		this.#keepalive = setInterval(() => {
			for (const id of this.#hosts.keys()) void this.suspect(id);
		}, KEEPALIVE_MS);
		// Orca `retryAfterNetworkReturn` (its powerMonitor resume / online signals).
		const back = () => {
			for (const h of this.#hosts.values()) h.networkReturned();
		};
		window.addEventListener('online', back);
		return () => {
			clearInterval(this.#keepalive);
			window.removeEventListener('online', back);
		};
	}
}

export const sshConnections = new SshConnections();
