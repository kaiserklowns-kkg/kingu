// Notebook editors (VS Code's NotebookEditor + the ipynb serializer + the Jupyter kernel picker):
// one state per open `.ipynb` tab, with its document, cell selection and edit mode, undo, dirty
// state, saving, and its kernel. The document model and its edits are notebook.ts; running cells
// is notebookKernel.ts; the UI is NotebookEditor.svelte.

import { Channel, invoke } from '@tauri-apps/api/core';
import { SvelteMap } from 'svelte/reactivity';
import { clientLog } from '#lib/client-log.ts';
import { t } from '#lib/i18n/index.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { editors } from './editors.svelte';
import { registerSaver } from './editorModels';
import {
	changeKindOps,
	clearOutputsOps,
	deleteCellOps,
	emptyNotebook,
	insertCellOps,
	isNotebookPath,
	joinCellOps,
	moveCellOps,
	newCell,
	NotebookHistory,
	notebookHeadings,
	parseNotebookDocument,
	serializeNotebook,
	splitCellOps,
	type CellKind,
	type NbDocument,
	type NotebookHeading,
	type NotebookOp
} from './notebook';
import { NotebookExecution, type CellRunState, type KernelDiscovery, type KernelEvent, type KernelSpec, type KernelStatus, type KernelTransport } from './notebookKernel';
import { quick } from './quick.svelte';

/** What a cell's editor exposes (Split Cell needs its cursors). */
export type CellEditorHandle = { focus: () => void; cursorOffsets: () => number[] };

let discovery: Promise<KernelDiscovery> | null = null;
/** The kernelspecs, asked once per window (Select Kernel asks again). */
export function discoverKernels(fresh = false): Promise<KernelDiscovery> {
	if (fresh || !discovery) {
		discovery = invoke<KernelDiscovery>('notebook_kernels');
		discovery.catch(() => (discovery = null));
	}
	return discovery;
}

function tauriTransport(rel: string, python: string, kernel: string): KernelTransport {
	let id: number | null = null;
	return {
		async start(onEvent) {
			const channel = new Channel<KernelEvent>();
			channel.onmessage = onEvent;
			id = await invoke<number>('notebook_kernel_start', { rel, python, kernel, onEvent: channel });
		},
		async send(request) {
			if (id !== null) await invoke('notebook_kernel_send', { id, request });
		},
		async stop() {
			if (id !== null) await invoke('notebook_kernel_stop', { id });
			id = null;
		}
	};
}

export class NotebookState {
	path = $state('');
	doc = $state<NbDocument>(emptyNotebook());
	loaded = $state(false);
	error = $state('');
	/** The selected cell (VS Code's focused cell). */
	selected = $state(0);
	/** The cell in edit mode (its editor has focus), else command mode. */
	editing = $state<string | null>(null);
	version = $state(0);
	savedVersion = $state(0);
	dirty = $derived(this.version !== this.savedVersion);
	canUndo = $state(false);
	canRedo = $state(false);
	kernel = $state<{ python: string; spec: KernelSpec } | null>(null);
	status = $state<KernelStatus>('off');
	kernelError = $state('');
	runs = $state<Record<string, CellRunState>>({});
	/** Line numbers in cell editors (VS Code's L / ⇧L in command mode). */
	lineNumbers = $state(false);
	/** Bumped to ask the list to take focus (command mode) after an edit. */
	focusList = $state(0);
	/** Bumped to scroll the selected cell into view (the Outline picked it). */
	reveal = $state(0);
	headings = $derived<NotebookHeading[]>(notebookHeadings(this.doc.cells));
	history = new NotebookHistory();
	cellEditors = new Map<string, CellEditorHandle>();
	exec: NotebookExecution;

	constructor(path: string) {
		this.path = path;
		this.exec = new NotebookExecution(
			() => this.doc,
			(docChanged) => this.#fromExecution(docChanged),
			() => tauriTransport(this.path, this.kernel!.python, this.kernel!.spec.name)
		);
	}

