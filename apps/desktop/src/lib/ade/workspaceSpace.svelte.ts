// Workspace Space dialog state (Orca's workspaceSpace:analyze / :cancel / :progress): one scan at a
// time, its progress from Rust's `workspace-space-progress` event, and the last result kept so
// reopening the dialog shows it at once (Orca's getCachedAnalysis) while a new scan can be asked.
import { invoke } from '@tauri-apps/api/core';
import { listenWindow } from '#lib/workbench/windowEvents.ts';
import type { SpaceAnalysis, SpaceProgress } from './workspaceSpace';

class WorkspaceSpace {
	open = $state(false);
	running = $state(false);
	progress = $state<SpaceProgress | null>(null);
	analysis = $state<SpaceAnalysis | null>(null);
	error = $state<string | null>(null);
	/** Rows whose top-level items are shown. */
	expanded = $state<Record<string, boolean>>({});

	/** Opens the dialog; scans when there is no result yet. */
	show() {
		this.open = true;
		if (!this.analysis && !this.running) void this.analyze();
	}

	close() {
		this.open = false;
	}

	async analyze() {
		if (this.running) return;
		this.running = true;
		this.error = null;
		this.progress = null;
		const unlisten = await listenWindow<SpaceProgress>('workspace-space-progress', (e) => (this.progress = e.payload)).catch(() => null);
		try {
			this.analysis = await invoke<SpaceAnalysis>('workspace_space_analyze');
		} catch (e) {
			const msg = String(e);
			if (msg !== 'cancelled') this.error = msg;
		} finally {
			unlisten?.();
			this.running = false;
			this.progress = null;
		}
	}

	async cancel() {
		await invoke<boolean>('workspace_space_cancel').catch(() => false);
	}

	toggle(path: string) {
		this.expanded[path] = !this.expanded[path];
	}
}

export const workspaceSpace = new WorkspaceSpace();
