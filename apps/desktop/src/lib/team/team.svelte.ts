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
import { buildTaskSync, teamStatusLabel, type TeamStatus, type TeamTaskInput } from './team';

type SignedIn = { server: string; org_id: string; org_name: string; user_id: string; role: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

class Team {
	status = $state<TeamStatus | null>(null);
	/** The sign-in dialog is open. */
	signingIn = $state(false);

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
			this.status = { server: serverUrl, signed_in: false, online: false, pending: 0, last_error: message(e) };
		}
	}

	startSignIn() {
		if (!this.serverUrl) {
			statusBar.flash('ตั้งค่า kingu.team.serverUrl ก่อนลงชื่อเข้าใช้ทีม');
			systemSettings.show('Team');
			return;
		}
		this.signingIn = true;
	}

	/** Verifies the token with the server and stores it in the Keychain. Throws a Thai message on failure. */
	async signIn(token: string): Promise<SignedIn> {
		const me = await invoke<SignedIn>('team_sign_in', { serverUrl: this.serverUrl, token });
		await this.refresh();
		statusBar.flash(`ลงชื่อเข้าใช้ทีม ${me.org_name} เป็น ${me.user_id} แล้ว`);
		return me;
	}

	async signOut() {
		try {
			await invoke('team_sign_out', { serverUrl: this.serverUrl });
			statusBar.flash('ออกจากระบบทีมแล้ว (ลบ token จาก Keychain)');
		} catch (e) {
			statusBar.error(`ออกจากระบบทีมไม่สำเร็จ: ${message(e)}`);
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
			statusBar.error(`ซิงก์งานไปยังทีมไม่ได้: ${message(e)}`);
		}
	}

	/** Status bar click: sign in when signed out, else a small menu. */
	showMenu() {
		if (!this.status?.signed_in) return this.startSignIn();
		quick.pick({
			placeholder: `ทีม — ${this.status.server}`,
			items: [
				{ id: 'sync', label: 'ซิงก์ตอนนี้', description: this.status.pending ? `รอส่ง ${this.status.pending}` : undefined },
				{ id: 'signin', label: 'ลงชื่อเข้าใช้ด้วย token ใหม่' },
				{ id: 'signout', label: 'ออกจากระบบทีม' }
			],
			onAccept: (item) => {
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
		let unlisten: (() => void) | undefined;
		listen<TeamStatus>('team://status', (e) => {
			if (this.status && e.payload.server === this.status.server) this.status = e.payload;
		})
			.then((u) => (disposed ? u() : (unlisten = u)))
			.catch(() => {});
		return () => {
			disposed = true;
			unlisten?.();
			unregister.forEach((u) => u());
		};
	}
}

export const team = new Team();
