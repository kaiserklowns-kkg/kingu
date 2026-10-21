// Live usage state, refreshed like Orca's rate-limit service: a fetch shortly after start, every
// 15 minutes while the window is focused, on focus when data is 5 minutes old, errors retried
// with backoff, recent windows kept through a failed refresh. A running Claude Code's
// `rate_limit_event` counts as a live reading and skips scheduled Claude fetches for 5 minutes.
//   usage.start()       returns a stop function
//   usage.refresh()     forced fetch of every detected provider (the refresh buttons)
//   usage.providers     ProviderState per provider (null until first read)
//   usage.detected      agent CLIs installed (null until known)

import { invoke } from '@tauri-apps/api/core';
import { accounts } from '#lib/accounts/accounts.svelte.ts';
import { agents } from '#lib/agent/agents.svelte.ts';
import { chats } from '#lib/agent/chats.svelte.ts';
import { adeTasks } from '#lib/ade/tasks.svelte.ts';
import { clientLog } from '#lib/client-log.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { ACCOUNT_PROVIDERS, activeProviders, applyStale, backoff, fromAccountRow, LIVE_FRESH_MS, nextTick, parseLiveLimit, POLL_MS, PROVIDERS, spend, STALE_AFTER_MS, windowsOf, type ProviderId, type ProviderState } from './usage';

class Usage {
	now = $state(Date.now());
	providers = $state<Record<ProviderId, ProviderState | null>>({ claude: null, codex: null, gemini: null });
	detected = $state<ProviderId[] | null>(null);
	refreshing = $state(false);
	anyFetching = $derived(PROVIDERS.some((p) => this.providers[p]?.status === 'fetching'));
	spend = $derived(spend(adeTasks.list.map((t) => ({ slug: t.slug, title: t.title, last_run: t.last_run })), this.now));

	#streak: Record<ProviderId, number> = { claude: 0, codex: 0, gemini: 0 };
	#retryAt: Record<ProviderId, number> = { claude: 0, codex: 0, gemini: 0 };
	#liveAt = 0;
	#running: Promise<void> | null = null;
	#again = false;

	/** Detected providers, or all while detection has not answered (Orca's "unknown" gate); Gemini when kingu.usage.gemini is on. */
	get active(): ProviderId[] {
		return activeProviders(this.detected, settings.get<boolean>('kingu.usage.gemini') === true);
	}

