// Browser tools for an agent on an SSH host (Rust ssh_browser_relay.rs, kingu-ptyd
// browser_relay.rs; Orca 1.4.272's desktop browser bridge): before the host's agent opens a page or
// loads an address in Kingu's browser, the window asks (`browser.relayGrant`, through the `kingu`
// request bridge, cliBridge.svelte.ts). VS Code's grants for its browser tools, with "Allow for
// This Run" in place of its session scope: it lasts until the user presses Stop on a page of the
// run. The pure part; the native message box asks.

import { messageBox } from '#lib/workbench/messageBox.ts';
import { t } from '#lib/i18n/index.ts';

/** Rust `ssh_browser_relay::GRANT_METHOD`. */
export const RELAY_GRANT_METHOD = 'browser.relayGrant';

/** What Rust asks with. */
export type RelayGrantRequest = { host: string; url: string; kind: 'open' | 'navigate'; run: string };
/** Rust `Grant::answer`: anything but `once` or `run` declines. */
export type RelayGrantAnswer = 'once' | 'run' | 'deny';

/** The buttons, left to right; Escape (the last) declines. */
export const RELAY_GRANT_ANSWERS: readonly RelayGrantAnswer[] = ['once', 'run', 'deny'];

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function relayGrantPrompt(p: Partial<RelayGrantRequest>, tr: Translate) {
	const host = String(p.host ?? '');
	const url = String(p.url ?? '');
	const open = p.kind !== 'navigate';
	return {
		title: tr(open ? 'agentBrowser.ssh.openTitle' : 'agentBrowser.ssh.navigateTitle'),
		message: tr(open ? 'agentBrowser.ssh.openMessage' : 'agentBrowser.ssh.navigateMessage', { host, url, run: String(p.run ?? '') }),
		buttons: [tr('agentBrowser.ssh.allowOnce'), tr('agentBrowser.ssh.allowRun'), tr('agentBrowser.ssh.deny')]
	};
}

/** The pressed button's answer (Escape or an unknown index declines). */
export function relayGrantAnswer(index: number | null | undefined): RelayGrantAnswer {
	return (typeof index === 'number' && RELAY_GRANT_ANSWERS[index]) || 'deny';
}

/** Asks the user; the reply Rust waits for. */
export async function askRelayGrant(params: unknown): Promise<{ answer: RelayGrantAnswer }> {
	const p = relayGrantPrompt((params ?? {}) as Partial<RelayGrantRequest>, t as Translate);
	const index = await messageBox(p.message, { title: p.title, kind: 'warning', buttons: p.buttons, cancelId: 2 });
	return { answer: relayGrantAnswer(index) };
}