	#sync() {
		this.version = this.history.version;
		this.canUndo = this.history.canUndo;
		this.canRedo = this.history.canRedo;
	}

	#fromExecution(docChanged: boolean) {
		if (docChanged) {
			this.history.touch();
			this.#sync();
		}
		this.status = this.exec.status;
		this.kernelError = this.exec.error;
		const runs: Record<string, CellRunState> = {};
		for (const c of this.doc.cells) {
			const s = this.exec.stateOf(c.key);
			if (s) runs[c.key] = s;
		}
		this.runs = runs;
	}

	async load() {
		this.loaded = false;
		this.error = '';
		try {
			const text = await invoke<string>('read_workspace_file', { rel: this.path });
			this.doc = parseNotebookDocument(text);
			this.history = new NotebookHistory();
			this.#sync();
			this.savedVersion = this.version;
			this.selected = 0;
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
		} finally {
			this.loaded = true;
		}
	}

	async save(): Promise<boolean> {
		try {
			await invoke('fs_write_file', { rel: this.path, content: serializeNotebook($state.snapshot(this.doc) as NbDocument) });
			this.savedVersion = this.version;
			return true;
		} catch (e) {
			notifications.error(t('notebook.saveFailed', { error: String(e) }));
			return false;
		}
	}

	// --- Edits -----------------------------------------------------------------------------------

	apply(ops: NotebookOp[] | null) {
		if (!ops?.length) return false;
		this.history.apply(this.doc, ops);
		this.#sync();
		this.selected = Math.min(this.selected, this.doc.cells.length - 1);
		return true;
	}

	/** Typing in a cell (the cell editor's own undo has it). */
	setSource(key: string, source: string) {
		const cell = this.doc.cells.find((c) => c.key === key);
		if (!cell || cell.source === source) return;
		cell.source = source;
		this.history.touch();
		this.#sync();
	}

	undo() {
		if (this.history.undo(this.doc)) this.#sync();
		this.selected = Math.max(0, Math.min(this.selected, this.doc.cells.length - 1));
	}

	redo() {
		if (this.history.redo(this.doc)) this.#sync();
		this.selected = Math.max(0, Math.min(this.selected, this.doc.cells.length - 1));
	}

	get cell() {
		return this.doc.cells[this.selected];
	}

	select(index: number) {
		this.selected = Math.max(0, Math.min(index, this.doc.cells.length - 1));
	}

	/** Inserts a cell above or below the selected one and edits it (VS Code's A / B and the + buttons). */
	insert(kind: CellKind, where: 'above' | 'below', at = this.selected) {
		const index = this.doc.cells.length === 0 ? 0 : where === 'above' ? at : at + 1;
		const cell = newCell(kind);
		this.apply(insertCellOps(index, cell));
		this.selected = index;
		this.edit(cell.key);
	}

	delete(index = this.selected) {
		if (!this.apply(deleteCellOps(this.doc, index))) return;
		// A notebook keeps one cell to type into.
		if (this.doc.cells.length === 0) this.apply(insertCellOps(0, newCell('code')));
		this.selected = Math.min(index, this.doc.cells.length - 1);
		this.focusList++;
	}

	move(delta: -1 | 1, index = this.selected) {
		if (this.apply(moveCellOps(this.doc, index, delta))) this.selected = index + delta;
	}

	changeKind(kind: CellKind, index = this.selected) {
		this.apply(changeKindOps(this.doc, index, kind));
	}

	split(index = this.selected) {
		const cell = this.doc.cells[index];
		const offsets = cell ? (this.cellEditors.get(cell.key)?.cursorOffsets() ?? []) : [];
		this.apply(splitCellOps(this.doc, index, offsets));
	}

	join(direction: 'above' | 'below', index = this.selected) {
		const upper = direction === 'above' ? index - 1 : index;
		if (upper >= 0 && this.apply(joinCellOps(this.doc, upper))) this.selected = upper;
	}

	clearOutputs(keys?: string[]) {
		this.apply(clearOutputsOps(this.doc, keys));
	}

	/** Edit mode on `key` (its editor takes focus once mounted). */
	edit(key: string) {
		const index = this.doc.cells.findIndex((c) => c.key === key);
		if (index >= 0) this.selected = index;
		this.editing = key;
		queueMicrotask(() => this.cellEditors.get(key)?.focus());
	}

	/** Back to command mode (Escape). */
	stopEditing() {
		this.editing = null;
		this.focusList++;
	}

	// --- Running ---------------------------------------------------------------------------------

	/** The kernel to run with: the one picked, else the notebook's kernelspec or `python3`, else the first. */
	async #ensureKernel(): Promise<boolean> {
		if (this.kernel) return true;
		try {
			const found = await discoverKernels();
			const wanted = (this.doc.metadata.kernelspec as { name?: string } | undefined)?.name;
			const spec = found.specs.find((s) => s.name === wanted) ?? found.specs.find((s) => s.name === 'python3') ?? found.specs[0];
			if (!spec) throw new Error(t('notebook.noKernels'));
			this.kernel = { python: found.python, spec };
			return true;
		} catch (e) {
			notifications.error(String(e), { actions: [{ label: t('notebook.selectKernel'), run: () => void this.pickKernel() }] });
			return false;
		}
	}

	async run(keys: string[]) {
		// Markdown cells "run" by rendering (VS Code's ⌃↵ on a Markdown cell).
		if (this.editing && keys.includes(this.editing) && this.doc.cells.find((c) => c.key === this.editing)?.kind !== 'code') this.stopEditing();
		const code = keys.filter((k) => this.doc.cells.find((c) => c.key === k)?.kind === 'code');
		if (!code.length || !(await this.#ensureKernel())) return;
		try {
			await this.exec.execute(code);
		} catch (e) {
			notifications.error(t('notebook.runFailed', { error: String(e) }));
		}
	}

	runCell(index = this.selected) {
		const cell = this.doc.cells[index];
		if (cell) return this.run([cell.key]);
	}

	runAll() {
		return this.run(this.doc.cells.map((c) => c.key));
	}

	/** Run All Above / Below the selected cell (VS Code's executeCellsAbove / executeCellAndBelow). */
	runRange(which: 'above' | 'below') {
		const cells = which === 'above' ? this.doc.cells.slice(0, this.selected) : this.doc.cells.slice(this.selected);
		return this.run(cells.map((c) => c.key));
	}

	/** ⇧↵: run, then select the next cell (a new one at the end). ⌥↵: run, then insert below. */
	async runAndAdvance(insert: boolean) {
		const index = this.selected;
		void this.runCell(index);
		if (insert || index === this.doc.cells.length - 1) this.insert(this.doc.cells[index]?.kind === 'markdown' ? 'markdown' : 'code', 'below', index);
		else {
			this.selected = index + 1;
			const next = this.doc.cells[index + 1];
			if (this.editing && next) this.edit(next.key);
			else this.stopEditing();
		}
	}

	interrupt() {
		return this.exec.interrupt().catch((e) => notifications.error(String(e)));
	}

	restart() {
		return this.exec.restart().catch((e) => notifications.error(String(e)));
	}

	/** Select Kernel: the kernelspecs of the found Python (VS Code's kernel picker). */
	async pickKernel() {
		let found: KernelDiscovery;
		try {
			found = await discoverKernels(true);
		} catch (e) {
			notifications.error(String(e));
			return;
		}
		const item = await quick.choose({
			placeholder: t('notebook.pickKernel'),
			items: found.specs.map((s) => ({ id: s.name, label: s.displayName, description: `${s.name} · ${found.python}` })),
			activeId: this.kernel?.spec.name
		});
		const spec = item && found.specs.find((s) => s.name === item.id);
		if (!spec) return;
		if (this.kernel?.spec.name === spec.name && this.kernel.python === found.python) return;
		await this.exec.shutdown();
		this.kernel = { python: found.python, spec };
		// The notebook remembers its kernel (VS Code writes the kernelspec metadata).
		this.doc.metadata.kernelspec = { name: spec.name, display_name: spec.displayName, language: spec.language };
		this.history.touch();
		this.#sync();
	}

	dispose() {
		void this.exec.shutdown().catch(() => {});
	}
}

class NotebookEditors {
	#states = new SvelteMap<string, NotebookState>();
	#watchers = new Map<string, () => void>();

	/** The state of `path`, loaded the first time it is shown. */
	get(path: string): NotebookState {
		let s = this.#states.get(path);
		if (s) return s;
		s = new NotebookState(path);
		this.#states.set(path, s);
		void s.load();
		const state = s;
		this.#watchers.set(
			path,
			$effect.root(() => {
				$effect(() => editors.setDirty(path, state.dirty));
			})
		);
		return s;
	}

	peek(path: string): NotebookState | undefined {
		return this.#states.get(path);
	}

	/** The notebook of the active editor in the IDE, if it is one. */
	active(): NotebookState | undefined {
		const path = editors.active;
		return path && isNotebookPath(path) ? this.#states.get(path) : undefined;
	}

	/** Closed notebooks shut their kernel down and forget their state. */
	prune(open: ReadonlySet<string>) {
		for (const [path, s] of [...this.#states]) {
			if (open.has(path)) continue;
			this.#states.delete(path);
			this.#watchers.get(path)?.();
			this.#watchers.delete(path);
			editors.setDirty(path, false);
			s.dispose();
			clientLog('info', `notebook closed: ${path}`);
		}
	}
}

export const notebooks = new NotebookEditors();

// Save, Save All, save on close and shutdown go through saveFile; auto save writes notebooks too.
registerSaver(isNotebookPath, (path) => notebooks.peek(path)?.save() ?? Promise.resolve(false));
