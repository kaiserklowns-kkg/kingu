// Find in Files state (VS Code: SearchModel). Searches run in Rust (`search_text`, ripgrep) and
// stream results per file; starting a new search makes Rust kill the previous `rg`.

import { Channel, invoke } from '@tauri-apps/api/core';
import { SvelteSet } from 'svelte/reactivity';
import { clientLog } from '#lib/client-log.ts';
import { seedFromSelection, type FileMatches, type SearchEvent, type SearchOptions } from './searchResults';

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

	files = $state.raw<FileMatches[]>([]);
	collapsed = new SvelteSet<string>();
	running = $state(false);
	/** Set when a search finished: totals for the summary line. */
	done = $state<{ files: number; matches: number; limitHit: boolean } | null>(null);
	error = $state('');
	/** The view focuses (and selects) its input when this is set, then clears it. */
	focusRequested = $state(false);

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
				pending.push({ path: ev.path, matches: ev.matches });
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
