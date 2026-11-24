// The terminal holder of each SSH host (Rust ssh_holder.rs; sshHolder.ts has the state machine):
// looked for once per connection, installed when this build carries the host's binary and the user
// said yes for that host (asked the first time, kept per host, changed in SSH: Hosts…), and asked
// again after a reconnect. Once it is in use, the host's older holder folders nothing runs from go. Also the permission-hold script a claude on the host waits in, and the
// held sessions Kingu started, remembered so their tabs can be opened again after a restart.
import { invoke } from '@tauri-apps/api/core';
import { settings } from '#lib/settings/settings.svelte.ts';
import { HOLDER_UNKNOWN, ensureHolder, holderId, liveRecords, parseConsents, parseRecords, type Consent, type ConsentAnswer, type Holder, type HeldRecord, type HolderState } from './sshHolder';

const STORE_KEY = 'kingu.ssh.heldSessions';
const CONSENT_KEY = 'kingu.ssh.holderConsent';

/** Asks the user whether to install on the host (sshProjects shows the question). */
export type ConsentAsk = (q: { platform: string; size: number }) => Promise<ConsentAnswer | null>;

function readConsents(): Record<string, Consent> {
	try {
		return parseConsents(localStorage.getItem(CONSENT_KEY));
	} catch {
		return {};
	}
}

export type HeldSession = { key: string; cwd: string; alive: boolean; command: string | null };

class SshHolders {
	states = $state<Record<string, HolderState>>({});
	#checking = new Map<string, Promise<HolderState>>();
	#hold = new Map<string, Promise<boolean>>();
	/** The kept answers per host, and the hosts told Not now in this run. */
	consents = $state<Record<string, Consent>>(readConsents());
	later = $state<Record<string, true>>({});
	#pruned = new Set<string>();

	state(host: string): HolderState {
		return this.states[host] ?? HOLDER_UNKNOWN;
	}

	consent(host: string): Consent | 'later' | null {
		return this.consents[host] ?? (this.later[host] ? 'later' : null);
	}

	/** SSH: Hosts…: a kept answer changed (`null`: ask again). The holder is looked for anew. */
	setConsent(host: string, c: Consent | null) {
		const next = { ...readConsents() };
		if (c) next[host] = c;
		else delete next[host];
		try {
			localStorage.setItem(CONSENT_KEY, JSON.stringify(next));
		} catch {
			// No storage: the answer holds for this run.
		}
		this.consents = next;
		delete this.later[host];
		delete this.states[host];
	}

	#remember(host: string, a: ConsentAnswer) {
		if (a === 'later') this.later[host] = true;
		else this.setConsent(host, a === 'install' ? 'allow' : 'never');
	}

	/**
	 * The host's holder, found or installed now; one check at a time per host, kept until the host
	 * drops. `ask`: the user is starting something there, so a host with no answer yet is asked.
	 */
	ensure(host: string, ask?: ConsentAsk): Promise<HolderState> {
		const known = this.states[host];
		const waiting = known?.phase === 'consent' && !!ask && this.consent(host) === null;
		if (known && !waiting && known.phase !== 'unknown' && known.phase !== 'checking' && known.phase !== 'installing') return Promise.resolve(known);
		const running = this.#checking.get(host);
		if (running) return running;
		const p = ensureHolder({
			enabled: () => settings.get<boolean>('kingu.ssh.terminalHost') !== false,
			probe: () => invoke<Holder>('ssh_holder_probe', { id: host }),
			install: () => invoke<Holder>('ssh_holder_install', { id: host }),
			publish: (s) => (this.states[host] = s),
			consent: () => this.consent(host),
			...(ask ? { ask } : {}),
			remember: (a) => this.#remember(host, a)
		})
			.then((s) => {
				if (s.phase === 'ready') void this.#prune(host, s.id!);
				return s;
			})
			.finally(() => this.#checking.delete(host));
		this.#checking.set(host, p);
		return p;
	}

	/** Older holder folders on the host that nothing runs from go, once per connection (Orca prunes after an update and again on later connects). */
	async #prune(host: string, holder: string) {
		if (this.#pruned.has(host)) return;
		this.#pruned.add(host);
		await invoke('ssh_holder_prune', { id: host, holder }).catch(() => this.#pruned.delete(host));
	}

	/** The holder's id when the host holds terminals, else null (after `ensure`). */
	id(host: string): string | null {
		return holderId(this.states[host]);
	}

	/** The permission-hold script is on the host (written once per connection); false: answers go by keys. */
	hold(host: string): Promise<boolean> {
		let p = this.#hold.get(host);
		if (!p) {
			p = invoke('ssh_remote_hold_setup', { id: host }).then(
				() => true,
				() => {
					this.#hold.delete(host);
					return false;
				}
			);
			this.#hold.set(host, p);
		}
		return p;
	}

	/** The host dropped or its setting changed: everything is asked again on the next connection. */
	forget(host: string) {
		delete this.states[host];
		this.#hold.delete(host);
		this.#pruned.delete(host);
	}

	forgetAll() {
		for (const host of Object.keys(this.states)) this.forget(host);
	}

	// --- held sessions Kingu started ---------------------------------------------------------

	records(): Record<string, HeldRecord> {
		try {
			return parseRecords(localStorage.getItem(STORE_KEY));
		} catch {
			return {};
		}
	}

	#save(records: Record<string, HeldRecord>) {
		try {
			localStorage.setItem(STORE_KEY, JSON.stringify(records));
		} catch {
			// No storage: a held session can still be reattached by its key, without its name.
		}
	}

	remember(key: string, record: HeldRecord) {
		this.#save({ ...this.records(), [key]: record });
	}

	forgetSession(key: string) {
		const { [key]: _gone, ...rest } = this.records();
		this.#save(rest);
	}

	/** The sessions the host's daemon holds now; records of ended ones are dropped. */
	async sessions(host: string): Promise<HeldSession[]> {
		const holder = this.id(host);
		if (!holder) return [];
		const list = await invoke<HeldSession[]>('ssh_holder_sessions', { id: host, holder });
		this.#save(liveRecords(this.records(), host, list.filter((s) => s.alive).map((s) => s.key)));
		return list.filter((s) => s.alive);
	}

	end(host: string, holder: string, key: string) {
		this.forgetSession(key);
		return invoke('ssh_holder_end', { id: host, holder, key }).catch(() => {});
	}
}

export const sshHolders = new SshHolders();
