// Agent browser use in the window (Rust floating_browser/agent.rs; the pure part is agentBrowser.ts):
//   agentBrowser.enabled            `kingu.browser.agentTools`
//   agentBrowser.indicator(label)   what the tab shows while agents may use it (BrowserSurface)
//   agentBrowser.share / stop       VS Code's Share with Agent (asked first) and Stop
//   agentBrowser.showLog(label)     Kingu's action log of the page: Replay, Copy as JSON
//   agentBrowser.capture(label)     VS Code's Add Screenshot to Chat (the chat panel takes it)
//   agentBrowser.surfaces           the open browser tabs, for Add Context's Browser Screenshot

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { settings } from '#lib/settings/settings.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { ask } from './messageBox';
import { notifications } from './notifications.svelte';
import { quick } from './quick.svelte';
import { status } from './status.svelte';
import { commands } from './commands.svelte';
import { AGENT_BROWSER_SETTING, indicatorOf, logJson, logRow, replaySteps, type AgentBrowserEvent, type AgentLogEntry, type AgentPage, type Indicator } from './agentBrowser';

class AgentBrowser {
	enabled = $derived(settings.get<boolean>(AGENT_BROWSER_SETTING) === true);
	pages = $state<Record<string, AgentPage>>({});
	actions = $state<Record<string, string | null>>({});
	/** The open browser tabs (label → address and title), for Add Context's Browser Screenshot. */
	surfaces = $state<Record<string, { url: string; title: string }>>({});
	/** Screenshots waiting for the chat panel (Add Screenshot to Chat). */
	attachQueue = $state<string[]>([]);
	#listening = false;

	/** Starts following Rust's `agent-browser` events (once). */
	listen() {
		if (this.#listening) return;
		this.#listening = true;
		void listen<AgentBrowserEvent>('agent-browser', (e) => this.apply(e.payload)).catch(() => (this.#listening = false));
		void invoke<AgentPage[]>('agent_browser_pages')
			.then((list) => {
				for (const p of list ?? []) this.pages[p.label] = p;
			})
			.catch(() => {});
	}

	apply(ev: AgentBrowserEvent) {
		if (ev.page) this.pages[ev.label] = ev.page;
		else delete this.pages[ev.label];
		this.actions[ev.label] = ev.action;
	}

	indicator(label: string): Indicator {
		return indicatorOf(this.pages[label], this.actions[label]);
	}

	/** VS Code's Share with Agent: asked each time, then the tab (its profile and cookies) is the agents'. */
	async share(label: string, url: string): Promise<boolean> {
		const ok = await ask(t('agentBrowser.shareMessage'), { title: t('agentBrowser.shareTitle'), kind: 'warning', okLabel: t('agentBrowser.shareOk') });
		if (!ok) return false;
		try {
			await invoke('agent_browser_share', { label, url, on: true });
			return true;
		} catch (e) {
			status.error(String(e));
			return false;
		}
	}

	/** Stop: no agent may use the page any more (a shared tab is no longer shared). */
	async stop(label: string) {
		try {
			await invoke('agent_browser_stop', { label });
		} catch (e) {
			status.error(String(e));
		}
	}

	/** Kingu's action log of a page: its steps, then Replay and Copy as JSON. */
	async showLog(label: string) {
		const log = (await invoke<AgentLogEntry[]>('agent_browser_log').catch(() => [] as AgentLogEntry[])) ?? [];
		const mine = log.filter((e) => e.page === label);
		if (!mine.length) return void status.flash(t('agentBrowser.logEmpty'), 5000);
		const steps = replaySteps(log, label);
		const pick = await quick.choose({
			placeholder: t('agentBrowser.logPick'),
			items: [
				...(steps.length ? [{ id: 'replay', label: t('agentBrowser.replay', { count: steps.length }) }] : []),
				{ id: 'json', label: t('agentBrowser.copyJson') },
				...mine
					.slice()
					.reverse()
					.map((e, i) => ({ id: `e${e.seq}`, ...logRow(e), ...(i === 0 ? { separator: t('agentBrowser.log') } : {}) }))
			]
		});
		if (pick?.id === 'replay') await this.replay(label, steps.length ? steps : []);
		else if (pick?.id === 'json') {
			await navigator.clipboard.writeText(logJson(log, label)).catch(() => {});
			status.flash(t('agentBrowser.copied'), 4000);
		}
	}

	async replay(label: string, steps: ReturnType<typeof replaySteps>) {
		type Step = { ok: boolean; outcome: string; skipped?: boolean };
		const out = await invoke<Step[]>('agent_browser_replay', { label, steps }).catch((e): Step[] => [{ ok: false, outcome: String(e) }]);
		const failed = out.find((r) => !r.ok);
		if (failed) notifications.warn(t('agentBrowser.replayFailed', { error: failed.outcome }));
		else notifications.info(t('agentBrowser.replayed', { done: out.filter((r) => r.ok && !r.skipped).length, count: steps.length }));
	}

	/** A picture of the tab's visible page, saved with the pasted images; null when it could not be taken. */
	async capture(label: string): Promise<string | null> {
		return (await invoke<string | null>('floating_browser_capture', { label }).catch(() => null)) ?? null;
	}

	/** VS Code's Add Screenshot to Chat: the chat panel attaches it to its next message. */
	async screenshotToChat(label: string) {
		const path = await this.capture(label);
		if (!path) return void status.error(t('agentBrowser.screenshotFailed'));
		this.attachQueue = [...this.attachQueue, path];
		status.flash(t('agentBrowser.screenshotAdded'), 4000);
		// VS Code reveals the chat it attached to.
		void commands.run('workbench.action.chat.open').catch(() => {});
	}

	/** The chat panel takes what waits for it. */
	takeAttachments(): string[] {
		const out = this.attachQueue;
		if (out.length) this.attachQueue = [];
		return out;
	}

	surface(label: string, url: string, title: string) {
		this.surfaces[label] = { url, title };
	}
	gone(label: string) {
		delete this.surfaces[label];
		delete this.pages[label];
		delete this.actions[label];
	}
}

export const agentBrowser = new AgentBrowser();
