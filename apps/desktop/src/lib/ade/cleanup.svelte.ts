// Clean Up Tasks (Orca's WorkspaceCleanupDialog): which tasks to remove or archive in one go. The
// dialog also scans the project (Rust `workspace_cleanup_scan`) and asks the one evaluator which
// tasks the cleanup rules would act on now and why the others stay (workspaceCleanupScan.ts).
import { invoke } from '@tauri-apps/api/core';
import { listenWindow } from '#lib/workbench/windowEvents.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { parseTaskDiffKey } from '#lib/workbench/scm.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { adeTasks } from './tasks.svelte';
import { adeLayout } from './adeLayout.svelte';
import { runtime } from './runtime.svelte';
import { prStatuses } from './prStatus.svelte';
import { tabsOfTask } from './agentGuard';
import { sidebarPrefs } from './sidebarPrefs.svelte';
import { slugOfTaskKey } from './keys';
import { normalizeRepoWorkspaceCleanupPolicy, normalizeWorkspaceCleanupRules, resolveWorkspaceCleanupPolicy } from './workspaceCleanupPolicy';
import { applyRechecked, candidateVerdict, cleanupReceipt, cleanupPreview, cleanupTargets, evaluateScan, type CleanupCandidate, type CleanupProgress, type CleanupScan, type CleanupSize, type CleanupTaskContext, type CleanupVerdict } from './workspaceCleanupScan';
import { hasEnabledWorkspaceCleanupRule } from './workspaceCleanupPolicy';
import {
	activityKey,
	chatSweepDue,
	normalizeChatHistory,
	normalizeCodexUsage,
	parseStoredActivity,
	serializeActivity,
	withActivity,
	withActivityLock,
	type ChatHistorySweep,
	type CleanupActivity,
	type CleanupSource,
	type CodexHistoryUsage,
	type StoredActivity
} from './autoCleanup';
import { chats } from '#lib/agent/chats.svelte.ts';

const RULES_ID = 'kingu.workspaceCleanup.rules';
const PROJECT_ID = 'kingu.workspaceCleanup.project';
/** Delete the chat history of deleted workspaces (Orca `deleteChatHistoryWithWorkspace`); off by default. Rust reads it again before every removal. */
export const CHAT_HISTORY_ID = 'kingu.workspaceCleanup.deleteChatHistory';

/** null when storage is unavailable, so a failure never wipes what this window holds. */
function readStored(root: string | null): StoredActivity | null {
	try {
		return parseStoredActivity(localStorage.getItem(activityKey(root)));
	} catch {
		return null;
	}
}

function writeStored(root: string | null, s: StoredActivity) {
	try {
		localStorage.setItem(activityKey(root), serializeActivity(s));
	} catch {
		// Storage full or unavailable: Activity stays in this window only.
	}
}

class Cleanup {
	open = $state(false);
	/** Only these tasks, all checked (Pick winner offers the other attempts); null: every task. */
	only = $state<string[] | null>(null);

	scan = $state.raw<CleanupScan | null>(null);
	scanning = $state(false);
	progress = $state<CleanupProgress | null>(null);
	error = $state<string | null>(null);
	/** Disk use by worktree path (Rust `workspace_cleanup_sizes`); a path without an entry is not measured yet. */
	sizes = $state.raw<ReadonlyMap<string, number | null>>(new Map());
	measuring = $state(false);
	sizeProgress = $state<CleanupProgress | null>(null);
	/** Pull requests read for the review facet: `scanned` of `total` tasks; null when no read is going. */
	prProgress = $state<CleanupProgress | null>(null);
	#prRun = 0;
	/** Recent runs of every window, newest first (Settings › Workspace Cleanup › Activity); kept in localStorage. */
	activity = $state.raw<CleanupActivity[]>([]);
	/** A run is going (the removal loop), so an automatic one never starts on top of it. */
	running = $state(false);
	/** When the last run started, for the automatic schedule. */
	lastRunAt = $state<number | null>(null);

