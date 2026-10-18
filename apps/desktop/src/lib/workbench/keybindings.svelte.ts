// The user's keybindings.json (VS Code: IKeybindingService's user layer), read through Rust from
// the app config dir. Re-read on window focus and after the file is saved in Kingu; a file that
// does not parse keeps the last good bindings and says so in the status bar.

import { invoke } from '@tauri-apps/api/core';
import { status } from './status.svelte';
import { NO_USER_KEYBINDINGS, parseKeybindings, userKeybindings, type UserKeybindings } from './keybindingsModel';

/** Editor tab key of the user keybindings.json (outside the workspace, like the user settings.json). */
export const USER_KEYBINDINGS_KEY = 'settings://user/keybindings.json';

class Keybindings {
	user = $state.raw<UserKeybindings>(NO_USER_KEYBINDINGS);
	error = $state('');
	#text: string | null | undefined;

	async load() {
		let text: string | null;
		try {
			text = (await invoke<{ content: string | null }>('settings_read', { scope: 'keybindings' })).content;
		} catch (e) {
			this.error = String(e);
			return;
		}
		if (text === this.#text) return;
		this.#text = text;
		try {
			this.user = userKeybindings(parseKeybindings(text ?? ''));
			this.error = '';
		} catch (e) {
			this.error = `keybindings.json: ${e instanceof Error ? e.message : e}`;
			status.flash(`${this.error} — ใช้คีย์ลัดชุดล่าสุดที่อ่านได้`, 8000);
		}
	}

	install(): () => void {
		void this.load();
		const onFocus = () => void this.load();
		window.addEventListener('focus', onFocus);
		return () => window.removeEventListener('focus', onFocus);
	}
}

export const keybindings = new Keybindings();
