// Document symbols of the open files for the Outline view and the breadcrumbs (VS Code:
// IOutlineService / DocumentSymbolsOutline): the language server's when it has answered, else
// Monaco's own providers (its TypeScript/JSON/CSS/HTML workers). Also the Outline view's state:
// sort order, Follow Cursor, Filter on Type (VS Code's OutlineViewState, kept per workspace) and
// which elements are toggled per file.

import { SvelteMap } from 'svelte/reactivity';
import type * as Monaco from 'monaco-editor';
import { lsp } from '#lib/lsp/lsp.svelte.ts';
import type { DocumentSymbol, SymbolInformation } from '#lib/lsp/protocol.ts';
import { editors } from './editors.svelte';
import { fromMonacoSymbols, type OutlineSortOrder } from './outlineModel';
import { workspaceStorage } from './workspaceStorage.svelte';
import { withSaved } from './workspaceState';

const STATE_KEY = 'kingu.outline.state';
const FALLBACK_DELAY_MS = 400;

/** The outline of an editor without a text model (a notebook's Markdown headers): its symbols, and
 * how to show one (`line` is the symbol's start line in the provider's own terms). */
export type OutlineProvider = {
	owns: (rel: string) => boolean;
	symbols: (rel: string) => DocumentSymbol[];
	reveal: (rel: string, line: number, focus: boolean) => void;
};

/** What a workspace opened for the first time shows (VS Code: sorted by position, the section collapsed). */
const DEFAULTS = { sortBy: 'position' as OutlineSortOrder, followCursor: true, filterOnType: true, open: false };

/** What an older build kept for every window (it goes to the first workspace opened). */
function readLegacy(): unknown {
	try {
		return JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null');
	} catch {
		return null;
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
	#providers: OutlineProvider[] = [];

	registerProvider(p: OutlineProvider): () => void {
		this.#providers.push(p);
		return () => (this.#providers = this.#providers.filter((x) => x !== p));
	}

	/** Shows a symbol of a provider's editor; false when `rel` is a text editor (the caller goes to the line). */
	reveal(rel: string, line: number, focus: boolean): boolean {
		const p = this.#providers.find((x) => x.owns(rel));
		p?.reveal(rel, line, focus);
		return !!p;
	}

	constructor() {
		workspaceStorage.register(STATE_KEY, Object.keys(DEFAULTS), (saved) => {
			const s = withSaved(DEFAULTS, saved);
			this.sortBy = s.sortBy === 'name' || s.sortBy === 'kind' ? s.sortBy : 'position';
			this.followCursor = s.followCursor;
			this.filterOnType = s.filterOnType;
			this.open = s.open;
			this.#toggled.clear();
		}, readLegacy());
	}

	/** Starts following the active editor (once, from the workbench). */
	install(): () => void {
		if (this.#installed) return () => {};
		this.#installed = true;
		const stop = $effect.root(() => {
			$effect(() => {
				workspaceStorage.save(STATE_KEY, { sortBy: this.sortBy, followCursor: this.followCursor, filterOnType: this.filterOnType, open: this.open });
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
		const provider = this.#providers.find((p) => p.owns(rel));
		if (provider) return provider.symbols(rel);
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
