// The Problems view's state (VS Code: MarkersView's filters and panel state): the filter box,
// the filter toggles, tree/table, single or multi line messages, the selected problem and the
// collapsed files. Filters and the view mode last across reloads like VS Code's panel state.

import { SvelteSet } from 'svelte/reactivity';
import { enabledGlobs } from '#lib/settings/mappings.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { uriToPath } from './convert';
import { lsp } from './lsp.svelte';
import type { ProblemFile } from './model';
import type { Diagnostic } from './protocol';
import { filterProblems, isFiltering, type ProblemsFilterState } from './problemsFilter';

const KEY = 'kingu.problems.view';
const PERSISTED = ['text', 'showErrors', 'showWarnings', 'showInfos', 'activeFile', 'excludedFiles', 'multiline'] as const;

function readSaved(): Record<string, unknown> {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? '{}');
	} catch {
		return {};
	}
}

export type ProblemsViewMode = 'tree' | 'table';

class ProblemsView {
	text = $state('');
	showErrors = $state(true);
	showWarnings = $state(true);
	showInfos = $state(true);
	/** Show Active File Only. */
	activeFile = $state(false);
	/** Hide Excluded Files (`files.exclude`). */
	excludedFiles = $state(false);
	/** Messages on several lines (VS Code's Show message in multiple lines). */
	multiline = $state(true);
	/** View as Tree / View as Table; until chosen, problems.defaultViewMode. */
	#mode = $state<ProblemsViewMode | null>(null);
	collapsed = new SvelteSet<string>();
	/** The selected problem (Copy / Copy Message, Enter, ⌘Enter). */
	selected = $state.raw<{ file: ProblemFile; item: Diagnostic } | null>(null);
	/** The view focuses its filter box when this is set, then clears it. */
	focusFilterRequested = $state(false);

	filter: ProblemsFilterState = $derived({
		text: this.text,
		showErrors: this.showErrors,
		showWarnings: this.showWarnings,
		showInfos: this.showInfos,
		activeFile: this.activeFile ? (editors.active ?? '') : null,
		filesExclude: this.excludedFiles ? enabledGlobs(settings.get('files.exclude')) : []
	});
	result = $derived(filterProblems(lsp.problems, this.filter, (f) => uriToPath(f.uri) ?? f.label));
	filtering = $derived(isFiltering(this.filter));

	constructor() {
		const saved = readSaved();
		for (const k of PERSISTED) if (k in saved && typeof saved[k] === typeof this[k]) (this as Record<string, unknown>)[k] = saved[k];
		if (saved.mode === 'tree' || saved.mode === 'table') this.#mode = saved.mode;
		$effect.root(() => {
			$effect(() => {
				const snapshot = { ...Object.fromEntries(PERSISTED.map((k) => [k, this[k]])), mode: this.#mode };
				try {
					localStorage.setItem(KEY, JSON.stringify(snapshot));
				} catch {
					// Storage unavailable: the filters reset on the next launch.
				}
			});
		});
	}

	get mode(): ProblemsViewMode {
		return this.#mode ?? (settings.get<string>('problems.defaultViewMode') === 'table' ? 'table' : 'tree');
	}
	set mode(mode: ProblemsViewMode) {
		this.#mode = mode;
	}

	toggle(uri: string) {
		if (this.collapsed.has(uri)) this.collapsed.delete(uri);
		else this.collapsed.add(uri);
	}

	collapseAll() {
		for (const f of this.result.files) this.collapsed.add(f.uri);
	}

	clearFilter() {
		this.text = '';
	}

	/** Focus problems view (VS Code: ⌘↓ from the filter box): the first row. */
	focusList() {
		document.querySelector<HTMLElement>('[data-problems-view] button:not([disabled])')?.focus();
	}

	/**
	 * Keys of the filter box (VS Code's, bound to the box rather than globally so they leave the
	 * editor's and the terminal's alone): Escape clears it, ⌘↓ moves to the list.
	 */
	filterKeydown(e: KeyboardEvent) {
		const mod = e.metaKey || e.ctrlKey;
		if (e.key === 'Escape' && this.text) this.clearFilter();
		else if (mod && e.key === 'ArrowDown') this.focusList();
		else return;
		e.preventDefault();
		e.stopPropagation();
	}

	/** ⌘F in the list focuses the filter box. */
	listKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !e.shiftKey && !e.altKey) {
			e.preventDefault();
			e.stopPropagation();
			this.focusFilterRequested = true;
		}
	}
}

export const problemsView = new ProblemsView();
