// Orca's codexSharedServerWarning: a codex you typed into a terminal yourself that joined Codex's
// shared app-server is warned about once per session (its agent status may be wrong and it ends
// with the server). Orca shows a banner on the pane; Kingu shows one native message box, whose
// "Don't Show Again" turns kingu.codex.sharedServerWarning off. Tasks Kingu starts get
// `--no-daemon` instead (codexServer.ts), so they never join.

import { invoke } from '@tauri-apps/api/core';
import { t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { messageBox } from '#lib/workbench/messageBox.ts';
import { checkDue, nextWatch, warningOn, WARNING_SETTING, type Watch } from './codexServer.ts';

type Listing = { key: string; alive: boolean; elsewhere?: boolean; foreground?: { pid: number; name: string } | null };

const POLL_MS = 2_000;

export function installCodexSharedServerWarning(): () => void {
	// The foreground job is not known on Windows, and Codex keeps no socket there.
	if (typeof navigator !== 'undefined' && /win/i.test(navigator.platform)) return () => {};
	const watches = new Map<string, Watch>();
	/** `key:pid` already warned (or dismissed) this app session. */
	const warned = new Set<string>();
	let busy = false;

	async function warn(key: string, pid: number) {
		warned.add(`${key}:${pid}`);
		const never = t('ade.codexServer.dontShowAgain');
		const pressed = await messageBox(t('ade.codexServer.sharedBody'), { title: t('ade.codexServer.sharedTitle'), kind: 'warning', buttons: [t('common.ok'), never], cancelId: 0 });
		if (pressed === 1) await settings.set(WARNING_SETTING, false, 'user');
	}

	async function poll() {
		if (busy || !warningOn((k) => settings.get(k)) || document.visibilityState !== 'visible') return;
		busy = true;
		try {
			const list = await invoke<Listing[]>('pty_list').catch(() => null);
			if (!list) return;
			const now = Date.now();
			const live = new Set<string>();
			for (const s of list) {
				if (!s.alive || s.elsewhere) continue;
				live.add(s.key);
				const w = nextWatch(watches.get(s.key), s.foreground, now);
				if (!w) {
					watches.delete(s.key);
					continue;
				}
				watches.set(s.key, w);
				if (warned.has(`${s.key}:${w.pid}`) || !checkDue(w, now)) continue;
				w.checks++;
				if (await invoke<boolean>('codex_shared_server_joined', { pid: w.pid }).catch(() => false)) {
					w.done = true;
					void warn(s.key, w.pid);
				}
			}
			for (const k of watches.keys()) if (!live.has(k)) watches.delete(k);
		} finally {
			busy = false;
		}
	}

	const timer = setInterval(() => void poll(), POLL_MS);
	return () => clearInterval(timer);
}
