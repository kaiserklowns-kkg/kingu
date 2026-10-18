// Team sync service: status for the status bar, sign-in, and `syncTask` for whoever owns task
// state (agent panel / ADE board) to call when a task changes. The token goes straight to Rust,
// which keeps it in the macOS Keychain; it is never stored in settings or localStorage.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status as statusBar } from '#lib/workbench/status.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
import { buildRunSync, buildTaskSync, streamLabel, teamStatusLabel, type TeamRunInput, type TeamStatus, type TeamTaskInput } from './team';
import type { TeamEvent } from './teamEvents.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';

type SignedIn = { server: string; org_id: string; org_name: string; user_id: string; role: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

class Team {
	status = $state<TeamStatus | null>(null);
	/** The sign-in dialog is open. */
	signingIn = $state(false);
	#eventHandlers = new Set<(e: TeamEvent) => void>();
	/** The server the event stream was last asked for ('' = stopped). */
	#streaming = '';

	get serverUrl(): string {
		return (settings.get<string>('kingu.team.serverUrl') ?? '').trim();
	}

	get project(): string {
		return (settings.get<string>('kingu.team.project') ?? '').trim();
	}

	readonly label = $derived(teamStatusLabel(this.serverUrl, this.status));

	async refresh() {
		const serverUrl = this.serverUrl;
		if (!serverUrl) return void (this.status = null);
		try {
			this.status = await invoke<TeamStatus>('team_status', { serverUrl });
		} catch (e) {
			this.status = { server: serverUrl, signed_in: false, online: false, pending: 0, last_error: message(e), stream: 'off' };
		}
	}

	startSignIn() {
		if (!this.serverUrl) {
			statusBar.flash(t('team.team.needsServer'));
			systemSettings.show('Team');
			return;
		}
		this.signingIn = true;
	}

	/** Verifies the token with the server and stores it in the Keychain. Throws the server's message on failure. */
	async signIn(token: string): Promise<SignedIn> {
		const me = await invoke<SignedIn>('team_sign_in', { serverUrl: this.serverUrl, token });
		await this.refresh();
		statusBar.flash(t('team.team.signedIn', { org: me.org_name, user: me.user_id }));
		return me;
	}

	async signOut() {
		try {
			await invoke('team_sign_out', { serverUrl: this.serverUrl });
			statusBar.flash(t('team.team.signedOut'));
		} catch (e) {
			notifications.error(t('team.team.signOutFailed', { error: message(e) }));
		}
		await this.refresh();
	}

	/**
	 * Call when a task's status (or branch/agent/diff stats) changes. No-op until both
	 * `kingu.team.serverUrl` and `kingu.team.project` are set. Delivery is durable and retried.
	 */
	async syncTask(task: TeamTaskInput): Promise<void> {
		const { serverUrl, project } = this;
		if (!serverUrl || !project) return;
		try {
			const pending = await invoke<number>('team_sync_task', { serverUrl, project, task: buildTaskSync(task) });
			if (this.status) this.status = { ...this.status, pending };
		} catch (e) {
			notifications.error(t('team.team.syncTaskFailed', { error: message(e) }));
		}
	}

	/**
	 * Call when a run's turn finishes or the run ends: its timings, tokens and cost (never the
	 * transcript). Same no-op and delivery rules as `syncTask`; the server keeps one row per run.
	 */
	async syncRun(input: TeamRunInput): Promise<void> {
		const { serverUrl, project } = this;
		const run = buildRunSync(input);
		if (!serverUrl || !project || !run) return;
		try {
			const pending = await invoke<number>('team_sync_run', { serverUrl, project, run });
			if (this.status) this.status = { ...this.status, pending };
		} catch (e) {
			notifications.error(t('team.team.syncRunFailed', { error: message(e) }));
		}
	}

	/** Live updates (`team://event`) for the current server. Returns an unsubscribe. */
	onEvent(fn: (e: TeamEvent) => void): () => void {
		this.#eventHandlers.add(fn);
		return () => this.#eventHandlers.delete(fn);
	}

	/** Runs the Rust event stream for `server` (normalized, from the status), or stops it for ''. */
	syncStream(server: string) {
		if (server === this.#streaming) return;
		this.#streaming = server;
		const done = server ? invoke('team_events_start', { serverUrl: server }) : invoke('team_events_stop');
		done.catch((e) => {
			this.#streaming = '';
			notifications.error(t('team.team.streamFailed', { error: message(e) }));
		});
	}

	/** Status bar click: sign in when signed out, else a small menu. */
	showMenu() {
		if (!this.status?.signed_in) return this.startSignIn();
		quick.pick({
			placeholder: t('team.team.menuPlaceholder', { server: this.status.server }),
			items: [
				{ id: 'sync', label: t('team.team.syncNow'), description: this.status.pending ? t('team.team.pendingShort', { count: this.status.pending }) : undefined },
				{ id: 'live', label: t('team.team.liveUpdates'), description: streamLabel(this.status.stream) },
				{ id: 'signin', label: t('team.team.signInNewToken') },
				{ id: 'signout', label: t('team.team.signOut') }
			],
			onAccept: (item) => {
				if (item.id === 'live') return;
				if (item.id === 'sync') void invoke('team_sync_now');
				else if (item.id === 'signin') this.startSignIn();
				else void this.signOut();
			}
		});
	}

	/** Registers commands and the Rust status listener. Returns a disposer. */
	install(): () => void {
		const unregister = [
			commands.register({ id: 'kingu.team.signIn', title: 'Sign in to Team Server', category: 'Kingu', run: () => this.startSignIn() }),
			commands.register({ id: 'kingu.team.signOut', title: 'Sign out of Team Server', category: 'Kingu', when: () => !!this.status?.signed_in, run: () => this.signOut() }),
			commands.register({ id: 'kingu.team.syncNow', title: 'Sync Tasks to Team Server Now', category: 'Kingu', when: () => !!this.status?.signed_in, run: () => invoke('team_sync_now') })
		];
		let disposed = false;
		const unlisten: (() => void)[] = [];
		const keep = (p: Promise<() => void>) => p.then((u) => (disposed ? u() : unlisten.push(u))).catch(() => {});
		keep(
			listen<TeamStatus>('team://status', (e) => {
				if (this.status && e.payload.server === this.status.server) this.status = e.payload;
			})
		);
		keep(
			listen<TeamEvent>('team://event', (e) => {
				if (e.payload.server !== this.status?.server) return;
				for (const fn of this.#eventHandlers) fn(e.payload);
			})
		);
		return () => {
			disposed = true;
			unlisten.forEach((u) => u());
			this.syncStream('');
			unregister.forEach((u) => u());
		};
	}
}

export const team = new Team();
