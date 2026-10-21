// Search Editors (VS Code: SearchEditorInput / SearchEditor): Find in Files with its results in an
// editor tab, as text in the `.code-search` format (searchEditor.ts). Untitled ones are keyed
// `search-editor:<n>`; a workspace `.code-search` file opens here too and saves back to itself.
// Searches run in Rust's Search Editor slot (`search_editor_text`), with context lines, so they
// never cancel the Search view's search.

import { Channel, invoke } from '@tauri-apps/api/core';
import { SvelteMap } from 'svelte/reactivity';
import { clientLog } from '#lib/client-log.ts';
import { searchSettingsFrom } from '#lib/settings/mappings.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { editors } from './editors.svelte';
import { registerSaver } from './editorModels';
import {
	initialConfig,
	InvalidQueryError,
	isSearchEditorKey,
	isSearchFilePath,
	isUntitledSearchEditor,
	parseSerializedSearchEditor,
	searchEditorDirty,
	serializeForDisk,
	serializeSearchResults,
	suggestedSearchFileName,
	untitledSearchEditorKey,
	type EditorFile,
	type MatchRange,
	type ResultLabels,
	type SearchConfig
} from './searchEditor';
import { sortResults, type FileMatches, type ResultSortOrder, type SearchOptions, type TextMatch } from './searchResults';
import { workspace } from './workspace.svelte';

/** Mirrors Rust `search::SearchEvent` with the Search Editor's whole lines. */
type EditorSearchEvent =
	| { kind: 'file'; path: string; matches: TextMatch[]; version: string; modified: number; lines?: EditorFile['lines'] }
	| { kind: 'done'; files: number; matches: number; limit_hit: boolean; elapsed_ms: number }
	| { kind: 'error'; message: string };

/** The prior Search Editor's configuration (VS Code keeps it per workspace in a memento). */
const PRIOR_KEY = 'kingu.searchEditor.prior';

function readPrior(): Partial<SearchConfig> | null {
	try {
		const all = JSON.parse(localStorage.getItem(PRIOR_KEY) ?? '{}') as Record<string, Partial<SearchConfig>>;
		return all[workspace.root ?? ''] ?? null;
	} catch {
		return null;
	}
}

function writePrior(config: SearchConfig) {
	try {
		const all = JSON.parse(localStorage.getItem(PRIOR_KEY) ?? '{}') as Record<string, Partial<SearchConfig>>;
		all[workspace.root ?? ''] = config;
		localStorage.setItem(PRIOR_KEY, JSON.stringify(all));
	} catch {
		// Storage can be unavailable; new editors then start from the defaults.
	}
}

const labels = (): ResultLabels => ({
	results: (count) => t('searchEditor.results', { count }),
	files: (count) => t('searchEditor.files', { count }),
	noResults: t('searchEditor.noResults'),
	limitHit: t('searchEditor.limitHit')
});

export class SearchEditorState {
	config = $state<SearchConfig>(initialConfig({}, null, false, 0));
	/** The results text (what the editor shows and a saved file holds after its header). */
	text = $state('');
	matchRanges = $state.raw<MatchRange[]>([]);
	running = $state(false);
	error = $state('');
	/** Context lines when the toggle turned them off, to bring back (VS Code's toggleContextLines). */
	lastContextLines = 1;
	/** Bumped to ask the view to focus its query input, or its results. */
	focusInput = $state(0);
	focusResults = $state(0);
	/** False until a `.code-search` file has been read. */
	loaded = $state(true);
	generation = 0;
	/** The editor key; Save As moves an untitled editor to its file. */
	key = $state('');
	/** What the editor last saved or opened with (`.code-search` text); dirty when it differs. */
	saved = $state('');
	dirty = $derived(searchEditorDirty(this.saved, this.config, this.text));
	constructor(key: string) {
		this.key = key;
	}
	/** The current query, options and results become the saved state (after Save, open, a new editor). */
	markSaved() {
		this.saved = serializeForDisk($state.snapshot(this.config) as SearchConfig, this.text);
	}
}

class SearchEditors {
	#states = new SvelteMap<string, SearchEditorState>();
	#next = 1;
	/** The editor whose search runs in the Rust slot now (a new search there cancels it). */
	#running: SearchEditorState | null = null;

	#watchers = new Map<SearchEditorState, () => void>();

