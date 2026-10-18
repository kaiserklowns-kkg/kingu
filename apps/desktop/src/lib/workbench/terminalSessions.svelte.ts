// Which terminals the window shows, per open folder: on startup and on every folder switch the
// panel's terminals, the ADE's worktree terminals and the agent CLIs of that folder are restored
// from localStorage and re-attach to their live PTYs (the kingu-ptyd daemon keeps them running
// across app restarts). The previous folder's terminals are unmounted, not killed.

import { untrack } from 'svelte';
import { ask } from '#lib/workbench/messageBox.ts';
import { adeLayout } from '#lib/ade/adeLayout.svelte.ts';
import { cliSessions } from '#lib/ade/cliSessions.svelte.ts';
import { killPty, listPtys } from '#lib/terminal/pty.ts';
import { backgroundAgentKeys, backgroundKeys, orphanKeys, rootTag } from '#lib/terminal/sessions.ts';
import { terminals } from '#lib/terminal/terminals.svelte.ts';
import { commands } from './commands.svelte';
import { status } from './status.svelte';
import { workspace } from './workspace.svelte';
import { t } from '#lib/i18n/index.ts';

/** PTY keys of every terminal the window shows now. */
function shown(): Set<string> {
	return new Set([...terminals.keys(), ...adeLayout.ptyKeys(), ...cliSessions.ptyKeys()]);
}

export function installTerminalSessions(): () => void {
	let generation = 0;

	async function show(root: string | null) {
		const mine = ++generation;
		terminals.unload();
		adeLayout.unloadTerminals();
		cliSessions.unload();
		const live = await listPtys();
		if (mine !== generation) return;
		const tag = rootTag(root);
		terminals.load(tag);
		adeLayout.loadTerminals(tag);
		cliSessions.load(tag, new Set(live.filter((s) => s.alive).map((s) => s.key)));
		// This folder's PTYs that no restored terminal shows (closed while the app was not looking).
		for (const key of orphanKeys(live.map((s) => s.key), shown(), tag)) killPty(key);
	}

	const stop = $effect.root(() => {
		$effect(() => {
			if (!workspace.ready) return;
			const root = workspace.root;
			untrack(() => void show(root));
		});
	});

	const unregister = commands.register({
		id: 'workbench.action.terminal.killAllBackground',
		title: 'Kill All Background Sessions',
		category: 'Terminal',
		run: async () => {
			const live = (await listPtys()).map((s) => s.key);
			const keys = backgroundKeys(live, shown());
			// Agent CLIs belong to their task sessions (other folders' agents keep working): asked apart, Cancel first.
			const agents = backgroundAgentKeys(live, shown());
			if (!keys.length && !agents.length) {
				status.flash(t('workbench.terminalSessions.none'));
				return;
			}
			if (keys.length) {
				const ok = await ask(t('workbench.terminalSessions.confirm', { count: keys.length }), {
					title: 'Kill All Background Sessions',
					kind: 'warning',
					okLabel: t('workbench.terminalSessions.killButton', { count: keys.length }),
					cancelLabel: t('common.cancel')
				});
				if (ok) {
					for (const key of keys) killPty(key);
					status.flash(t('workbench.terminalSessions.killed', { count: keys.length }));
				}
			}
			if (agents.length) {
				const end = await ask(t('workbench.terminalSessions.confirmAgents', { count: agents.length }), {
					title: 'Kill All Background Sessions',
					kind: 'warning',
					okLabel: t('workbench.terminalSessions.endAgentsButton', { count: agents.length }),
					cancelLabel: t('workbench.terminalSessions.keepAgents')
				});
				if (!end) return;
				for (const key of agents) killPty(key);
				status.flash(t('workbench.terminalSessions.agentsEnded', { count: agents.length }));
			}
		}
	});

	return () => {
		generation++;
		stop();
		unregister();
	};
}
