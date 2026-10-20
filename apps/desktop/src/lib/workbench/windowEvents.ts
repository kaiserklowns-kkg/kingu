// Events Rust sends to one window (`emit_to`): its folder's file watcher, its close request, the
// menu bar click while it is the active window, a `kingu` CLI request for it. A plain `listen`
// would also hear the ones meant for another window, so these listen on the current window only.

import { listen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

/** `listen`, limited to events for this window (any window outside Tauri, e.g. in tests). */
export function listenWindow<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
	let current: ReturnType<typeof getCurrentWebviewWindow> | null = null;
	try {
		current = getCurrentWebviewWindow();
	} catch {
		current = null;
	}
	return current ? current.listen<T>(event, handler) : listen<T>(event, handler);
}

/** This window's label (`main`, `window-1`, …); `main` outside Tauri. */
export function windowLabel(): string {
	try {
		return getCurrentWebviewWindow().label;
	} catch {
		return 'main';
	}
}
