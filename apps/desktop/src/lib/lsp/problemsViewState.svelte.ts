// The Problems view's state (VS Code: MarkersView's filters and panel state): the filter box,
// the filter toggles, tree/table, single or multi line messages, the selected problem and the
// collapsed files. Filters and the view mode are kept per workspace, like VS Code's Markers panel
// state (workspaceStorage).

import { SvelteSet } from 'svelte/reactivity';
import { enabledGlobs } from '#lib/settings/mappings.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { workspaceStorage } from '#lib/workbench/workspaceStorage.svelte.ts';
import { uriToPath } from './convert';
import { lsp } from './lsp.svelte';
import type { ProblemFile } from './model';
import type { Diagnostic } from './protocol';
import { filterProblems, isFiltering, type ProblemsFilterState } from './problemsFilter';

const KEY = 'kingu.problems.view';
const PERSISTED = ['text', 'showErrors', 'showWarnings', 'showInfos', 'activeFile', 'excludedFiles', 'multiline'] as const;

/** What an older build kept for every window (it goes to the first workspace opened). */
function readLegacy(): unknown {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? 'null');
	} catch {
		return null;
	}
}

/** A workspace opened for the first time: no filter, every severity, messages on several lines. */
const DEFAULTS = { text: '', showErrors: true, showWarnings: true, showInfos: true, activeFile: false, excludedFiles: false, multiline: true };

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
		workspaceStorage.register(
			KEY,
			[...PERSISTED, 'mode'],
			(saved) => {
				const s = saved ?? {};
				for (const k of PERSISTED) (this as Record<string, unknown>)[k] = typeof s[k] === typeof DEFAULTS[k] ? s[k] : DEFAULTS[k];
				this.#mode = s.mode === 'tree' || s.mode === 'table' ? s.mode : null;
				this.collapsed.clear();
				this.selected = null;
			},
			readLegacy()
		);
		$effect.root(() => {
			$effect(() => {
				workspaceStorage.save(KEY, { ...Object.fromEntries(PERSISTED.map((k) => [k, this[k]])), mode: this.#mode });
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