	/** The rules that apply to the open folder: its own override, else the global rules (all off by default). */
	policy = $derived(
		resolveWorkspaceCleanupPolicy(
			{ workspaceCleanupPolicy: normalizeWorkspaceCleanupRules(settings.get(RULES_ID)) },
			{ workspaceCleanupPolicy: normalizeRepoWorkspaceCleanupPolicy(settings.inspect(PROJECT_ID, 'repo')) }
		)
	);
	rulesOn = $derived(this.policy.source !== 'project-off' && hasEnabledWorkspaceCleanupRule(this.policy.rules));
	chatHistoryOn = $derived(settings.get<boolean>(CHAT_HISTORY_ID) === true);
	/** What Codex's own chat history takes, for the badge beside the switch; null until read, or when it cannot be measured. */
	codexUsage = $state.raw<CodexHistoryUsage | null>(null);
	#usageRead = 0;
	/** When this window last swept chat history, by folder; not stored, so the first run after a start always sweeps (as Orca). */
	#chatSweptAt = new Map<string, number>();
	verdicts: Map<string, CleanupVerdict> = $derived(this.scan ? evaluateScan(this.scan, this.policy, (slug) => this.taskContext(slug)) : new Map());

	taskContext(slug: string): CleanupTaskContext {
		const tabs = tabsOfTask(
			editors.allTabs().map((t) => t.path),
			slug,
			(p) => parseTaskDiffKey(p)?.slug
		);
		const view = adeTasks.find(slug);
		return {
			liveAgent: runtime.isLive(slug) || runtime.isWorking(slug),
			active: !!editors.active && slugOfTaskKey(editors.active) === slug,
			dirtyEditor: tabs.some((p) => editors.isDirty(p)),
			// Any terminal tab of the task is a live PTY; removing the worktree would kill it.
			runningTerminal: (adeLayout.terminals[slug]?.length ?? 0) > 0,
			pinned: sidebarPrefs.pinned(workspace.root ?? '').includes(slug),
			archived: !!view?.meta.archived_at,
			updatedAt: view?.meta.updated_at,
			origin: view?.meta.origin ?? null,
			dispatchedBy: view?.meta.dispatched_by ?? null,
			finished: !!view && view.status !== 'running' && view.status !== 'waiting'
		};
	}

	constructor() {
		this.reloadActivity();
		if (typeof window !== 'undefined') window.addEventListener('storage', (e) => e.key === activityKey(workspace.root) && this.reloadActivity());
	}

	/** Re-reads Activity and the last run, so runs from other windows show (and are not run twice). */
	reloadActivity() {
		const root = workspace.root;
		// Another folder's last run says nothing about this one: start from what is stored for this folder.
		if (root !== this.#activityRoot) {
			this.#activityRoot = root;
			this.lastRunAt = null;
			this.activity = [];
		}
		const stored = readStored(root);
		if (!stored) return;
		this.activity = stored.activity;
		if (stored.lastRunAt !== null && (this.lastRunAt === null || stored.lastRunAt > this.lastRunAt)) this.lastRunAt = stored.lastRunAt;
	}

	#activityRoot: string | null = null;

