// Merge conflicts in the editor (VS Code's extensions/merge-conflict): the `<<<<<<<` / `|||||||` /
// `=======` / `>>>>>>>` blocks of an open file are colored (`merge-conflict.decorators.enabled`),
// get "Accept Current Change | Accept Incoming Change | Accept Both Changes | Compare Changes"
// CodeLenses (`merge-conflict.codeLens.enabled`), and the merge-conflict.* commands with VS
// Code's ids resolve them; `merge-conflict.autoNavigateNextConflict.enabled` moves on to the next.

import type * as Monaco from 'monaco-editor';
import { t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { scm } from '#lib/workbench/scm.svelte.ts';
import { conflictCompareKey, mergeKey } from '#lib/workbench/scm.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { conflictAt, hasConflictMarkers, parseConflicts, resolutionText, stepConflict, type Conflict, type Resolution } from './conflicts';
import { splitLines } from './lineDiff';
import { activeView, isRepoFile, viewsOf, type ScmView } from './scmViews.svelte';

const ACCEPT = 'kingu.mergeConflict.accept';
const COMPARE = 'kingu.mergeConflict.compare';

/** The file path behind a code editor model (`file:///<rel>`), when it is a workspace file. */
const pathOf = (model: Monaco.editor.ITextModel) => {
	if (model.uri.scheme !== 'file') return null;
	const rel = decodeURIComponent(model.uri.path).replace(/^\//, '');
	return isRepoFile(rel) ? rel : null;
};

/** Replaces conflict `c` of `model` by its resolution (one undoable edit). */
function applyResolution(model: Monaco.editor.ITextModel, ed: Monaco.editor.ICodeEditor | null, c: Conflict, kind: Resolution) {
	const lines = splitLines(model.getValue());
	let start = 0;
	for (let i = 0; i < c.start - 1; i++) start += lines[i].length;
	let end = start;
	for (let i = c.start - 1; i < c.end; i++) end += lines[i].length;
	const s = model.getPositionAt(start);
	const e = model.getPositionAt(end);
	const edit = { range: { startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: e.lineNumber, endColumn: e.column }, text: resolutionText(lines, c, kind), forceMoveMarkers: true };
	if (ed) {
		ed.pushUndoStop();
		ed.executeEdits(`merge-conflict.accept.${kind}`, [edit]);
		ed.pushUndoStop();
	} else model.pushEditOperations([], [edit], () => null);
}

function editorFor(model: Monaco.editor.ITextModel): ScmView | undefined {
	const path = pathOf(model);
	return path ? (viewsOf(path).find((v) => v.ed.getModel() === model) ?? undefined) : undefined;
}

/** Accept a resolution of conflict `index` (the CodeLens and the commands), then maybe the next one. */
function accept(model: Monaco.editor.ITextModel, index: number, kind: Resolution) {
	const c = parseConflicts(model.getValue())[index];
	if (!c) return;
	const view = editorFor(model);
	applyResolution(model, view?.ed ?? null, c, kind);
	if (view && settings.get<boolean>('merge-conflict.autoNavigateNextConflict.enabled')) navigate(view, 1, c.start - 1);
}

function acceptAll(view: ScmView, kind: Resolution) {
	const model = view.ed.getModel();
	if (!model) return;
	const conflicts = parseConflicts(model.getValue());
	if (!conflicts.length) return status.flash(t('scmEditor.conflicts.none'));
	const lines = splitLines(model.getValue());
	const edits = conflicts.map((c) => {
		let start = 0;
		for (let i = 0; i < c.start - 1; i++) start += lines[i].length;
		let end = start;
		for (let i = c.start - 1; i < c.end; i++) end += lines[i].length;
		const s = model.getPositionAt(start);
		const e = model.getPositionAt(end);
		return { range: { startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: e.lineNumber, endColumn: e.column }, text: resolutionText(lines, c, kind), forceMoveMarkers: true };
	});
	view.ed.pushUndoStop();
	view.ed.executeEdits(`merge-conflict.accept.all-${kind}`, edits);
	view.ed.pushUndoStop();
}

function navigate(view: ScmView, dir: 1 | -1, from?: number) {
	const model = view.ed.getModel();
	if (!model) return;
	const conflicts = parseConflicts(model.getValue());
	const i = stepConflict(conflicts, from ?? view.ed.getPosition()?.lineNumber ?? 1, dir);
	if (i < 0) return status.flash(t('scmEditor.conflicts.none'));
	const line = conflicts[i].start;
	view.ed.setPosition({ lineNumber: line, column: 1 });
	view.ed.revealLineInCenter(line);
	view.ed.focus();
}

/** The conflict at the cursor of the active editor. */
function atCursor(): { view: ScmView; model: Monaco.editor.ITextModel; index: number } | null {
	const view = activeView();
	const model = view?.ed.getModel();
	if (!view || !model) return null;
	const index = conflictAt(parseConflicts(model.getValue()), view.ed.getPosition()?.lineNumber ?? 0);
	if (index < 0) {
		status.flash(t('scmEditor.conflicts.notInConflict'));
		return null;
	}
	return { view, model, index };
}

/** merge-conflict.compare: opens the file's current ↔ incoming sides (`merge-conflict.diffViewPosition`). */
export function compareConflicts(path: string) {
	const position = settings.get<string>('merge-conflict.diffViewPosition');
	if (position === 'Beside' || position === 'Below') void commands.run(position === 'Beside' ? 'workbench.action.splitEditorRight' : 'workbench.action.splitEditorDown');
	editors.open(conflictCompareKey(path), { preview: false });
}

export type ConflictsHandle = { render(): void; dispose(): void };

/** Colors the conflict blocks of the file `view` shows (VS Code's merge.* colors). */
export function attachConflicts(view: ScmView): ConflictsHandle {
	const { ed, monaco } = view;
	const { OverviewRulerLane } = monaco.editor;
	const decorations = ed.createDecorationsCollection();
	let timer: ReturnType<typeof setTimeout> | undefined;

	function draw() {
		const model = ed.getModel();
		const text = model?.getValue() ?? '';
		if (!model || !isRepoFile(view.path()) || !settings.get<boolean>('merge-conflict.decorators.enabled') || !hasConflictMarkers(text)) return decorations.clear();
		const items: Monaco.editor.IModelDeltaDecoration[] = [];
		const whole = (from: number, to: number, className: string, ruler?: string) => {
			if (from > to) return;
			items.push({
				range: new monaco.Range(from, 1, to, 1),
				options: { isWholeLine: true, className, overviewRuler: ruler ? { color: ruler, position: OverviewRulerLane.Full } : undefined }
			});
		};
		const label = (line: number, text: string) =>
			items.push({
				range: new monaco.Range(line, model.getLineMaxColumn(line), line, model.getLineMaxColumn(line)),
				options: { after: { content: ` ${text}`, inlineClassName: 'kg-mc-label' } }
			});
		for (const c of parseConflicts(text)) {
			whole(c.current.header, c.current.header, 'kg-mc-current-header');
			whole(c.current.from, c.current.to, 'kg-mc-current', 'rgba(64, 200, 174, 0.5)');
			label(c.current.header, t('scmEditor.conflicts.currentLabel'));
			for (const a of c.commonAncestors) {
				whole(a.header, a.header, 'kg-mc-base-header');
				whole(a.from, a.to, 'kg-mc-base');
			}
			whole(c.splitter, c.splitter, 'kg-mc-splitter');
			whole(c.incoming.from, c.incoming.to, 'kg-mc-incoming', 'rgba(64, 166, 255, 0.5)');
			whole(c.incoming.header, c.incoming.header, 'kg-mc-incoming-header');
			label(c.incoming.header, t('scmEditor.conflicts.incomingLabel'));
		}
		decorations.set(items);
	}

	const subs = [
		ed.onDidChangeModelContent(() => {
			clearTimeout(timer);
			timer = setTimeout(draw, 100);
		}),
		ed.onDidChangeModel(draw)
	];

	return {
		render() {
			void settings.get('merge-conflict.decorators.enabled');
			void view.path();
			draw();
		},
		dispose() {
			clearTimeout(timer);
			subs.forEach((s) => s.dispose());
			decorations.clear();
		}
	};
}

let installed: Monaco.IDisposable[] | null = null;
let lensChanged: Monaco.Emitter<Monaco.languages.CodeLensProvider> | null = null;

/** The CodeLens provider and its Monaco commands, once per window. */
export function installConflictLenses(monaco: typeof Monaco) {
	if (installed) return;
	lensChanged = new monaco.Emitter<Monaco.languages.CodeLensProvider>();
	const provider: Monaco.languages.CodeLensProvider = {
		onDidChange: lensChanged.event,
		provideCodeLenses(model) {
			const path = pathOf(model);
			const text = model.getValue();
			if (!path || !settings.get<boolean>('merge-conflict.codeLens.enabled') || !hasConflictMarkers(text)) return { lenses: [], dispose() {} };
			const lenses = parseConflicts(text).flatMap((c, i) => {
				const range = new monaco.Range(c.start, 1, c.start, 1);
				const lens = (title: string, id: string, args: unknown[]) => ({ range, command: { id, title, arguments: args } });
				return [
					lens(t('scmEditor.conflicts.acceptCurrent'), ACCEPT, [model.uri.toString(), i, 'current']),
					lens(t('scmEditor.conflicts.acceptIncoming'), ACCEPT, [model.uri.toString(), i, 'incoming']),
					lens(t('scmEditor.conflicts.acceptBoth'), ACCEPT, [model.uri.toString(), i, 'both']),
					lens(t('scmEditor.conflicts.compare'), COMPARE, [path])
				];
			});
			return { lenses, dispose() {} };
		}
	};
	installed = [
		monaco.languages.registerCodeLensProvider('*', provider),
		monaco.editor.registerCommand(ACCEPT, (_a, uri: string, index: number, kind: Resolution) => {
			const model = monaco.editor.getModel(monaco.Uri.parse(uri));
			if (model) accept(model, index, kind);
		}),
		monaco.editor.registerCommand(COMPARE, (_a, path: string) => compareConflicts(path))
	];
}

/** CodeLenses follow `merge-conflict.codeLens.enabled` and the UI language. */
export function refreshConflictLenses() {
	lensChanged?.fire(undefined as unknown as Monaco.languages.CodeLensProvider);
}

export function installConflictCommands(): () => void {
	const view = () => activeView();
	const hasConflicts = () => {
		const model = view()?.ed.getModel();
		return !!model && hasConflictMarkers(model.getValue());
	};
	const acceptAt = (kind: Resolution) => () => {
		const at = atCursor();
		if (at) accept(at.model, at.index, kind);
	};
	const conflicted = () => {
		const p = editors.active;
		return !!p && !!scm.repo?.entries.some((e) => e.path === p && e.conflict);
	};
	const list = [
		{ id: 'merge-conflict.accept.current', title: 'Merge Conflict: Accept Current', run: acceptAt('current') },
		{ id: 'merge-conflict.accept.incoming', title: 'Merge Conflict: Accept Incoming', run: acceptAt('incoming') },
		{ id: 'merge-conflict.accept.both', title: 'Merge Conflict: Accept Both', run: acceptAt('both') },
		{ id: 'merge-conflict.accept.all-current', title: 'Merge Conflict: Accept All Current', run: () => view() && acceptAll(view()!, 'current') },
		{ id: 'merge-conflict.accept.all-incoming', title: 'Merge Conflict: Accept All Incoming', run: () => view() && acceptAll(view()!, 'incoming') },
		{ id: 'merge-conflict.accept.all-both', title: 'Merge Conflict: Accept All Both', run: () => view() && acceptAll(view()!, 'both') },
		{ id: 'merge-conflict.next', title: 'Merge Conflict: Next Conflict', run: () => view() && navigate(view()!, 1) },
		{ id: 'merge-conflict.previous', title: 'Merge Conflict: Previous Conflict', run: () => view() && navigate(view()!, -1) },
		{
			id: 'merge-conflict.compare',
			title: 'Merge Conflict: Compare Current Conflict',
			run: () => {
				const at = atCursor();
				const p = at?.view.path();
				if (p) compareConflicts(p);
			}
		}
	].map((c) => commands.register({ ...c, when: hasConflicts }));
	list.push(
		commands.register({
			id: 'git.openMergeEditor',
			title: 'Git: Resolve in Merge Editor',
			when: conflicted,
			run: () => {
				const p = editors.active;
				if (p) editors.open(mergeKey(p), { preview: false });
			}
		})
	);
	return () => list.forEach((u) => u());
}
