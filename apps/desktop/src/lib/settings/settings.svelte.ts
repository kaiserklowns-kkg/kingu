// Settings service (VS Code: IConfigurationService). Reads the user and workspace settings.json
// through Rust, layers them over the schema defaults, and writes edits back as text edits so
// comments in the files survive. Re-reads on window focus (files edited outside Kingu).

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { parseSettingsText, setProperty } from './jsonc';
import { resolveSettings, settingProblems, type Resolved, type SettingProblem, type SettingScope } from './registry';
import { settingSchemas } from './schemas.svelte';
import { profileUserValues, sharedByAllProfiles } from './profiles';
import { isLanguageOverridable, languageBlockValue, languageSchemas, languageValues, withLanguageValue } from './languageOverrides';
import { withoutRestricted } from './restricted';

type SettingsFile = { path: string; content: string | null };
/** The files behind the layers: `defaultUser` is the Default profile's settings.json (profiles.ts). */
type FileScope = SettingScope | 'defaultUser';
type Layer = { path: string; text: string | null; values: Record<string, unknown>; error: string | null };

const emptyLayer = (): Layer => ({ path: '', text: null, values: {}, error: null });

/** Editor tab key of the Settings editor, and of the user settings.json (lives outside the workspace). */
export const SETTINGS_EDITOR_KEY = 'settings://';
export const USER_SETTINGS_KEY = 'settings://user/settings.json';
export const WORKSPACE_SETTINGS_PATH = '.kingu/settings.json';

