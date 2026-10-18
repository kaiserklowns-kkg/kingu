// Terminal bells of the Agents layout (Orca's notifications.terminalBell): with
// `kingu.agent.notifications.terminalBell` on, a BEL from a task terminal you are not looking at
// (a finished `cargo build`, an agent CLI that wants you) puts a dot on its tab and sends a
// system notification that opens the task. The dot goes once the tab is shown. Decisions in
// agentNotify.ts (bellAction).

import { appMode } from '#lib/workbench/mode.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { bellAction } from './agentNotify';
import { agentNotifyAllowed, notify } from './agentNotify.svelte';
import { adeLayout } from './adeLayout.svelte';
import { adeTasks } from './tasks.svelte';

const id = (key: string, tab: string) => `${key}\n${tab}`;

class TerminalBells {
	/** Tabs that rang while hidden, by `worktree key \n tab id`. */
	rang = $state<Record<string, number>>({});
	#notified: Record<string, number> = {};

	constructor() {
		$effect.root(() => {
			// Showing a tab clears its dot.
			$effect(() => {
				if (!appMode.isAgents || adeLayout.board) return;
				const k = id(adeLayout.key, adeLayout.activeTab(adeLayout.key));
				if (k in this.rang) delete this.rang[k];
			});
		});
	}

	#visible(key: string, tab: string): boolean {
		return appMode.isAgents && !adeLayout.board && adeLayout.key === key && adeLayout.activeTab(key) === tab && document.hasFocus();
	}

	/** Terminal `tab` (`main` for a task's agent CLI) of worktree `key` rang the bell. */
	ring(key: string, tab: string) {
		const k = id(key, tab);
		const now = Date.now();
		const act = bellAction(settings.get<boolean>('kingu.agent.notifications.terminalBell') === true, this.#visible(key, tab), this.#notified[k], now);
		if (!act.mark) return;
		this.rang[k] = now;
		if (!act.notify) return;
		this.#notified[k] = now;
		const slug = adeTasks.find(key) ? key : undefined;
		if (!agentNotifyAllowed(slug)) return;
		const task = adeTasks.find(key)?.meta.title ?? workspace.root?.split('/').pop() ?? key;
		const tabLabel = adeLayout.tabs(key).find((x) => x.id === tab)?.label ?? tab;
		void notify(t('ade.bell.title', { task }), t('ade.bell.body', { tab: tabLabel }), slug);
	}

	has(key: string, tab: string): boolean {
		return id(key, tab) in this.rang;
	}
}

export const terminalBells = new TerminalBells();
