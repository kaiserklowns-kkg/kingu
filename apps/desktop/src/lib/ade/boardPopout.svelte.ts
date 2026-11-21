// The task board's pop-out, the feeding side (Orca's main renderer publishing dashboard
// snapshots, ipc/dashboard-popout.ts). Pop Out (Board.svelte) asks Rust (windows.rs) for the one
// pop-out window and makes this window the one that feeds it; while it does, every change of the
// agent board (any project's task, status, unread notice, theme or language) is sent as a
// snapshot (boardPopout.ts). Open task in the pop-out comes back here: this window is already
// in front (Rust) and opens the task, switching project first when it is another one.
// A card clicked in the pop-out opens its terminal preview there (Orca's AgentTerminalDialog):
// while it is open, the snapshots carry the last rows of that task's agent terminal, read from
// the xterm this window shows it in (so already without escape sequences), refreshed as it
// prints. They stay in memory and only travel to the pop-out (never logged).

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { clientLog } from '#lib/client-log.ts';
import { locale, t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { listenWindow, windowLabel } from '#lib/workbench/windowEvents.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { tapOutput, terminalHandle } from '#lib/terminal/registry.ts';
import { agentInbox } from './agentInbox.svelte.ts';
import { cssVariables, popoutLanes, PREVIEW_SCROLLBACK_ROWS, previewLines, type PopoutPreview, type PopoutSnapshot } from './boardPopout';
import { cliSessions } from './cliSessions.svelte';
import { paneAgents } from './paneAgents.svelte';
import { COLUMNS } from './model';
import { projects } from './projects.svelte';
import { projectName } from './projects';
import { adeTasks } from './tasks.svelte';

/** Board changes come in bursts (a poll updates every project at once): one send per burst. */
const PUBLISH_DELAY_MS = 150;
/** A previewed terminal that keeps printing re-sends its rows at most this often. */
const PREVIEW_REFRESH_MS = 250;

type PreviewTarget = { root: string; slug: string };

class BoardPopoutFeed {
	/** The window feeding the open pop-out (Rust's `board-popout:owner`), null while it is closed. */
	owner = $state<string | null>(null);
	/** Whether this window feeds it. */
	mine = $derived(this.owner !== null && this.owner === windowLabel());
	/** The card whose terminal preview the pop-out shows (Rust relays it with `board-popout:requested`). */
	previewing = $state<PreviewTarget | null>(null);

	#listening: Promise<void> | null = null;
	#stop: (() => void) | null = null;
	#sent = '';
	#build: (() => PopoutSnapshot) | null = null;

	/** Pop Out: opens the pop-out (or brings it to the front), fed by this window. */
	async popOut() {
		await this.#listen();
		try {
			await invoke('board_popout_open');
		} catch (e) {
			clientLog('error', `board_popout_open: ${e}`);
		}
	}

	/** A board was shown: picks the feed back up after this page reloaded with the pop-out open. */
	async resume() {
		await this.#listen();
		this.#setOwner(await invoke<string | null>('board_popout_owner').catch(() => null));
	}

	#listen(): Promise<void> {
		this.#listening ??= Promise.all([
			listen<string | null>('board-popout:owner', (e) => this.#setOwner(e.payload)),
			listenWindow<PreviewTarget | null>('board-popout:requested', (e) => {
				const p = e.payload;
				if (p?.root !== this.previewing?.root || p?.slug !== this.previewing?.slug) this.previewing = p ? { root: p.root, slug: p.slug } : null;
				this.#sent = '';
				this.#publish();
			}),
			listenWindow<{ root: string; slug: string }>('board-popout:reveal', (e) => void projects.open(e.payload.root, e.payload.slug)),
			// Keys typed into the pop-out's preview go to that task's terminal, only while it is the one previewed.
			listenWindow<{ root: string; slug: string; data: string }>('board-popout:input', (e) => {
				const p = this.previewing;
				if (!p || p.root !== e.payload.root || p.slug !== e.payload.slug) return;
				const key = previewKey(p);
				if (key) terminalHandle(key)?.write(e.payload.data);
			})
		]).then(() => {});
		return this.#listening;
	}

	#setOwner(label: string | null) {
		this.owner = label;
		if (this.mine && !this.#stop) this.#start();
		else if (!this.mine && this.#stop) {
			this.#stop();
			this.#stop = null;
			this.#build = null;
			this.previewing = null;
		}
	}

	#start() {
		this.#sent = '';
		this.#stop = $effect.root(() => {
			// The theme writes its colors on <html> (theme.svelte.ts): a write re-sends them.
			let themeTick = $state(0);
			const observer = new MutationObserver(() => themeTick++);
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme-type'] });
			// The previewed terminal printed: its rows are read again, at most every PREVIEW_REFRESH_MS.
			let previewTick = $state(0);
			$effect(() => {
				const p = this.previewing;
				const key = p && previewKey(p);
				if (!key) return;
				let pending: ReturnType<typeof setTimeout> | undefined;
				const off = tapOutput(key, () => {
					pending ??= setTimeout(() => {
						pending = undefined;
						previewTick++;
					}, PREVIEW_REFRESH_MS);
				});
				return () => {
					off();
					clearTimeout(pending);
				};
			});
			let timer: ReturnType<typeof setTimeout> | undefined;
			$effect(() => {
				void themeTick;
				void previewTick;
				const snapshot = snapshotNow(this.previewing);
				this.#build = () => snapshot;
				clearTimeout(timer);
				timer = setTimeout(() => this.#publish(), PUBLISH_DELAY_MS);
			});
			return () => {
				observer.disconnect();
				clearTimeout(timer);
			};
		});
	}

	#publish() {
		if (!this.mine || !this.#build) return;
		const snapshot = this.#build();
		const json = JSON.stringify(snapshot);
		if (json === this.#sent) return;
		this.#sent = json;
		invoke('board_popout_publish', { snapshot }).catch((e) => clientLog('error', `board_popout_publish: ${e}`));
	}
}

