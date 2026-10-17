// Snaps store: the list from `snap_list` (user snaps + the open folder's `.kingu/snaps`), trust,
// running a task in the mode that is showing (an IDE panel terminal in the folder root, or an
// ADE terminal tab in the selected worktree), and what active snaps contribute: palette
// commands, settings schemas and MCP servers. Rust decides `trusted`; nothing here runs a repo
// snap's command unless it is trusted (see snapModel.isActive).

import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { adeLayout } from '#lib/ade/adeLayout.svelte.ts';
import { settingSchemas } from '#lib/settings/schemas.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
import { terminals } from '#lib/terminal/terminals.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { setMcpProvider } from '#lib/ade/mcp.ts';
import { isActive, mcpServersOf, runnableTasks, snapSettingSchemas, taskArgv, taskCommandId, type McpServerSpec, type SnapInfo } from './snapModel.ts';

class Snaps {
	list = $state<SnapInfo[]>([]);
	loaded = $state(false);
	/** `snap_list` itself failed (a broken snap is listed with its own error instead). */
	error = $state<string | null>(null);
	#seq = 0;

	/** Re-reads every snap. A slower, older read never overwrites a newer one. */
	async load() {
		const seq = ++this.#seq;
		try {
			const list = await invoke<SnapInfo[]>('snap_list');
			if (seq !== this.#seq) return;
			this.list = list;
			this.error = null;
		} catch (e) {
			if (seq === this.#seq) this.error = String(e);
		} finally {
			if (seq === this.#seq) this.loaded = true;
		}
	}

	/** Trusts (or untrusts) a repo snap of the open folder: exactly the manifest that was listed. */
	async trust(id: string, on: boolean) {
		const snap = this.list.find((s) => s.id === id && s.source === 'repo');
		if (!snap) return;
		try {
			await invoke('snap_trust', { id, trusted: on, hash: on ? snap.hash : null });
			status.flash(on ? `เชื่อถือ snap “${snap.name}” แล้ว` : `เลิกเชื่อถือ snap “${snap.name}” แล้ว`);
		} catch (e) {
			status.flash(`เปลี่ยนการเชื่อถือ snap ไม่สำเร็จ: ${e}`);
		}
		await this.load();
	}

	/** Runs a task of an active snap in a new terminal of the mode that is showing. */
	runTask(snapId: string, taskId: string) {
		const snap = this.list.find((s) => s.id === snapId && isActive(s));
		const task = snap?.tasks.find((t) => t.id === taskId);
		if (!snap || !task) {
			status.flash(`ไม่พบงาน ${snapId}/${taskId} ใน snap ที่เชื่อถือ (Snap task not found)`);
			return;
		}
		if (!workspace.root) {
			status.flash('เปิดโฟลเดอร์ก่อนรันงานของ snap (Open a folder first)');
			return;
		}
		const run = taskArgv(snap, task, (id) => settings.get(id));
		const title = `${task.title} (${snap.name})`;
		systemSettings.close();
		if (appMode.isAgents) adeLayout.newTerminal(adeLayout.key, { title, run });
		else {
			terminals.open({ title, run });
			layout.showPanel('terminal');
		}
	}

	/** MCP servers of trusted, valid snaps for agents, keyed `<snapId>-<serverName>`. */
	mcpServers(): Record<string, McpServerSpec> {
		return mcpServersOf(this.list);
	}
}

export const snaps = new Snaps();

/** Workbench wiring: loads snaps per folder, registers their settings and commands. */
export function installSnaps(): () => void {
	// Agents (timeline and CLI) get the MCP servers of active snaps when a run starts.
	setMcpProvider(() => snaps.mcpServers());
	let taskCommands: (() => void)[] = [];
	const unregisterTasks = () => {
		taskCommands.forEach((u) => u());
		taskCommands = [];
	};
	const stopEffects = $effect.root(() => {
		$effect(() => {
			void workspace.root;
			untrack(() => void snaps.load());
		});
		$effect(() => {
			const list = snaps.list;
			untrack(() => {
				settingSchemas.contribute('snaps', snapSettingSchemas(list));
				unregisterTasks();
				taskCommands = runnableTasks(list).map(({ snap, task }) =>
					commands.register({
						id: taskCommandId(snap.id, task.id),
						title: task.title,
						category: `Snap: ${snap.name}`,
						when: () => workspace.root !== null,
						run: () => snaps.runTask(snap.id, task.id)
					})
				);
			});
		});
	});
	const unregister = [
		commands.register({
			id: 'snap.reload',
			title: 'Reload Snaps',
			category: 'Snap',
			run: async () => {
				await snaps.load();
				status.flash(snaps.error ? `โหลด Snaps ไม่สำเร็จ: ${snaps.error}` : `โหลด Snaps แล้ว (${snaps.list.length})`);
			}
		}),
		commands.register({ id: 'snap.manage', title: 'Manage Snaps', category: 'Snap', run: () => systemSettings.showSnaps() })
	];
	return () => {
		stopEffects();
		unregisterTasks();
		unregister.forEach((u) => u());
		settingSchemas.contribute('snaps', []);
		setMcpProvider(() => ({}));
	};
}
