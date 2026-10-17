// Find in Files state (VS Code: SearchModel). Searches run in Rust (`search_text`, ripgrep) and
// stream results per file; starting a new search makes Rust kill the previous `rg`.
// Replace (VS Code: ReplaceService) sends the exact matches back to Rust `search_replace`, which
// refuses files changed since the search; files open in an editor are edited in their model.

import { Channel, invoke } from '@tauri-apps/api/core';
import { SvelteSet } from 'svelte/reactivity';
import { clientLog } from '#lib/client-log.ts';
import { editors } from './editors.svelte';
import { status } from './status.svelte';
import { rebaseMatches, seedFromSelection, type FileMatches, type ReplaceEdit, type ReplaceResult, type SearchEvent, type SearchOptions, type TextMatch } from './searchResults';

/** VS Code's search-as-you-type delay (`search.searchOnTypeDebouncePeriod`). */
const DEBOUNCE_MS = 300;
/** Streamed files are appended in batches so a big result set re-renders a few times, not per file. */
const FLUSH_MS = 50;

class Search {
	query = $state('');
	matchCase = $state(false);
	wholeWord = $state(false);
	isRegex = $state(false);
	include = $state('');
	exclude = $state('');
	useIgnoreFiles = $state(true);
	showDetails = $state(false);
	showReplace = $state(false);
	replaceText = $state('');
	preserveCase = $state(false);
	replacing = $state(false);

	files = $state.raw<FileMatches[]>([]);
	collapsed = new SvelteSet<string>();
	running = $state(false);
	/** Set when a search finished: totals for the summary line. */
	done = $state<{ files: number; matches: number; limitHit: boolean } | null>(null);
	error = $state('');
	/** The view focuses (and selects) its input when this is set, then clears it. */
	focusRequested = $state(false);

	/** The options the current results came from (the query box may have changed since). */
	searched = $state.raw<SearchOptions | null>(null);
	#generation = 0;
	#debounce: ReturnType<typeof setTimeout> | undefined;

	options(): SearchOptions {
		return {
			query: this.query,
			is_regex: this.isRegex,
			match_case: this.matchCase,
			whole_word: this.wholeWord,
			include: this.include,
			exclude: this.exclude,
			use_ignore_files: this.useIgnoreFiles
		};
	}

