// Which terminals the window shows, per open folder: on startup and on every folder switch the
// panel's terminals, the ADE's worktree terminals and the agent CLIs of that folder are restored
// from localStorage and re-attach to their live PTYs (the kingu-ptyd daemon keeps them running
// across app restarts). The previous folder's terminals are unmounted, not killed.

import { untrack } from 'svelte';
import { ask } from '@tauri-apps/plugin-dialog';
import { adeLayout } from '#lib/ade/adeLayout.svelte.ts';
import { cliSessions } from '#lib/ade/cliSessions.svelte.ts';
import { killPty, listPtys } from '#lib/terminal/pty.ts';
import { backgroundKeys, orphanKeys, rootTag } from '#lib/terminal/sessions.ts';
import { terminals } from '#lib/terminal/terminals.svelte.ts';
import { commands } from './commands.svelte';
import { status } from './status.svelte';
import { workspace } from './workspace.svelte';

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
			const keys = backgroundKeys((await listPtys()).map((s) => s.key), shown());
			if (!keys.length) {
				status.flash('ไม่มี terminal ที่รันอยู่เบื้องหลัง');
				return;
			}
			const ok = await ask(`ปิด ${keys.length} terminal ที่รันอยู่เบื้องหลัง (ของโฟลเดอร์อื่น หรือที่ไม่ได้แสดงในหน้าต่างนี้)?\n\nโปรแกรมที่รันอยู่ในนั้น รวมถึง agent CLI จะถูกปิดด้วย`, {
				title: 'Kill All Background Sessions',
				kind: 'warning',
				okLabel: `ปิด ${keys.length} terminal`,
				cancelLabel: 'ยกเลิก'
			});
			if (!ok) return;
			for (const key of keys) killPty(key);
			status.flash(`ปิด ${keys.length} terminal เบื้องหลังแล้ว`);
		}
	});

	return () => {
		generation++;
		stop();
		unregister();
	};
}
