// Document symbols of the open files for the Outline view and the breadcrumbs (VS Code:
// IOutlineService / DocumentSymbolsOutline): the language server's when it has answered, else
// Monaco's own providers (its TypeScript/JSON/CSS/HTML workers). Also the Outline view's state:
// sort order, Follow Cursor, Filter on Type (VS Code's OutlineViewState, kept per window) and
// which elements are toggled per file.

import { SvelteMap } from 'svelte/reactivity';
import type * as Monaco from 'monaco-editor';
import { lsp } from '#lib/lsp/lsp.svelte.ts';
import type { DocumentSymbol, SymbolInformation } from '#lib/lsp/protocol.ts';
import { editors } from './editors.svelte';
import { fromMonacoSymbols, type OutlineSortOrder } from './outlineModel';

const STATE_KEY = 'kingu.outline.state';
const FALLBACK_DELAY_MS = 400;

type Saved = { sortBy?: OutlineSortOrder; followCursor?: boolean; filterOnType?: boolean; open?: boolean };

function readSaved(): Saved {
	try {
		return JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') as Saved;
	} catch {
		return {};
	}
}

class Outline {
	sortBy = $state<OutlineSortOrder>('position');
	followCursor = $state(true);
	filterOnType = $state(true);
	/** The Outline section of the Explorer is expanded (VS Code starts it collapsed). */
	open = $state(false);
	/** Symbols from Monaco's providers, for files no language server has answered for. */
	#fallback = new SvelteMap<string, DocumentSymbol[]>();
	/** Per file: elements whose expansion differs from `outline.collapseItems`. */
	#toggled = new SvelteMap<string, Set<string>>();
	#watched: { rel: string; dispose: () => void } | null = null;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#installed = false;

	constructor() {
		const s = readSaved();
		if (s.sortBy === 'position' || s.sortBy === 'name' || s.sortBy === 'kind') this.sortBy = s.sortBy;
		if (typeof s.followCursor === 'boolean') this.followCursor = s.followCursor;
		if (typeof s.filterOnType === 'boolean') this.filterOnType = s.filterOnType;
		if (typeof s.open === 'boolean') this.open = s.open;
	}

	/** Starts following the active editor (once, from the workbench). */
	install(): () => void {
		if (this.#installed) return () => {};
		this.#installed = true;
		const stop = $effect.root(() => {
			$effect(() => {
				const snapshot: Saved = { sortBy: this.sortBy, followCursor: this.followCursor, filterOnType: this.filterOnType, open: this.open };
				try {
					localStorage.setItem(STATE_KEY, JSON.stringify(snapshot));
				} catch {
					/* storage unavailable: the defaults come back next time */
				}
			});
			$effect(() => {
				const rel = editors.active;
				this.#watch(rel);
			});
		});
		return () => {
			stop();
			this.#watched?.dispose();
			this.#watched = null;
			this.#installed = false;
		};
	}

	/** The symbols of an open file, in LSP shapes (the server's, else Monaco's). */
	symbolsOf(rel: string | null): (DocumentSymbol | SymbolInformation)[] {
		if (!rel) return [];
		const fromServer = lsp.symbols.get(rel);
		return fromServer?.length ? fromServer : (this.#fallback.get(rel) ?? fromServer ?? []);
	}

	#watch(rel: string | null, attempt = 0) {
		if (this.#watched?.rel === rel) return;
		this.#watched?.dispose();
		this.#watched = null;
		const model = rel ? editors.textModel(rel) : null;
		// The editor creates the model just after the tab becomes active.
		if (rel && !model && attempt < 10) setTimeout(() => editors.active === rel && !this.#watched && this.#watch(rel, attempt + 1), 200);
		if (!rel || !model) return;
		const changed = model.onDidChangeContent(() => this.#schedule(rel, model));
		this.#watched = {
			rel,
			dispose: () => {
				changed.dispose();
				clearTimeout(this.#timer);
				this.#fallback.delete(rel);
			}
		};
		this.#schedule(rel, model, 0);
	}

	#schedule(rel: string, model: Monaco.editor.ITextModel, delay = FALLBACK_DELAY_MS) {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(async () => {
			if (model.isDisposed() || lsp.symbols.get(rel)?.length) return;
			const { monacoDocumentSymbols } = await import('#lib/editor/symbolProviders.ts');
			const version = model.getVersionId();
			const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as unknown as Monaco.CancellationToken;
			const list = await monacoDocumentSymbols(model, token).catch(() => []);
			if (!model.isDisposed() && model.getVersionId() === version && this.#watched?.rel === rel) this.#fallback.set(rel, fromMonacoSymbols(list));
		}, delay);
	}

	// --- Expansion -------------------------------------------------------------------------------

	isExpanded(rel: string, id: string, expandByDefault: boolean): boolean {
		return expandByDefault !== (this.#toggled.get(rel)?.has(id) ?? false);
	}

	toggle(rel: string, id: string) {
		const set = new Set(this.#toggled.get(rel) ?? []);
		if (!set.delete(id)) set.add(id);
		this.#toggled.set(rel, set);
	}

	setExpanded(rel: string, ids: string[], expanded: boolean, expandByDefault: boolean) {
		const set = new Set(this.#toggled.get(rel) ?? []);
		for (const id of ids) {
			// Toggled means "not the default".
			if (expanded === expandByDefault) set.delete(id);
			else set.add(id);
		}
		this.#toggled.set(rel, set);
	}
}

export const outline = new Outline();