	/** Search-as-you-type. */
	schedule() {
		clearTimeout(this.#debounce);
		this.#debounce = setTimeout(() => this.run(), DEBOUNCE_MS);
	}

	async run() {
		clearTimeout(this.#debounce);
		const generation = ++this.#generation;
		this.files = [];
		this.collapsed.clear();
		this.done = null;
		this.error = '';
		this.searched = this.query ? this.options() : null;
		if (!this.query) {
			this.running = false;
			invoke('search_cancel').catch(() => {});
			return;
		}
		this.running = true;

		let pending: FileMatches[] = [];
		let timer: ReturnType<typeof setTimeout> | undefined;
		const flush = () => {
			timer = undefined;
			if (generation !== this.#generation || !pending.length) return;
			this.files = this.files.concat(pending);
			pending = [];
		};
		const onEvent = new Channel<SearchEvent>();
		onEvent.onmessage = (ev) => {
			if (generation !== this.#generation) return;
			if (ev.kind === 'file') {
				pending.push({ path: ev.path, matches: ev.matches, version: ev.version });
				timer ??= setTimeout(flush, FLUSH_MS);
				return;
			}
			clearTimeout(timer);
			flush();
			this.running = false;
			if (ev.kind === 'done') this.done = { files: ev.files, matches: ev.matches, limitHit: ev.limit_hit };
			else this.error = ev.message;
		};
		try {
			await invoke<number>('search_text', { options: this.options(), onEvent });
		} catch (e) {
			if (generation !== this.#generation) return;
			this.running = false;
			this.error = String(e);
			clientLog('error', `search: ${e}`);
		}
	}

	/** Replaces `scope` (all results, one file, or one match) with `replaceText`. */
	async replace(scope: FileMatches[]) {
		const searched = this.searched;
		if (!searched || !scope.length || this.replacing) return;
		const models = new Map<string, { model: NonNullable<ReturnType<typeof editors.textModel>>; versionId: number }>();
		const files = scope.map((f) => {
			const model = editors.textModel(f.path);
			if (model) models.set(f.path, { model, versionId: model.getVersionId() });
			const matches = f.matches.map(({ line, column, end_column, text }) => ({ line, column, end_column, text }));
			return { path: f.path, version: f.version ?? null, matches, content: model ? model.getValue() : null };
		});
		const request = {
			pattern: { query: searched.query, is_regex: searched.is_regex, match_case: searched.match_case },
			replace: this.replaceText,
			preserve_case: this.preserveCase,
			files
		};
		this.replacing = true;
		let results: ReplaceResult[];
		try {
			results = await invoke<ReplaceResult[]>('search_replace', { request });
		} catch (e) {
			status.flash(`Replace failed: ${e}`);
			clientLog('error', `search_replace: ${e}`);
			return;
		} finally {
			this.replacing = false;
		}

		let replaced = 0;
		const problems: string[] = [];
		const applied = new Map<string, { edits: ReplaceEdit[]; version?: string }>();
		for (const r of results) {
			if (r.outcome === 'edits') {
				const m = models.get(r.path);
				// The model changed while Rust computed the edits: its columns may be off now.
				if (!m || m.model.isDisposed() || m.model.getVersionId() !== m.versionId) {
					problems.push(`${r.path}: changed in the editor`);
					continue;
				}
				m.model.pushStackElement();
				m.model.pushEditOperations(
					[],
					r.edits.map((e) => ({ range: { startLineNumber: e.line, startColumn: e.column, endLineNumber: e.line, endColumn: e.end_column }, text: e.text })),
					() => null
				);
				m.model.pushStackElement();
			} else if (r.outcome !== 'written') {
				problems.push(`${r.path}: ${r.outcome === 'stale' ? 'changed since the search' : r.message}`);
				continue;
			}
			replaced += r.replaced;
			applied.set(r.path, { edits: r.edits, version: r.version ?? undefined });
		}

		// Drop what was replaced; the file's other matches move with the text before them.
		const removed = new Map(scope.map((f) => [f.path, new Set<TextMatch>(f.matches)]));
		this.files = this.files.flatMap((f) => {
			const a = applied.get(f.path);
			if (!a) return [f];
			const gone = removed.get(f.path)!;
			const rest = rebaseMatches(
				f.matches.filter((m) => !gone.has(m)),
				a.edits
			);
			return rest.length ? [{ ...f, matches: rest, version: a.version ?? f.version }] : [];
		});
		if (this.done) {
			this.done = { ...this.done, files: this.files.length, matches: this.files.reduce((n, f) => n + f.matches.length, 0) };
		}
		const summary = `Replaced ${replaced} ${replaced === 1 ? 'occurrence' : 'occurrences'} in ${applied.size} ${applied.size === 1 ? 'file' : 'files'}`;
		status.flash(problems.length ? `${summary}; skipped ${problems.join(', ')}` : summary, problems.length ? 10000 : 5000);
		clientLog('info', `${summary}${problems.length ? ` (skipped: ${problems.join('; ')})` : ''}`);
	}

	clear() {
		this.query = '';
		void this.run();
	}

	/** `workbench.action.findInFiles`: seed from the editor selection and focus the input. */
	reveal(selection: string) {
		const seed = seedFromSelection(selection);
		if (seed !== null && seed !== this.query) {
			this.query = seed;
			void this.run();
		}
		this.focusRequested = true;
	}

	toggleCollapsed(path: string) {
		if (this.collapsed.has(path)) this.collapsed.delete(path);
		else this.collapsed.add(path);
	}

	collapseAll() {
		for (const f of this.files) this.collapsed.add(f.path);
	}
}

export const search = new Search();
