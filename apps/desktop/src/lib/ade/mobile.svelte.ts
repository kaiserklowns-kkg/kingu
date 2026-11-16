// Mobile pairing (Orca's Mobile page, src/renderer/src/components/mobile/MobilePage.tsx): turn
// phone access on, generate a single-use code shown as a QR code, list paired devices with Revoke.
// Rust mobile.rs runs the server; a phone's message for a task arrives here as `mobile:request`
// and goes to the task's agent like a follow-up typed in Kingu.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { t } from '#lib/i18n/index.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { ask } from '#lib/workbench/messageBox.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status as statusBar } from '#lib/workbench/status.svelte.ts';
import { listenWindow } from '#lib/workbench/windowEvents.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { adeTasks } from './tasks.svelte';
import { cliSessions } from './cliSessions.svelte';
import { runtime } from './runtime.svelte';
import { isIpv4, liveRow, refreshDue, sortDevices, LIVE_HEARTBEAT_MS, type LiveTask, type MobileAnswer, type MobileStatus, type Pairing } from './mobile';

type MobileRequest = { id: number; root: string; slug: string; text: string; answer?: MobileAnswer };

class MobilePairing {
	open = $state(false);
	status = $state<MobileStatus | null>(null);
	pairing = $state<Pairing | null>(null);
	/** The address picked in the dialog; null: Rust's default (Orca's auto-advertised address). */
	address = $state<string | null>(null);
	busy = $state(false);
	error = $state<string | null>(null);
	now = $state(Date.now());
	/** Devices when the current code was made: a new one means the phone just paired. */
	#devicesAtCode = 0;

	get devices() {
		return sortDevices(this.status?.devices ?? []);
	}

	get justPaired(): boolean {
		return !!this.pairing && this.devices.length > this.#devicesAtCode;
	}

	async show() {
		this.open = true;
		this.pairing = null;
		await this.refresh();
	}

	close() {
		this.open = false;
		this.pairing = null;
	}

	async refresh() {
		try {
			this.status = await invoke<MobileStatus>('mobile_status');
		} catch (e) {
			this.error = String(e);
		}
	}

	async setEnabled(enabled: boolean) {
		this.busy = true;
		this.error = null;
		try {
			this.status = await invoke<MobileStatus>('mobile_set_enabled', { enabled });
			if (!enabled) this.pairing = null;
		} catch (e) {
			this.error = t('mobile.startFailed', { error: String(e) });
			await this.refresh();
		} finally {
			this.busy = false;
		}
	}

	/** Orca `mobile:getPairingQR`: the current code (reused while it has over a minute left), or a new one. */
	async generate(rotate = false) {
		this.busy = true;
		this.error = null;
		try {
			this.pairing = await invoke<Pairing>('mobile_pairing', { address: this.address, rotate });
			this.#devicesAtCode = this.status?.devices.length ?? 0;
		} catch (e) {
			this.error = String(e);
		} finally {
			this.busy = false;
		}
	}

	async pickAddress(value: string) {
		if (value === '__custom__') {
			const typed = await quick.input({ placeholder: '192.168.1.20', hint: (v) => (isIpv4(v) ? v.trim() : t('mobile.customPrompt')) });
			if (!typed || !isIpv4(typed)) return;
			value = typed.trim();
		}
		this.address = value || null;
		if (this.pairing) await this.generate(false);
	}

	/** Called every second while the dialog is open: replaces a code about to expire. */
	tick() {
		this.now = Date.now();
		if (this.pairing && !this.busy && refreshDue(this.pairing.expires_at, this.now)) void this.generate(false);
	}

	async copyLink() {
		if (!this.pairing) return;
		try {
			await navigator.clipboard.writeText(this.pairing.url);
			statusBar.flash(t('mobile.copied'));
		} catch (e) {
			notifications.error(e);
		}
	}

	async revoke(id: string, name: string) {
		if (!(await ask(t('mobile.revokeConfirm', { name }), { okLabel: t('mobile.revoke'), kind: 'warning' }))) return;
		try {
			await invoke('mobile_revoke', { id });
			statusBar.flash(t('mobile.revoked'));
		} catch (e) {
			notifications.error(t('mobile.revokeFailed', { error: String(e) }));
		}
		await this.refresh();
	}
}

export const mobilePairing = new MobilePairing();

/** A message from the phone for a task of this window's folder. */
async function onRequest(req: MobileRequest) {
	let error: string | null = null;
	const a = req.answer;
	if (req.root !== workspace.root) error = t('mobile.notThisWindow');
	else if (a) {
		const ok = a.kind === 'question' ? await cliSessions.answer(req.slug, a.selections ?? []) : await cliSessions.answerPermission(req.slug, a.kind === 'allow');
		if (!ok) error = t('mobile.answerFailed');
	} else if (!(await adeTasks.followUp(req.slug, req.text))) error = t('mobile.sendFailed', { slug: req.slug });
	await invoke('mobile_reply', { id: req.id, error }).catch(() => {});
}

/** The open folder's agent states, as the phone sees them (Orca's phone reads the live agent store, not the saved list). */
function liveRows(): LiveTask[] {
	const now = Date.now();
	return Object.keys(cliSessions.sessions).flatMap((slug) => {
		const r = runtime.get(slug);
		return r ? [liveRow(slug, { ...r, ask: cliSessions.hooks[slug]?.ask }, now)] : [];
	});
}

/** Pushes the live rows to Rust while mobile access is on: on change (debounced) and every 10 s. */
function installLivePush(): () => void {
	let on = false;
	let last = '';
	let timer: ReturnType<typeof setTimeout> | undefined;
	const push = (force: boolean) => {
		const root = workspace.root;
		if (!on || !root) return;
		const tasks = liveRows();
		const text = JSON.stringify([root, tasks.map((x) => ({ ...x, at: 0 }))]);
		if (!force && text === last) return;
		last = text;
		void invoke('mobile_live', { root, tasks }).catch(() => {});
	};
	const check = () =>
		void invoke<MobileStatus>('mobile_status')
			.then((s) => {
				on = s.running;
				push(true);
			})
			.catch(() => {});
	check();
	const stopEffect = $effect.root(() => {
		$effect(() => {
			// Read what the rows depend on; the push itself runs a moment later, outside the effect.
			void JSON.stringify(liveRows());
			clearTimeout(timer);
			timer = setTimeout(() => push(false), 300);
		});
	});
	const beat = setInterval(() => push(true), LIVE_HEARTBEAT_MS);
	const unlisten = listen('mobile:changed', check);
	return () => {
		stopEffect();
		clearTimeout(timer);
		clearInterval(beat);
		void unlisten.then((u) => u()).catch(() => {});
	};
}

export function installMobile(): () => void {
	const unlisten: Array<() => void> = [];
	let disposed = false;
	unlisten.push(installLivePush());
	const keep = (p: Promise<() => void>) => void p.then((u) => (disposed ? u() : unlisten.push(u))).catch(() => {});
	keep(listenWindow<MobileRequest>('mobile:request', (e) => void onRequest(e.payload)));
	keep(listen('mobile:changed', () => void (mobilePairing.open && mobilePairing.refresh())));
	keep(listen<number>('mobile:auth-failures', (e) => notifications.warn(t('mobile.authFailures', { count: e.payload }))));
	const unregister = [commands.register({ id: 'kingu.mobile.pair', title: 'Mobile: Pair Device…', category: 'Mobile', run: () => void mobilePairing.show() })];
	return () => {
		disposed = true;
		unlisten.forEach((u) => u());
		unregister.forEach((u) => u());
	};
}
