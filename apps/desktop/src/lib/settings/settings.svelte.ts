// Settings service (VS Code: IConfigurationService). Reads the user and workspace settings.json
// through Rust, layers them over the schema defaults, and writes edits back as text edits so
// comments in the files survive. Re-reads on window focus (files edited outside Kingu).

import { invoke } from '@tauri-apps/api/core';
import { parseSettingsText, setProperty } from './jsonc';
import { resolveSettings, SCHEMA, type Resolved, type SettingScope } from './registry';

type SettingsFile = { path: string; content: string | null };
type Layer = { path: string; text: string | null; values: Record<string, unknown>; error: string | null };

const emptyLayer = (): Layer => ({ path: '', text: null, values: {}, error: null });

/** Editor tab key of the Settings editor, and of the user settings.json (lives outside the workspace). */
export const SETTINGS_EDITOR_KEY = 'settings://';
export const USER_SETTINGS_KEY = 'settings://user/settings.json';
export const WORKSPACE_SETTINGS_PATH = '.kingu/settings.json';

class Settings {
	user = $state<Layer>(emptyLayer());
	workspace = $state<Layer>(emptyLayer());
	loaded = $state(false);
	readonly resolved: Map<string, Resolved> = $derived(resolveSettings(this.user.values, this.workspace.values));
	private writes = Promise.resolve();

	/** The effective value (workspace over user over default). */
	get<T = unknown>(id: string): T {
		return (this.resolved.get(id)?.value ?? SCHEMA.get(id)?.default) as T;
	}

	/** The value set in one scope's file, or undefined. */
	inspect(id: string, scope: SettingScope): unknown {
		return (scope === 'user' ? this.user : this.workspace).values[id];
	}

	async load() {
		const [user, workspace] = await Promise.all([this.read('user'), this.read('workspace')]);
		// Unchanged files keep their layer object, so re-reading on focus re-applies nothing.
		const same = (a: Layer, b: Layer) => a.path === b.path && a.text === b.text && a.error === b.error;
		if (!same(user, this.user)) this.user = user;
		if (!same(workspace, this.workspace)) this.workspace = workspace;
		this.loaded = true;
	}

	private async read(scope: SettingScope): Promise<Layer> {
		const prev = scope === 'user' ? this.user : this.workspace;
		try {
			const file = await invoke<SettingsFile>('settings_read', { scope });
			return parseLayer(file, prev);
		} catch (e) {
			return { ...prev, error: String(e) };
		}
	}

	/** Sets (or with `undefined`, resets) a setting in `scope`'s file. Writes are serialized. */
	set(id: string, value: unknown, scope: SettingScope): Promise<void> {
		const run = async () => {
			const layer = await this.read(scope);
			// Editing text that does not parse could lose what the user wrote; they fix it first.
			if (layer.error) throw new Error(`${layer.path}: ${layer.error}`);
			const text = setProperty(layer.text ?? '', id, value);
			await invoke('settings_write', { scope, content: text });
			const next = parseLayer({ path: layer.path, content: text }, layer);
			if (scope === 'user') this.user = next;
			else this.workspace = next;
		};
		const p = this.writes.then(run);
		this.writes = p.catch(() => {});
		return p;
	}

	/** Makes sure a scope's file exists (before opening it in the editor). */
	async ensureFile(scope: SettingScope): Promise<void> {
		const layer = await this.read(scope);
		if (layer.text === null) await invoke('settings_write', { scope, content: '{\n}\n' });
	}

	/** Keeps re-reading the files when the window regains focus. Returns an uninstaller. */
	install(): () => void {
		void this.load();
		const onFocus = () => void this.load();
		window.addEventListener('focus', onFocus);
		return () => window.removeEventListener('focus', onFocus);
	}
}

/** A parse error keeps the previous values, like VS Code keeps the last valid configuration. */
function parseLayer(file: SettingsFile, prev: Layer): Layer {
	const text = file.content;
	if (text === null) return { path: file.path, text, values: {}, error: null };
	try {
		return { path: file.path, text, values: parseSettingsText(text), error: null };
	} catch (e) {
		return { path: file.path, text, values: prev.values, error: e instanceof Error ? e.message : String(e) };
	}
}

export const settings = new Settings();
