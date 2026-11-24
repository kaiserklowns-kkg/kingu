// The chat view's remembered state, as VS Code keeps it.
//
// The chat it showed (VS Code's ChatViewPane memento `interactive-session-view-<provider>`,
// workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.ts: `viewState.sessionResource`,
// StorageScope.WORKSPACE): each folder remembers the chat its panel showed ('' for a new chat). A
// reloaded window always shows it again; a fresh start does only with `chat.restoreLastPanelSession`
// on (the constructor clears the saved session when `startupKind !== ReloadedWindow` and the setting
// is false). A saved chat that is gone gives a new chat.
//
// The agent a new chat starts on (VS Code's remembered session type, common/constants.ts
// `getDefaultNewChatSessionTypeAndReasonFromServices` and chatSessionTypePreference.ts, StorageScope.PROFILE):
// the session target picker's last pick, while that agent is usable; picking the default forgets it
// (`recordUserSelectedSessionType`).

const SHOWN_KEY = 'kingu.chat.panelSession';
const RUNTIME_KEY = 'kingu.chat.lastRuntime';
/** sessionStorage outlives a reload of the window, not a restart (VS Code's StartupKind.ReloadedWindow). */
const LOADED_KEY = 'kingu.window.loaded';
/** Folders remembered, the most recent kept. */
const MAX_FOLDERS = 100;

/** The chat each folder's panel showed: a chat id, or '' for a new chat. */
export type ShownChats = Record<string, string>;

export function parseShown(raw: string | null): ShownChats {
	let v: unknown;
	try {
		v = raw ? JSON.parse(raw) : null;
	} catch {
		return {};
	}
	if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
	const out: ShownChats = {};
	for (const [root, id] of Object.entries(v as Record<string, unknown>)) if (root && typeof id === 'string') out[root] = id;
	return out;
}

/** `shown` with `root` showing `id` (the most recent last; the oldest go past MAX_FOLDERS). */
export function withShown(shown: ShownChats, root: string, id: string): ShownChats {
	const out = { ...shown };
	delete out[root];
	out[root] = id;
	const roots = Object.keys(out);
	for (const r of roots.slice(0, Math.max(0, roots.length - MAX_FOLDERS))) delete out[r];
	return out;
}

/**
 * What the panel shows when a folder opens: the chat it showed before (a reloaded window, or a
 * restart with `chat.restoreLastPanelSession` on), when that chat is still there; else null (a new chat).
 */
export function restoredChat(saved: string | undefined, opts: { reloaded: boolean; restoreSetting: unknown; exists: (id: string) => boolean }): string | null {
	if (!opts.reloaded && opts.restoreSetting !== true) return null;
	return saved && opts.exists(saved) ? saved : null;
}

/** The agent a new chat starts on: this panel's pick, else the remembered one while usable, else the default. */
export function newChatRuntime(picked: string | null, remembered: string | null, usable: readonly string[], fallback: string): string {
	if (picked) return picked;
	return remembered && usable.includes(remembered) ? remembered : fallback;
}

function read(storage: () => Storage, key: string): string | null {
	try {
		return storage().getItem(key);
	} catch {
		return null;
	}
}
function write(storage: () => Storage, key: string, value: string | null) {
	try {
		if (value === null) storage().removeItem(key);
		else storage().setItem(key, value);
	} catch {
		// Storage off: nothing is remembered.
	}
}

export function loadShown(root: string): string | undefined {
	return parseShown(read(() => localStorage, SHOWN_KEY))[root];
}
export function saveShown(root: string, id: string) {
	const shown = parseShown(read(() => localStorage, SHOWN_KEY));
	if (shown[root] === id) return;
	write(() => localStorage, SHOWN_KEY, JSON.stringify(withShown(shown, root, id)));
}

export function loadRuntime(): string | null {
	return read(() => localStorage, RUNTIME_KEY) || null;
}
/** The target picker's pick; the default forgets the remembered one (VS Code's recordUserSelectedSessionType). */
export function saveRuntime(id: string, defaultRuntime: string) {
	write(() => localStorage, RUNTIME_KEY, id === defaultRuntime ? null : id);
}

/** This page load is a reload of the window (read once, when this module loads). */
const reloadedWindow = (() => {
	const was = read(() => sessionStorage, LOADED_KEY) === '1';
	write(() => sessionStorage, LOADED_KEY, '1');
	return was;
})();
let reloadPending = reloadedWindow;
/** True once per page load, for a reloaded window: the first folder the panel opens restores its chat. */
export function takeReload(): boolean {
	const r = reloadPending;
	reloadPending = false;
	return r;
}