	#serial<T>(root: string | null, fn: () => T): Promise<T> {
		return withActivityLock(fn, activityKey(root));
	}

	/** What is stored for `root`; with storage unavailable, what this window holds for the open folder. */
	#storedFor(root: string | null): StoredActivity {
		return readStored(root) ?? (root === this.#activityRoot ? { activity: this.activity, lastRunAt: this.lastRunAt } : { activity: [], lastRunAt: null });
	}

	async #markRun(root: string | null, at: number) {
		await this.#serial(root, () => {
			const stored = this.#storedFor(root);
			writeStored(root, { activity: stored.activity, lastRunAt: at });
			if (root !== workspace.root) return;
			this.#activityRoot = root;
			this.activity = stored.activity;
			this.lastRunAt = at;
		});
	}

	/** Adds a run to Activity (the dialog acts on tasks itself; the others go through `runRules`). */
	async record(root: string | null, source: CleanupSource, removed: string[], archived: string[], failed: { slug: string; error: string }[], kept: number, chatHistory?: ChatHistorySweep) {
		await this.#serial(root, () => {
			const stored = this.#storedFor(root);
			const activity = withActivity(stored.activity, { at: Date.now(), source, removed, archived, failed, kept, ...(chatHistory ? { chatHistory } : {}) });
			writeStored(root, { activity, lastRunAt: stored.lastRunAt });
			if (root !== workspace.root) return;
			this.#activityRoot = root;
			this.activity = activity;
			this.lastRunAt = stored.lastRunAt;
		});
	}

	/** Measures Codex's chat history (Rust walks file metadata only); a failed walk shows no badge. */
	async readCodexUsage() {
		const read = ++this.#usageRead;
		const usage = await invoke<unknown>('workspace_cleanup_codex_history_usage').then(normalizeCodexUsage, () => null);
		if (read === this.#usageRead) this.codexUsage = usage;
	}

	/** Measures every task worktree (`du`, one after another): slow, so the dialog asks after the Git facts are shown. */
	async measureSizes() {
		const root = workspace.root;
		if (this.measuring || !root) return;
		this.measuring = true;
		this.sizeProgress = null;
		const unlisten = await listenWindow<CleanupProgress>('workspace-cleanup-size-progress', (e) => {
			if (workspace.root === root) this.sizeProgress = e.payload;
		}).catch(() => null);
		try {
			const rows = await invoke<CleanupSize[]>('workspace_cleanup_sizes');
			if (workspace.root !== root) return;
			this.sizes = new Map(rows.map((r) => [r.path, r.sizeBytes]));
		} catch {
			// Sizes are optional: without them the size filter treats every folder as unmeasured.
		} finally {
			unlisten?.();
			this.measuring = false;
			this.sizeProgress = null;
		}
	}

	/**
	 * Reads the PR of each task (one `gh` call each, `limit` at a time) so the review facet can use
	 * it. Never awaited by the list: a task stays `unknown` until its read lands, and a read that
	 * fails just leaves it so. A newer call or closing the dialog stops the one before it.
	 */
	async readPullRequests(slugs: readonly string[], limit = 3) {
		const run = ++this.#prRun;
		const queue = [...slugs];
		const total = queue.length;
		let done = 0;
		if (!total) {
			this.prProgress = null;
			return;
		}
		this.prProgress = { scanned: 0, total } as CleanupProgress;
		const worker = async () => {
			for (let slug = queue.shift(); slug !== undefined && run === this.#prRun; slug = queue.shift()) {
				await prStatuses.refresh(slug, { threads: false }).catch(() => {});
				if (run === this.#prRun) this.prProgress = { scanned: ++done, total } as CleanupProgress;
			}
		};
		await Promise.all(Array.from({ length: Math.min(limit, total) }, worker));
		if (run === this.#prRun) this.prProgress = null;
	}

	#inflight: { root: string; promise: Promise<CleanupScan | null> } | null = null;
	#scanRun = 0;

	/** Reads Git for every worktree of the open folder; a second ask for the same folder shares it. Each window scans on its own. */
	rescan(): Promise<CleanupScan | null> {
		const root = workspace.root;
		if (!root) return Promise.resolve(null);
		if (this.#inflight?.root === root) return this.#inflight.promise;
		const promise = this.#scan(root).finally(() => {
			if (this.#inflight?.promise === promise) this.#inflight = null;
		});
		this.#inflight = { root, promise };
		return promise;
	}

	async #scan(root: string): Promise<CleanupScan | null> {
		// A scan belongs to the folder it started in: another folder's result must not replace what is shown.
		const run = ++this.#scanRun;
		this.scanning = true;
		this.error = null;
		this.progress = null;
		const unlisten = await listenWindow<CleanupProgress>('workspace-cleanup-progress', (e) => {
			if (run === this.#scanRun) this.progress = e.payload;
		}).catch(() => null);
		try {
			const scan = await invoke<CleanupScan>('workspace_cleanup_scan');
			if (workspace.root !== root || run !== this.#scanRun) return null;
			this.scan = scan;
			return scan;
		} catch (e) {
			if (workspace.root !== root || run !== this.#scanRun) return null;
			this.error = String(e);
			// No stale rows after a failed scan: the dialog must not offer what it can no longer vouch for.
			this.scan = null;
			return null;
		} finally {
			unlisten?.();
			if (run === this.#scanRun) {
				this.scanning = false;
				this.progress = null;
			}
		}
	}

	/** `kingu cleanup preview`: a fresh scan, then what the rules say about each task. */
	async preview() {
		const root = workspace.root;
		const scan = await this.rescan();
		if (!scan) throw new Error(workspace.root !== root ? 'The folder changed; try again' : (this.error ?? 'No folder is open'));
		return cleanupPreview(this.policy, evaluateScan(scan, this.policy, (slug) => this.taskContext(slug)));
	}

	/**
	 * `kingu cleanup run`: a fresh scan, the same decision as the dialog, then each task the rules
	 * act on is removed (its own guards and branch setting) or archived. Nothing the evaluator keeps
	 * is touched, so an unattended run cannot do more than the preview showed. With the chat history
	 * setting on, the run then sweeps the chats of deleted workspaces (`rules: false`: only that).
	 */
	async runRules(source: CleanupSource = 'cli', { rules = true }: { rules?: boolean } = {}) {
		if (this.running) throw new Error('A cleanup run is already going');
		this.running = true;
		// The run belongs to the folder open now: switching folders mid-run must not record elsewhere.
		const root = workspace.root;
		try {
			await this.#markRun(root, Date.now());
			// A failed rule run still sweeps chats (Orca: "sweep chats even when rule evaluation fails"), then fails as before.
			let failure: unknown = null;
			const ran = rules ? await this.#run(root).catch((e: unknown) => ((failure = e), null)) : { removed: [], archived: [], failed: [], kept: 0 };
			const chatHistory = await this.#sweepChatHistory(source, root);
			if (ran || chatHistory) await this.record(root, source, ran?.removed ?? [], ran?.archived ?? [], ran?.failed ?? [], ran?.kept ?? 0, chatHistory);
			if (!ran) throw failure;
			return { ...cleanupReceipt(ran.removed, ran.archived, ran.failed, ran.kept), ...(chatHistory ? { chatHistory } : {}) };
		} finally {
			this.running = false;
		}
	}

	/**
	 * Deletes the chat history of the open folder's deleted workspaces: Claude Code transcripts and Codex
	 * rollouts in Rust, Kingu's own chats one by one through the chat store (Rust proves each again). Undefined when the
	 * setting is off, the sweep is not due, or the scan failed (the next run tries again).
	 */
	async #sweepChatHistory(source: CleanupSource, root: string | null): Promise<ChatHistorySweep | undefined> {
		if (!root || workspace.root !== root) return undefined;
		if (!chatSweepDue(this.chatHistoryOn, source, this.#chatSweptAt.get(root) ?? null, Date.now())) return undefined;
		try {
			const swept = await invoke<{ chats?: unknown }>('workspace_cleanup_chat_sweep');
			const result = normalizeChatHistory(swept);
			if (!result) return undefined;
			for (const id of Array.isArray(swept.chats) ? swept.chats : []) {
				if (workspace.root !== root || typeof id !== 'string') break;
				try {
					const freed = await chats.forgetDeleted(id);
					if (freed === null) continue;
					result.deleted++;
					result.freedBytes += freed;
				} catch {
					result.failed++;
				}
			}
			this.#chatSweptAt.set(root, Date.now());
			return result;
		} catch {
			return undefined;
		}
	}

	async #run(root: string | null) {
		const scan = await this.rescan();
		if (!scan) throw new Error(workspace.root !== root ? 'The folder changed; cleanup stopped' : (this.error ?? 'No folder is open'));
		const verdicts = evaluateScan(scan, this.policy, (slug) => this.taskContext(slug));
		const targets = cleanupTargets(verdicts);
		const recheck = async ({ slug, action }: (typeof targets)[number]) => {
			if (workspace.root !== root) throw new Error('The folder changed; cleanup stopped');
			const fresh = await invoke<CleanupCandidate>('workspace_cleanup_inspect', { path: verdicts.get(slug)!.path });
			return candidateVerdict(fresh, this.policy, this.taskContext(slug), Date.now())?.evaluation.action === action;
		};
		const { removed, archived, failed, skipped } = await applyRechecked(targets, recheck, async ({ slug, action }) => {
			if (workspace.root !== root) throw new Error('The folder changed; cleanup stopped');
			if (action === 'archive') {
				await adeTasks.archive(slug);
				return !!adeTasks.find(slug)?.meta.archived_at;
			}
			return adeTasks.removeConfirmed(slug, { deleteBranch: adeTasks.defaultBranchRemoval(slug), force: false });
		});
		return { removed, archived, failed, kept: verdicts.size - targets.length + skipped };
	}

	/** The dialog with just `slugs` (the losing attempts of a best-of-N group). */
	offer(slugs: string[]) {
		this.only = slugs;
		this.open = true;
	}

	close() {
		this.#prRun++;
		this.prProgress = null;
		this.open = false;
		this.only = null;
	}
}

export const cleanup = new Cleanup();
