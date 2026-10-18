// Runs worktree card actions and the Worktree Jump palette (Orca's WorktreeJumpPalette): one
// list of the folder and every task worktree, jumping into the Agents layout on accept.

import { invoke } from '@tauri-apps/api/core';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { adeLayout, PRIMARY } from './adeLayout.svelte';
import { openEditor } from './agentsMode.svelte';
import { quickOpenWorktree } from './quickOpen.svelte.ts';
import { worktreeDir } from './keys';
import { COLUMNS, STATUS_LABEL } from './model';
import { adeTasks } from './tasks.svelte';
import { jumpRows, worktreeActions, type WorktreeAction } from './worktreeActions';

const FOLDER_ID = '@folder';

/** The card menu of a worktree (`key` '' = the folder itself). */
export function actionsFor(key: string) {
	const view = key ? adeTasks.find(key) : undefined;
	return worktreeActions({ slug: key || null, status: view?.status, running: !!view?.runtime?.working, hasWorktree: !view?.statError });
}

async function copy(text: string, what: string) {
	try {
		await navigator.clipboard.writeText(text);
		status.flash(`คัดลอก${what}แล้ว`);
	} catch {
		status.flash(`คัดลอก${what}ไม่ได้`);
	}
}

export function runWorktreeAction(key: string, id: WorktreeAction) {
	const slug = key || null;
	switch (id) {
		case 'open':
			appMode.setMode('agents');
			return adeLayout.show(key);
		case 'openInEditor':
			adeLayout.show(key);
			return openEditor();
		case 'newTerminal':
			appMode.setMode('agents');
			adeLayout.show(key);
			return adeLayout.newTerminal(key);
		case 'quickOpen':
			appMode.setMode('agents');
			adeLayout.show(key);
			return quickOpenWorktree(key);
		case 'reveal':
			return invoke('fs_reveal', { rel: slug ? worktreeDir(slug) : '' }).catch((e) => status.flash(String(e)));
		case 'copyPath':
			return workspace.root && copy(slug ? `${workspace.root}/${worktreeDir(slug)}` : workspace.root, ' path ');
		case 'copyBranch':
			return slug && copy(adeTasks.branchOf(slug), 'ชื่อ branch ');
		case 'rename':
			return slug && adeTasks.startRename(slug);
		case 'markDone':
			return slug && adeTasks.markDone(slug);
		case 'reopen':
			return slug && adeTasks.markDone(slug, false);
		case 'remove':
			return slug && adeTasks.remove(slug);
	}
}

/** Worktree Jump (⇧⌘J): the folder and every task worktree; Enter opens it in the Agents layout. */
export function jumpToWorktree() {
	if (!workspace.root) return status.flash('เปิดโฟลเดอร์ก่อน');
	const rows = jumpRows(
		{ name: workspace.name ?? '', branch: status.branch ?? '' },
		COLUMNS.map((c) => ({ label: c.label, tasks: adeTasks.groups[c.id].map((v) => ({ slug: v.meta.slug, title: v.meta.title, status: STATUS_LABEL[v.status], branch: adeTasks.branchOf(v.meta.slug) })) }))
	);
	let last = '';
	quick.pick({
		placeholder: 'ไปที่ worktree (Worktree Jump)',
		items: rows.map((r) => {
			const separator = r.group !== last ? r.group : undefined;
			last = r.group;
			return { id: r.key || FOLDER_ID, label: r.label, description: r.description, separator };
		}),
		activeId: appMode.isAgents ? adeLayout.key || FOLDER_ID : undefined,
		onAccept: (item) => runWorktreeAction(item.id === FOLDER_ID ? PRIMARY : item.id, 'open')
	});
}

export function installWorktreeCommands(): () => void {
	const unregister = [
		commands.register({ id: 'kingu.agents.jumpWorktree', title: 'Worktree Jump…', category: 'Agents', key: 'cmd+shift+j', when: () => workspace.root !== null, run: jumpToWorktree }),
		commands.register({
			id: 'kingu.agents.newTerminalInWorktree',
			title: 'New Terminal in Worktree',
			category: 'Agents',
			when: () => appMode.isAgents,
			run: () => adeLayout.newTerminal(adeLayout.key)
		})
	];
	return () => unregister.forEach((u) => u());
}
