// Clean Up Tasks (Orca's WorkspaceCleanupDialog): which tasks to remove in one go. The dialog also
// scans the project (Rust `workspace_cleanup_scan`) and asks the one evaluator which tasks the
// cleanup rules would remove now and why the others stay (workspaceCleanupScan.ts).
import { invoke } from '@tauri-apps/api/core';
import { listenWindow } from '#lib/workbench/windowEvents.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { parseTaskDiffKey } from '#lib/workbench/scm.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { adeTasks } from './tasks.svelte';
import { runtime } from './runtime.svelte';
import { tabsOfTask } from './agentGuard';
import { slugOfTaskKey } from './keys';
import { normalizeRepoWorkspaceCleanupPolicy, normalizeWorkspaceCleanupRules, resolveWorkspaceCleanupPolicy } from './workspaceCleanupPolicy';
import { cleanupReceipt, cleanupPreview, evaluateScan, slugsToRemove, type CleanupProgress, type CleanupScan, type CleanupTaskContext, type CleanupVerdict } from './workspaceCleanupScan';
import { hasEnabledWorkspaceCleanupRule } from './workspaceCleanupPolicy';

const RULES_ID = 'kingu.workspaceCleanup.rules';
const PROJECT_ID = 'kingu.workspaceCleanup.project';

class Cleanup {
	open = $state(false);
	/** Only these tasks, all checked (Pick winner offers the other attempts); null: every task. */
	only = $state<string[] | null>(null);

	scan = $state.raw<CleanupScan | null>(null);
	scanning = $state(false);
	progress = $state<CleanupProgress | null>(null);
	error = $state<string | null>(null);

	/** The rules that apply to the open folder: its own override, else the global rules (all off by default). */
	policy = $derived(
		resolveWorkspaceCleanupPolicy(
			{ workspaceCleanupPolicy: normalizeWorkspaceCleanupRules(settings.get(RULES_ID)) },
			{ workspaceCleanupPolicy: normalizeRepoWorkspaceCleanupPolicy(settings.inspect(PROJECT_ID, 'repo')) }
		)
	);
	rulesOn = $derived(this.policy.source !== 'project-off' && hasEnabledWorkspaceCleanupRule(this.policy.rules));
	verdicts: Map<string, CleanupVerdict> = $derived(this.scan ? evaluateScan(this.scan, this.policy, (slug) => this.#context(slug)) : new Map());

	#context(slug: string): CleanupTaskContext {
		const tabs = tabsOfTask(
			editors.allTabs().map((t) => t.path),
			slug,
			(p) => parseTaskDiffKey(p)?.slug
		);
		return {
			liveAgent: runtime.isLive(slug) || runtime.isWorking(slug),
			active: !!editors.active && slugOfTaskKey(editors.active) === slug,
			dirtyEditor: tabs.some((p) => editors.isDirty(p)),
			updatedAt: adeTasks.find(slug)?.meta.updated_at
		};
	}

	#inflight: Promise<CleanupScan | null> | null = null;

	/** Reads Git for every worktree of the open folder; one scan at a time (a second ask shares it). */
	rescan(): Promise<CleanupScan | null> {
		if (!workspace.root) return Promise.resolve(null);
		return (this.#inflight ??= this.#scan().finally(() => (this.#inflight = null)));
	}

	async #scan(): Promise<CleanupScan | null> {
		this.scanning = true;
		this.error = null;
		this.progress = null;
		const unlisten = await listenWindow<CleanupProgress>('workspace-cleanup-progress', (e) => (this.progress = e.payload)).catch(() => null);
		try {
			this.scan = await invoke<CleanupScan>('workspace_cleanup_scan');
			return this.scan;
		} catch (e) {
			this.error = String(e);
			return null;
		} finally {
			unlisten?.();
			this.scanning = false;
			this.progress = null;
		}
	}

	/** `kingu cleanup preview`: a fresh scan, then what the rules say about each task. */
	async preview() {
		const scan = await this.rescan();
		if (!scan) throw new Error(this.error ?? 'No folder is open');
		return cleanupPreview(this.policy, evaluateScan(scan, this.policy, (slug) => this.#context(slug)));
	}

	/**
	 * `kingu cleanup run`: a fresh scan, the same decision as the dialog, then each task the rules
	 * remove goes through the normal removal (its own guards and branch setting). Nothing the
	 * evaluator keeps is touched, so an unattended run cannot remove more than the preview showed.
	 */
	async runRules() {
		const scan = await this.rescan();
		if (!scan) throw new Error(this.error ?? 'No folder is open');
		const verdicts = evaluateScan(scan, this.policy, (slug) => this.#context(slug));
		const targets = slugsToRemove(verdicts);
		const removed: string[] = [];
		const failed: { slug: string; error: string }[] = [];
		for (const slug of targets) {
			try {
				const ok = await adeTasks.removeConfirmed(slug, { deleteBranch: adeTasks.defaultBranchRemoval(slug), force: false });
				if (ok) removed.push(slug);
				else failed.push({ slug, error: 'not removed (see Kingu)' });
			} catch (e) {
				failed.push({ slug, error: e instanceof Error ? e.message : String(e) });
			}
		}
		return cleanupReceipt(removed, failed, verdicts.size - targets.length);
	}

	/** The dialog with just `slugs` (the losing attempts of a best-of-N group). */
	offer(slugs: string[]) {
		this.only = slugs;
		this.open = true;
	}

	close() {
		this.open = false;
		this.only = null;
	}
}

export const cleanup = new Cleanup();
