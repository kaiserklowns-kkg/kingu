// Kingu Home, the empty editor area (kingu-old's kinguHome.ts on VS Code's editor group
// watermark): the logo, the agent chats to continue across every recent folder, the recent
// projects and the watermark's shortcuts. Pure, so `bun test` covers it; KinguHome.svelte renders.

import type { MessageKey } from '#lib/i18n/index.ts';
import { historyStatus, type HistoryStatus } from '#lib/agent/chatHistory.ts';
import type { RunStatus } from '#lib/agent/events.ts';

/** Chats under Continue, and recent projects under Recent Projects, at most (kingu-old's). */
export const MAX_HOME_CHATS = 5;
export const MAX_HOME_PROJECTS = 4;

/** Mirrors Rust `agent::home::HomeChat`: a chat of a recent folder as saved in its chats.json. */
export type SavedHomeChat = {
	root: string;
	id: string;
	title: string;
	runtime: string;
	agent: string | null;
	created_at: number;
	updated_at: number;
	status: string | null;
	working: boolean;
};

/** A chat of the open folder, with its live status; `runtime` is the agent that runs it (its icon). */
export type LiveHomeChat = { id: string; title: string; runtime: string; agentName: string; at: number; status: HistoryStatus };

/** One row under Continue. */
export type HomeChatRow = { root: string; id: string; title: string; runtime: string; agentName: string; at: number; status: HistoryStatus };

const ACTIVE: ReadonlySet<HistoryStatus> = new Set(['working', 'needsInput']);

/** A saved chat's status: running when it was saved (in another window, or Kingu quit mid-turn), else how its last run ended. */
export function savedStatus(c: Pick<SavedHomeChat, 'status' | 'working'>): HistoryStatus {
	return c.working ? 'working' : historyStatus(undefined, (c.status ?? undefined) as RunStatus | undefined);
}

/**
 * The chats to pick up again: the open folder's live ones in place of its saved copy, the other
 * recent folders' as saved; the ones an agent works on or waits in first, then the most recently
 * active (kingu-old's `kinguHomeSessions`).
 */
export function homeChats(root: string | null, live: readonly LiveHomeChat[], saved: readonly SavedHomeChat[], runtimeName: (id: string) => string, max = MAX_HOME_CHATS): HomeChatRow[] {
	const rows: HomeChatRow[] = [
		...(root ? live.map((c) => ({ root, ...c })) : []),
		...saved
			.filter((c) => c.root !== root)
			.map((c) => ({ root: c.root, id: c.id, title: c.title, runtime: c.runtime || 'claude', agentName: c.agent ?? runtimeName(c.runtime), at: c.updated_at || c.created_at, status: savedStatus(c) }))
	];
	return rows.sort((a, b) => Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)) || b.at - a.at).slice(0, max);
}

/** A shortcut of the watermark (VS Code's `WatermarkEntry`). */
export type WatermarkEntry = { id: string; label: Extract<MessageKey, `home.shortcut.${string}`> };

const openChat: WatermarkEntry = { id: 'workbench.action.chat.open', label: 'home.shortcut.openChat' };
const showCommands: WatermarkEntry = { id: 'workbench.action.showCommands', label: 'home.shortcut.showCommands' };
const gotoFile: WatermarkEntry = { id: 'workbench.action.quickOpen', label: 'home.shortcut.goToFile' };
const openFile: WatermarkEntry = { id: 'workbench.action.files.openFile', label: 'home.shortcut.openFile' };
const openFolder: WatermarkEntry = { id: 'workbench.action.files.openFolder', label: 'home.shortcut.openFolder' };
const openFileFolder: WatermarkEntry = { id: 'workbench.action.files.openFileFolder', label: 'home.shortcut.openFileFolder' };
const openRecent: WatermarkEntry = { id: 'workbench.action.openRecent', label: 'home.shortcut.openRecent' };
const newUntitledFile: WatermarkEntry = { id: 'workbench.action.files.newUntitledFile', label: 'home.shortcut.newUntitledFile' };
const findInFiles: WatermarkEntry = { id: 'workbench.action.findInFiles', label: 'home.shortcut.findInFiles' };
const toggleTerminal: WatermarkEntry = { id: 'workbench.action.terminal.toggleTerminal', label: 'home.shortcut.toggleTerminal' };
const startDebugging: WatermarkEntry = { id: 'workbench.action.debug.start', label: 'home.shortcut.startDebugging' };
const openSettings: WatermarkEntry = { id: 'workbench.action.openSettings', label: 'home.shortcut.openSettings' };

/** VS Code shows at least this many, filling in from `OTHER` (shuffled). */
const MINIMUM_ENTRIES = 3;
export const OTHER_ENTRIES: readonly WatermarkEntry[] = [gotoFile, findInFiles, startDebugging, toggleTerminal, openSettings];

/**
 * The watermark's shortcuts, as VS Code picks them: with no folder open, Open Chat, Show All
 * Commands, Open Recent, Open File or Folder and New Untitled Text File on macOS (Open File and
 * Open Folder elsewhere); with a folder, Open Chat and Show All Commands plus `OTHER_ENTRIES` (in
 * `other` order, shuffled by the caller) up to three. An entry shows only when its command
 * exists and has a key (`keyFor`, the live keybinding with the user's overrides). Kingu has no
 * Open File or Folder command (⌘O is Open Folder), so Open Folder stands in for it on macOS.
 */
export function watermarkEntries(hasFolder: boolean, mac: boolean, keyFor: (id: string) => string | undefined, other: readonly WatermarkEntry[] = OTHER_ENTRIES): (WatermarkEntry & { key: string })[] {
	const withKey = (list: readonly (WatermarkEntry | undefined)[]) =>
		list.flatMap((e) => {
			const key = e && keyFor(e.id);
			return e && key ? [{ ...e, key }] : [];
		});
	const openEntries = mac ? [keyFor(openFileFolder.id) ? openFileFolder : openFolder] : [openFile, openFolder];
	const entries = withKey(hasFolder ? [openChat, showCommands] : [openChat, showCommands, openRecent, ...openEntries, mac ? newUntitledFile : undefined]);
	if (entries.length < MINIMUM_ENTRIES) entries.push(...withKey(other).slice(0, MINIMUM_ENTRIES - entries.length));
	return entries;
}

/** Fisher-Yates over a copy (VS Code's `shuffle`); `random` for tests. */
export function shuffled<T>(list: readonly T[], random: () => number = Math.random): T[] {
	const out = [...list];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}