/** The terminal of task `slug` in this window: its agent CLI, else the first agent running in one of its panes. */
function previewKey(p: PreviewTarget): string | null {
	if (!p.slug || p.root !== (workspace.root ?? '')) return null;
	return cliSessions.key(p.slug) ?? paneAgents.rows(p.slug)[0]?.id ?? null;
}

/** The previewed card's last terminal rows; null when this window shows no terminal of it. */
function previewNow(p: PreviewTarget): PopoutPreview {
	const key = previewKey(p);
	const tail = key ? terminalHandle(key)?.tail?.(PREVIEW_SCROLLBACK_ROWS) : undefined;
	return { key: `${p.root}\u0000${p.slug}`, lines: tail ? previewLines(tail.rows, tail.screenRows) : null };
}

/** The agent board of every project, as the pop-out draws it (reads the reactive stores). */
function snapshotNow(previewing: PreviewTarget | null): PopoutSnapshot {
	const here = workspace.root ?? '';
	const entries = [
		...adeTasks.views.map((view) => ({ root: here, view, branch: adeTasks.branchOf(view.meta.slug) || null })),
		...projects.all.map((e) => ({ root: e.root, view: e.view, branch: projects.worktrees(e.root).find((w) => w.slug === e.view.meta.slug)?.branch ?? null }))
	];
	const unread = new Set(agentInbox.items.filter((i) => !i.read).map((i) => `${i.root ?? here}\u0000${i.slug}`));
	const root = document.documentElement;
	return {
		lanes: popoutLanes(entries, unread, settings.get<boolean>('kingu.board.showIdle') === true, COLUMNS, { label: t('adeWorkflow.board.idle'), hint: t('adeWorkflow.board.idleHint') }),
		projects: [here, ...projects.others].filter(Boolean).map((r) => ({ id: r, label: projectName(r) })),
		here,
		width: settings.get<number>('kingu.board.columnWidth'),
		opacity: Math.round(settings.get<number>('kingu.board.opacity') * 100),
		locale: locale(),
		theme: { vars: cssVariables(root.style), dark: root.dataset.themeType === 'dark' },
		preview: previewing ? previewNow(previewing) : null
	};
}

export const boardPopout = new BoardPopoutFeed();
