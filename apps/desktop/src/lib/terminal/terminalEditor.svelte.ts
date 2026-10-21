// Terminals in the editor area (VS Code's terminal editors: Create Terminal in Editor Area, Move
// Terminal into Editor Area / into Panel). An editor terminal stays in the panel's terminal list
// (terminals.svelte.ts, `inEditor`), so it is kept with the folder's terminals and re-attaches
// after a reload; its editor tab is `terminal:<id>`. Closing that tab kills the terminal, like
// VS Code.

import { untrack } from 'svelte';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { focusTerminal } from './registry.ts';
import { terminals } from './terminals.svelte.ts';

const PREFIX = 'terminal:';

export const terminalEditorKey = (id: number) => `${PREFIX}${id}`;

/** The terminal id of a `terminal:<id>` editor key, else null. */
export function terminalIdOfEditor(key: string | null | undefined): number | null {
	const m = key ? /^terminal:(\d{1,9})$/.exec(key) : null;
	return m ? Number(m[1]) : null;
}

export const isTerminalEditorKey = (key: string | null | undefined) => terminalIdOfEditor(key) !== null;

/** Create Terminal in Editor Area: a new shell in an editor tab. */
export function createTerminalInEditor(opts: { folder?: string; profile?: string } = {}): number {
	const id = terminals.open({ ...opts, inEditor: true });
	editors.open(terminalEditorKey(id), { preview: false });
	focusTerminal(terminals.key(id));
	return id;
}

/** Move Terminal into Editor Area: the panel terminal `id` (its shell keeps running) into an editor tab. */
export function moveTerminalToEditor(id = terminals.active): boolean {
	if (!terminals.detachToEditor(id)) return false;
	editors.open(terminalEditorKey(id), { preview: false });
	focusTerminal(terminals.key(id));
	return true;
}

/** Move Terminal into Panel: the editor terminal `id` back into the panel. */
export function moveTerminalToPanel(id: number): boolean {
	if (!terminals.attachToPanel(id)) return false;
	// The tab goes without killing the shell: the panel shows it now.
	editors.closeEverywhere(terminalEditorKey(id));
	layout.showPanel('terminal');
	focusTerminal(terminals.key(id));
	return true;
}

/** The editor terminal shown in the active editor, if any. */
export const activeEditorTerminal = (): number | null => {
	const id = terminalIdOfEditor(editors.active);
	return id !== null && terminals.get(id)?.inEditor ? id : null;
};

/**
 * Kills an editor terminal once its tab is closed in every group. Only a tab seen open is
 * watched, and the check waits a moment, so a folder switch (which swaps the editors and the
 * terminal list) never kills anything.
 */
export function installTerminalEditors(): () => void {
	const seen = new Map<number, string>();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const openIds = () => new Set(editors.allTabs().map((t) => terminalIdOfEditor(t.path)).filter((id): id is number => id !== null));
	let restoredFor: string | null = null;
	const stop = $effect.root(() => {
		// Editor tabs of terminals are not part of the saved editor layout: a folder's editor
		// terminals get their tabs back once its terminals (and editors) are loaded.
		$effect(() => {
			const tag = terminals.tag;
			untrack(() => {
				if (!tag) restoredFor = null;
				if (!tag || restoredFor === tag) return;
				restoredFor = tag;
				const timer = setTimeout(() => {
					timers.delete(timer);
					if (terminals.tag !== tag) return;
					const open = openIds();
					for (const t of terminals.list) if (t.inEditor && !open.has(t.id)) editors.open(terminalEditorKey(t.id), { preview: false });
				}, 1000);
				timers.add(timer);
			});
		});
		$effect(() => {
			const open = openIds();
			const tag = terminals.tag;
			const list = terminals.list;
			untrack(() => {
				for (const id of open) if (tag && list.some((t) => t.id === id && t.inEditor)) seen.set(id, tag);
				for (const [id, at] of [...seen]) {
					if (open.has(id)) continue;
					seen.delete(id);
					if (at !== tag) continue;
					const timer = setTimeout(() => {
						timers.delete(timer);
						if (terminals.tag === at && !openIds().has(id) && terminals.get(id)?.inEditor) terminals.close(id);
					}, 1500);
					timers.add(timer);
				}
			});
		});
	});
	return () => {
		stop();
		for (const t of timers) clearTimeout(t);
	};
}