	/** The tab's dirty dot (and Save / Don't Save on close) follows the state's dirty flag. */
	#track(s: SearchEditorState) {
		let shown: string | null = null;
		this.#watchers.set(
			s,
			$effect.root(() => {
				$effect(() => {
					const key = s.key;
					const dirty = s.dirty;
					if (shown && shown !== key) editors.setDirty(shown, false);
					shown = key;
					editors.setDirty(key, dirty);
				});
				return () => {
					if (shown) editors.setDirty(shown, false);
				};
			})
		);
	}

	#add(key: string, s: SearchEditorState) {
		this.#states.set(key, s);
		this.#track(s);
	}

	/** Whether `key` has unsaved changes (Save All, hot exit). */
	isDirty(key: string): boolean {
		return this.#states.get(key)?.dirty ?? false;
	}

	/** The state of `key` if it exists (for labels: reading never creates one). */
	peek(key: string): SearchEditorState | undefined {
		return this.#states.get(key);
	}

	/** The state of `key`, created (and a `.code-search` file read) the first time it is shown. */
	get(key: string): SearchEditorState {
		let s = this.#states.get(key);
		if (s) return s;
		s = new SearchEditorState(key);
		if (isSearchFilePath(key)) void this.#load(s);
		else {
			s.config = initialConfig({}, readPrior(), settings.get<boolean>('search.searchEditor.reusePriorSearchConfiguration'), settings.get<number | null>('search.searchEditor.defaultNumberOfContextLines'));
			s.markSaved();
		}
		this.#add(key, s);
		return s;
	}

	async #load(s: SearchEditorState) {
		s.loaded = false;
		try {
			const content = await invoke<string>('read_workspace_file', { rel: s.key });
			const { config, text } = parseSerializedSearchEditor(content);
			s.config = config;
			s.text = text;
			s.saved = content;
			s.lastContextLines = config.contextLines || 1;
			// VS Code re-runs a saved search when it opens, so the results are current.
			if (config.query) void this.run(s.key);
		} catch (e) {
			s.error = e instanceof InvalidQueryError ? t('searchEditor.invalidQuery') : t('searchEditor.openFailed', { error: String(e) });
		} finally {
			s.loaded = true;
		}
	}

	/** Drops the state of editors no tab shows any more. */
	prune(open: ReadonlySet<string>) {
		for (const [key, s] of [...this.#states]) {
			if (open.has(key)) continue;
			this.#states.delete(key);
			this.#watchers.get(s)?.();
			this.#watchers.delete(s);
		}
	}

	/**
	 * Search: New Search Editor / Open Search Editor (VS Code's openNewSearchEditor): a new untitled
	 * editor seeded with `given` (the Search view's query and options, or the editor selection), pinned
	 * in the active group or the one to the side. A query searches at once with `search.searchOnType`
	 * or `triggerSearch`.
	 */
	openNew(given: Partial<SearchConfig> = {}, { toSide = false, triggerSearch }: { toSide?: boolean; triggerSearch?: boolean } = {}): string {
		// Tabs restored from the last session keep their keys.
		const open = editors.openPaths();
		let key = untitledSearchEditorKey(this.#next++);
		while (open.has(key) || this.#states.has(key)) key = untitledSearchEditorKey(this.#next++);
		const s = new SearchEditorState(key);
		s.config = initialConfig(given, readPrior(), settings.get<boolean>('search.searchEditor.reusePriorSearchConfiguration'), settings.get<number | null>('search.searchEditor.defaultNumberOfContextLines'));
		s.lastContextLines = s.config.contextLines || 1;
		s.markSaved();
		this.#add(key, s);
		if (toSide) editors.openToSide(key);
		else editors.open(key, { preview: false });
		const search = triggerSearch === true || (triggerSearch !== false && settings.get<boolean>('search.searchOnType') && !!s.config.query);
		if (search) void this.run(key);
		else s.focusInput++;
		return key;
	}

	/** The Search view's search, as options for Rust (search.svelte.ts's, plus the context lines). */
	#options(c: SearchConfig): SearchOptions & { context_lines: number } {
		return {
			query: c.query,
			is_regex: c.isRegexp,
			match_case: c.isCaseSensitive,
			whole_word: c.matchWholeWord,
			include: c.filesToInclude,
			exclude: c.filesToExclude,
			use_ignore_files: c.useExcludeSettingsAndIgnoreFiles && settings.get<boolean>('search.useIgnoreFiles'),
			...searchSettingsFrom((id) => settings.get(id), c.useExcludeSettingsAndIgnoreFiles),
			context_lines: Math.max(0, Math.floor(c.contextLines) || 0)
		};
	}

	/** Runs the editor's search (Enter, Search Again ⇧⌘R) and writes its results text. */
	async run(key: string) {
		const s = this.get(key);
		const generation = ++s.generation;
		const config = $state.snapshot(s.config) as SearchConfig;
		if (this.#running && this.#running !== s) {
			this.#running.running = false;
			this.#running.generation++;
		}
		s.error = '';
		if (!config.query) {
			s.running = false;
			s.text = '';
			s.matchRanges = [];
			invoke('search_editor_cancel').catch(() => {});
			return;
		}
		if (!workspace.root) {
			s.error = t('searchEditor.noFolder');
			return;
		}
		if (isUntitledSearchEditor(key)) writePrior(config);
		s.running = true;
		this.#running = s;
		const files: (EditorFile & { modified: number })[] = [];
		const onEvent = new Channel<EditorSearchEvent>();
		onEvent.onmessage = (ev) => {
			if (generation !== s.generation) return;
			if (ev.kind === 'file') {
				files.push({ path: ev.path, matches: ev.matches, lines: ev.lines ?? [], modified: ev.modified });
				return;
			}
			s.running = false;
			if (this.#running === s) this.#running = null;
			if (ev.kind === 'error') {
				s.error = ev.message;
				return;
			}
			// search.sortOrder, like the Search view.
			const byPath = new Map(files.map((f) => [f.path, f]));
			const sorted = sortResults(files as unknown as FileMatches[], settings.get<ResultSortOrder>('search.sortOrder')).map((f) => byPath.get(f.path)!);
			const result = serializeSearchResults(sorted, { limitHit: ev.limit_hit, labels: labels() });
			s.text = result.text;
			s.matchRanges = result.matchRanges;
			// search.searchEditor.focusResultsOnSearch.
			if (settings.get<boolean>('search.searchEditor.focusResultsOnSearch')) s.focusResults++;
		};
		try {
			await invoke<number>('search_editor_text', { options: this.#options(config), onEvent });
		} catch (e) {
			if (generation !== s.generation) return;
			s.running = false;
			s.error = String(e);
			clientLog('error', `search editor: ${e}`);
		}
	}

	/** Results text after an edit of the view (typing in it, Delete File Results). */
	setText(key: string, text: string, ranges: MatchRange[]) {
		const s = this.get(key);
		s.text = text;
		s.matchRanges = ranges;
	}

	/** Toggle Context Lines (⌥⌘L): off, or back to the count it had. */
	toggleContextLines(key: string) {
		const s = this.get(key);
		if (s.config.contextLines > 0) {
			s.lastContextLines = s.config.contextLines;
			s.config.contextLines = 0;
		} else s.config.contextLines = s.lastContextLines || 1;
		void this.run(key);
	}

	/** File: Save on a Search Editor: its `.code-search` file, or Save As for an untitled one. */
	async save(key: string): Promise<boolean> {
		if (!isSearchFilePath(key)) return (await this.saveAs(key)) !== null;
		const s = this.get(key);
		const content = serializeForDisk($state.snapshot(s.config) as SearchConfig, s.text);
		try {
			await invoke('fs_write_file', { rel: key, content });
			s.saved = content;
			return true;
		} catch (e) {
			notifications.error(t('searchEditor.saveFailed', { error: String(e) }));
			return false;
		}
	}

	/** Save As: the native save dialog; a file in the folder then shows in this tab, like VS Code. */
	async saveAs(key: string): Promise<string | null> {
		const s = this.get(key);
		const slash = key.lastIndexOf('/');
		let saved: { rel: string | null; path: string } | null;
		const content = serializeForDisk($state.snapshot(s.config) as SearchConfig, s.text);
		try {
			saved = await invoke<{ rel: string | null; path: string } | null>('fs_save_as', {
				content,
				name: suggestedSearchFileName(s.config.query),
				dir: isSearchFilePath(key) && slash > 0 ? key.slice(0, slash) : null
			});
		} catch (e) {
			notifications.error(t('searchEditor.saveFailed', { error: String(e) }));
			return null;
		}
		if (!saved) return null;
		const rel = saved.rel;
		// Written (in the folder or outside it): what the editor holds is saved.
		s.saved = content;
		if (!rel) {
			notifications.info(t('searchEditor.savedOutside', { path: saved.path }));
			return null;
		}
		if (rel !== key) {
			// The tab now shows the saved file; it keeps this editor's results (no re-read).
			if (isSearchEditorKey(rel)) {
				this.#states.set(rel, s);
				this.#states.delete(key);
				editors.setDirty(key, false);
				s.key = rel;
				editors.remap((p) => (p === key ? rel : null));
			} else editors.open(rel, { preview: false });
		}
		return rel;
	}
}

export const searchEditors = new SearchEditors();

// Save All, Save on close and shutdown save a dirty Search Editor through saveFile. Auto save only
// writes `.code-search` files (an untitled one would open the Save As dialog).
registerSaver(isSearchEditorKey, (key, reason) => (reason === 'explicit' || isSearchFilePath(key) ? searchEditors.save(key) : Promise.resolve(false)));