	/** `p`'s reading from the accounts service's last refresh (its active account). */
	#read(p: ProviderId) {
		const prev = this.providers[p];
		const row = accounts.rows.find((r) => r.provider === p && r.active) ?? accounts.rows.find((r) => r.provider === p);
		if (!row) {
			this.providers[p] = prev ?? { ...empty(p), status: 'unavailable' };
			return;
		}
		this.#apply(p, fromAccountRow(row));
	}

	/** `next` as `p`'s reading, keeping recent windows through a failure, with the error backoff. */
	#apply(p: ProviderId, next: ProviderState) {
		const prev = this.providers[p];
		const now = Date.now();
		this.providers[p] = applyStale(prev, next, now);
		if (next.status === 'error') {
			this.#streak[p]++;
			this.#retryAt[p] = now + backoff(this.#streak[p]);
		} else {
			this.#streak[p] = 0;
			this.#retryAt[p] = 0;
		}
	}

	/** One refresh of the accounts service (Rust decides what is due), then each provider's reading. */
	async #fetchProviders(list: ProviderId[], force: boolean) {
		if (!list.length) return;
		for (const p of list) if (!this.providers[p] || this.providers[p].status === 'idle') this.providers[p] = { ...(this.providers[p] ?? empty(p)), status: 'fetching' };
		const viaAccounts = list.filter((p) => ACCOUNT_PROVIDERS.includes(p));
		const gemini = list.includes('gemini') ? invoke<ProviderState>('usage_fetch', { provider: 'gemini' }).then((u) => this.#apply('gemini', { ...u, source: 'api' }), (e) => clientLog('error', `usage gemini: ${e}`)) : null;
		if (viaAccounts.length) {
			try {
				await accounts.refresh(force);
			} catch (e) {
				clientLog('error', `usage: ${e}`);
			}
			for (const p of viaAccounts) this.#read(p);
		}
		await gemini;
	}

	/** Every detected provider; scheduled fetches skip a fresh live Claude reading and active retry waits. */
	async #fetchAll(force: boolean, only?: ProviderId[]) {
		if (this.#running) {
			this.#again ||= force;
			return this.#running;
		}
		this.#running = (async () => {
			do {
				const now = Date.now();
				const list = (only ?? this.active).filter((p) => force || (!(p === 'claude' && now - this.#liveAt < LIVE_FRESH_MS) && now >= this.#retryAt[p]));
				await this.#fetchProviders(list, force);
				only = undefined;
				force = this.#again;
				this.#again = false;
			} while (force);
			this.#running = null;
		})();
		return this.#running;
	}

	async refresh() {
		if (this.refreshing) return;
		this.refreshing = true;
		try {
			await Promise.all([this.#fetchAll(true), this.#detect()]);
		} finally {
			this.refreshing = false;
		}
	}

	/** On start and focus: a full fetch when anything is missing or 5 minutes old, else retry failures. */
	#refreshIfActive() {
		if (!windowActive()) return;
		const now = Date.now();
		const due = this.active.some((p) => {
			const s = this.providers[p];
			return !s || s.status === 'idle' || s.status === 'fetching' || ((s.status === 'ok' || s.status === 'unavailable') && now - s.updatedAt >= STALE_AFTER_MS);
		});
		if (due) return void this.#fetchAll(false);
		const failed = this.active.filter((p) => this.providers[p]?.status === 'error' && now >= this.#retryAt[p]);
		if (failed.length) void this.#fetchAll(false, failed);
	}

	async #detect() {
		try {
			this.detected = (await invoke<string[]>('usage_detect')).filter((p): p is ProviderId => (PROVIDERS as string[]).includes(p));
		} catch {
			this.detected = null;
		}
	}

	/** A running Claude Code reported a window: newer than any fetch, so it replaces that window. */
	#ingestLive(line: string) {
		const live = parseLiveLimit(line);
		if (!live) return;
		const now = Date.now();
		const prev = this.providers.claude ?? empty('claude');
		this.providers.claude = { ...prev, [live.key]: live.window, status: 'ok', error: null, failureKind: null, updatedAt: now, source: 'live-session' };
		this.#liveAt = now;
	}

	start(): () => void {
		void this.#detect();
		const first = setTimeout(() => this.#refreshIfActive(), 1000);
		const poll = setInterval(() => windowActive() && void this.#fetchAll(false), POLL_MS);
		const onFocus = () => this.#refreshIfActive();
		window.addEventListener('focus', onFocus);
		const offTaskEvents = agents.onEvent((_, ev) => ev.kind === 'raw' && this.#ingestLive(ev.line));
		const offChatEvents = chats.onEvent((_, ev) => ev.kind === 'raw' && this.#ingestLive(ev.line));
		const offEvents = () => (offTaskEvents(), offChatEvents());
		// Countdowns change on the minute (hourly beyond a day); tick exactly then.
		let tick: ReturnType<typeof setTimeout>;
		const schedule = () => {
			const resets = PROVIDERS.flatMap((p) => windowsOf(this.providers[p]).map((w) => w.window.resetsAt));
			tick = setTimeout(() => ((this.now = Date.now()), schedule()), nextTick(resets, Date.now()));
		};
		schedule();
		return () => {
			clearTimeout(first);
			clearInterval(poll);
			clearTimeout(tick);
			window.removeEventListener('focus', onFocus);
			offEvents();
		};
	}
}

function empty(p: ProviderId): ProviderState {
	return { provider: p, status: 'idle', session: null, weekly: null, planType: null, error: null, failureKind: null, retryAtMs: null, updatedAt: 0 };
}

const windowActive = () => document.visibilityState === 'visible' && document.hasFocus();

export const usage = new Usage();