class Settings {
	user = $state<Layer>(emptyLayer());
	workspace = $state<Layer>(emptyLayer());
	/** Kingu's per-repository overrides of the open folder (Orca's per-repo settings), kept in the app config dir. */
	repo = $state<Layer>(emptyLayer());
	/** The Default profile's settings.json: the same file as `user` unless another profile is
	 * active, when it still holds the application-scoped settings (VS Code). */
	defaultUser = $state<Layer>(emptyLayer());
	/** Another profile than Default is active (its settings.json is not the Default one). */
	readonly inProfile: boolean = $derived(this.user.path !== '' && this.defaultUser.path !== '' && this.user.path !== this.defaultUser.path);
	readonly #userValues: Record<string, unknown> = $derived(this.inProfile ? profileUserValues(this.user.values, this.defaultUser.values, settingSchemas.all) : this.user.values);
	loaded = $state(false);
	/** `settings` of the `.code-workspace` file the folder was opened from: workspace settings under
	 * the folder's own `.kingu/settings.json` (VS Code: workspace file < folder settings). */
	workspaceFile = $state.raw<Record<string, unknown>>({});
	/** Workspace Trust (workspaceTrust.svelte.ts keeps it current): in Restricted Mode the folders'
	 * own settings files do not set restricted settings (restricted.ts). */
	trusted = $state(true);
	/** The folders' settings as this window may use them. */
	#folderValues(values: Record<string, unknown>): Record<string, unknown> {
		return this.trusted ? values : withoutRestricted(values);
	}
	readonly resolved: Map<string, Resolved> = $derived(resolveSettings(this.#userValues, this.#folderValues({ ...this.workspaceFile, ...this.workspace.values }), settingSchemas.all, this.repo.values));
	/** Folder settings of the other root folders of a multi-root window (each one's
	 * `.kingu/settings.json`), by folder path. Like VS Code's folder settings they apply to that
	 * folder's files only (what a language server asks for a resource of it); the first folder's
	 * file is `workspace`. */
	folders = $state.raw<Record<string, Layer>>({});
	readonly #folderResolved: Map<string, Map<string, Resolved>> = $derived(
		new Map(Object.entries(this.folders).map(([path, layer]) => [path, resolveSettings(this.#userValues, this.#folderValues({ ...this.workspaceFile, ...layer.values }), settingSchemas.all)]))
	);
	#folderPaths: string[] = [];
	/** Values the files set but that are ignored (wrong type, out of range, user-only in the workspace file). */
	readonly problems: SettingProblem[] = $derived([
		...settingProblems(this.user.values, 'user', settingSchemas.all),
		...settingProblems(this.workspace.values, 'workspace', settingSchemas.all),
		...settingProblems(this.repo.values, 'repo', settingSchemas.all)
	]);
	private writes = Promise.resolve();
	#written = new Set<(scope: SettingScope) => void>();

	/** Called after the settings UI rewrote a file, so an open settings.json tab shows the change. */
	onDidWrite(fn: (scope: SettingScope) => void): () => void {
		this.#written.add(fn);
		return () => this.#written.delete(fn);
	}

	/** The effective value (repo over workspace over user over default). */
	get<T = unknown>(id: string): T {
		return (this.resolved.get(id)?.value ?? settingSchemas.byId.get(id)?.default) as T;
	}

	/** Each language's resolved settings, computed on first use; a new (empty) cache whenever a layer changes. */
	readonly #languageCache: Map<string, Map<string, Resolved>> = $derived.by(() => {
		void this.resolved;
		return new Map();
	});

	#forLanguage(language: string): Map<string, Resolved> {
		const cache = this.#languageCache;
		let resolved = cache.get(language);
		if (!resolved) {
			const byId = settingSchemas.byId;
			const overridable = (id: string) => {
				const s = byId.get(id);
				return !!s && isLanguageOverridable(s);
			};
			resolved = resolveSettings(
				languageValues(this.#userValues, language, overridable),
				languageValues(this.#folderValues({ ...this.workspaceFile, ...this.workspace.values }), language, overridable),
				languageSchemas(settingSchemas.all, language),
				languageValues(this.repo.values, language, overridable)
			);
			cache.set(language, resolved);
		}
		return resolved;
	}

	/**
	 * The effective value for a file of `language`: each layer's `[language]` blocks over its own
	 * values, and the built-in language defaults under the user's (VS Code's overrideIdentifier).
	 * Settings that cannot be overridden, and no language, read like `get`.
	 */
	getFor<T = unknown>(id: string, language: string | undefined): T {
		if (!language) return this.get<T>(id);
		const r = this.#forLanguage(language).get(id);
		return (r ? r.value : this.get<T>(id)) as T;
	}

	/** `getFor` bound to one language, for the mappings that take a `get`. */
	getterFor(language: string | undefined): <T = unknown>(id: string) => T {
		return <T>(id: string) => this.getFor<T>(id, language);
	}

	/** What the user's settings set (application-scoped ones from the Default profile), unvalidated,
	 * or undefined: for settings that decide how the folders' layers apply (Workspace Trust). */
	userValue(id: string): unknown {
		return this.#userValues[id];
	}

	/** The value set in one scope's file, or undefined. */
	inspect(id: string, scope: SettingScope): unknown {
		return this.layer(scope).values[id];
	}

	/** The value one scope's `[language]` block sets (the Settings editor's `@lang:`), or undefined. */
	inspectLanguage(id: string, language: string, scope: SettingScope): unknown {
		return languageBlockValue(this.layer(scope).values, language, id);
	}

	/** Sets (or with `undefined`, removes) `id` in `scope`'s `[language]` block; an emptied block goes. */
	setLanguage(id: string, language: string, value: unknown, scope: SettingScope): Promise<void> {
		const { key, block } = withLanguageValue(this.layer(scope).values, language, id, value);
		return this.set(key, block, scope);
	}

	/** The settings in effect for a file of root folder `folder` (its path): that folder's file over
	 * the workspace file's settings over the user's. The first folder (or none) is `resolved`. */
	resolvedIn(folder: string | null | undefined): Map<string, Resolved> {
		return (folder && this.#folderResolved.get(folder)) || this.resolved;
	}

	/** The value root folder `folder`'s own settings file sets (the first folder's: `workspace`). */
	inspectFolder(id: string, folder: string): unknown {
		return this.folders[folder]?.values[id];
	}

	/** The window's root folders changed: reads the folder settings of every folder but the first. */
	setFolders(paths: readonly string[]) {
		this.#folderPaths = paths.slice(1);
		void this.#loadFolders();
	}

	async #loadFolders() {
		const paths = this.#folderPaths;
		const layers = await Promise.all(
			paths.map(async (folder) => {
				const prev = this.folders[folder] ?? emptyLayer();
				try {
					return parseLayer(await invoke<SettingsFile>('settings_read_folder', { folder }), prev);
				} catch (e) {
					return { ...prev, error: String(e) };
				}
			})
		);
		if (paths !== this.#folderPaths) return;
		const same = (a: Layer, b: Layer | undefined) => !!b && a.path === b.path && a.text === b.text && a.error === b.error;
		const next = Object.fromEntries(paths.map((p, i) => [p, same(layers[i], this.folders[p]) ? this.folders[p] : layers[i]]));
		const changed = paths.length !== Object.keys(this.folders).length || paths.some((p) => next[p] !== this.folders[p]);
		if (changed) this.folders = next;
	}

	/** Where the effective value comes from. */
	sourceOf(id: string): Resolved['source'] {
		return this.resolved.get(id)?.source ?? 'default';
	}

	layer(scope: SettingScope): Layer {
		return scope === 'user' ? this.user : scope === 'workspace' ? this.workspace : this.repo;
	}

	#layerOf(scope: FileScope): Layer {
		return scope === 'defaultUser' ? this.defaultUser : this.layer(scope);
	}

	async load() {
		const [user, workspace, repo, defaultUser] = await Promise.all([this.read('user'), this.read('workspace'), this.read('repo'), this.read('defaultUser')]);
		// Unchanged files keep their layer object, so re-reading on focus re-applies nothing.
		const same = (a: Layer, b: Layer) => a.path === b.path && a.text === b.text && a.error === b.error;
		if (!same(user, this.user)) this.user = user;
		if (!same(workspace, this.workspace)) this.workspace = workspace;
		if (!same(repo, this.repo)) this.repo = repo;
		if (!same(defaultUser, this.defaultUser)) this.defaultUser = defaultUser;
		if (this.#folderPaths.length) await this.#loadFolders();
		this.loaded = true;
	}

	/** Open Folder / Close Folder: drop the old folder's layer and read the new folder's file. */
	async reloadWorkspace() {
		this.workspace = emptyLayer();
		this.repo = emptyLayer();
		await this.load();
	}

	private async read(scope: FileScope): Promise<Layer> {
		const prev = this.#layerOf(scope);
		try {
			const file = await invoke<SettingsFile>('settings_read', { scope });
			return parseLayer(file, prev);
		} catch (e) {
			return { ...prev, error: String(e) };
		}
	}

	/** Sets (or with `undefined`, resets) a setting in `scope`'s file. Writes are serialized. */
	set(id: string, value: unknown, scope: SettingScope): Promise<void> {
		// With a profile active, settings shared by all profiles (application-scoped ones and
		// workbench.settings.applyToAllProfiles) are written to the Default profile's file.
		const file: FileScope = scope === 'user' && this.inProfile && sharedByAllProfiles(id, settingSchemas.byId.get(id), this.defaultUser.values) ? 'defaultUser' : scope;
		const run = async () => {
			const layer = await this.read(file);
			// Editing text that does not parse could lose what the user wrote; they fix it first.
			if (layer.error) throw new Error(`${layer.path}: ${layer.error}`);
			const text = setProperty(layer.text ?? '', id, value);
			await invoke('settings_write', { scope: file, content: text });
			const next = parseLayer({ path: layer.path, content: text }, layer);
			if (file === 'defaultUser') this.defaultUser = next;
			else if (scope === 'user') this.user = next;
			else if (scope === 'workspace') this.workspace = next;
			else this.repo = next;
			for (const fn of this.#written) fn(scope);
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

	/** Keeps re-reading the files when the window regains focus and when Rust sees a settings file
	 * change (`settings://changed`, edits made while Kingu has focus). Returns an uninstaller. */
	install(): () => void {
		void this.load();
		const onFocus = () => void this.load();
		window.addEventListener('focus', onFocus);
		const unlisten = listen<string>('settings://changed', (e) => e.payload !== 'keybindings' && void this.load());
		return () => {
			window.removeEventListener('focus', onFocus);
			void unlisten.then((u) => u());
		};
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
