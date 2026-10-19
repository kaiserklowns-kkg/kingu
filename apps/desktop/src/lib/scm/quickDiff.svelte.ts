// Quick diff (VS Code's quickDiffDecorator.ts and quickDiffWidget.ts): added, modified and deleted
// bars in the gutter (and the overview ruler and minimap, `scm.diffDecorations`) for the lines of
// an editor that differ from the file's index version, live as you type. A click on a bar
// (`scm.diffDecorationsGutterAction: diff`) or ⌥F5 opens the peek: the change's old and new
// lines with Stage, Revert, previous / next and close. The git extension's range commands
// (git.stageSelectedRanges, git.unstageSelectedRanges, git.revertSelectedRanges) work on the
// editor's selections; staging writes the index through `git apply --cached`.

import { invoke } from '@tauri-apps/api/core';
import type * as Monaco from 'monaco-editor';
import { t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands, keyOf } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { saveFile } from '#lib/workbench/editorModels.ts';
import { keyLabel } from '#lib/workbench/keys.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { scm } from '#lib/workbench/scm.svelte.ts';
import { diffKey, indexDiffKey, parseIndexDiffKey } from '#lib/workbench/scm.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { changeAt, changeType, diffLines, splitLines, stepChange, type LineChange, type LineRange } from './lineDiff';
import { indexPatch, revertChange, revertRanges, stageChange, stageRanges, unstageRanges, unstageRangesOfIndex } from './staging';
import { activeView, isRepoFile, versions, type ScmView } from './scmViews.svelte';

export const QUICK_DIFF_KEYS = {
	next: { id: 'editor.action.dirtydiff.next', title: 'Show Next Change', key: 'alt+f5' },
	previous: { id: 'editor.action.dirtydiff.previous', title: 'Show Previous Change', key: 'shift+alt+f5' },
	nextChange: { id: 'workbench.action.editor.nextChange', title: 'Go to Next Change', key: 'alt+f3' },
	previousChange: { id: 'workbench.action.editor.previousChange', title: 'Go to Previous Change', key: 'shift+alt+f3' },
	stageSelected: { id: 'git.stageSelectedRanges', title: 'Git: Stage Selected Ranges', key: 'cmd+k cmd+alt+s' },
	unstageSelected: { id: 'git.unstageSelectedRanges', title: 'Git: Unstage Selected Ranges', key: 'cmd+k cmd+n' },
	revertSelected: { id: 'git.revertSelectedRanges', title: 'Git: Revert Selected Ranges', key: 'cmd+k cmd+r' }
} as const;

type DiffMode = 'all' | 'gutter' | 'overview' | 'minimap' | 'none';

/** `scm.diffDecorationsIgnoreTrimWhitespace` (`inherit`: `diffEditor.ignoreTrimWhitespace`). */
function ignoreTrim(): boolean {
	const v = settings.get<string>('scm.diffDecorationsIgnoreTrimWhitespace');
	return v === 'inherit' ? settings.get<boolean>('diffEditor.ignoreTrimWhitespace') : v === 'true';
}

/** VS Code's `scm.diffDecorationsGutterPattern`: which kinds draw as a pattern instead of a solid bar. */
function pattern(): { added: boolean; modified: boolean } {
	const p = settings.get<{ added?: boolean; modified?: boolean } | null>('scm.diffDecorationsGutterPattern') ?? {};
	return { added: p.added === true, modified: p.modified !== false };
}

/** A diff selection source: the Staged Changes diff tab (HEAD ↔ index) registers itself here. */
type IndexDiffView = { key(): string | null; selections(): LineRange[] };
const indexDiffViews = new Set<IndexDiffView>();
export function addIndexDiffView(v: IndexDiffView): () => void {
	indexDiffViews.add(v);
	return () => indexDiffViews.delete(v);
}

type State = {
	changes: LineChange[];
	/** The texts the changes were computed from. */
	original: string;
	modified: string;
	peek: Peek | null;
	openPeek(i: number): void;
	recompute(): void;
};
const states = new WeakMap<ScmView, State>();

/** Replaces the model's text by `next` with one edit per changed block (markers and breakpoints stay put). */
export function setTextMinimal(model: Monaco.editor.ITextModel, ed: Monaco.editor.ICodeEditor | null, next: string, source: string) {
	const cur = splitLines(model.getValue());
	const nl = splitLines(next);
	const starts: number[] = [0];
	for (const l of cur) starts.push(starts[starts.length - 1] + l.length);
	const edits = diffLines(cur, nl).map((c) => {
		const b0 = c.originalEndLineNumber === 0 ? c.originalStartLineNumber : c.originalStartLineNumber - 1;
		const b1 = c.originalEndLineNumber === 0 ? b0 : c.originalEndLineNumber;
		const n0 = c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber : c.modifiedStartLineNumber - 1;
		const n1 = c.modifiedEndLineNumber === 0 ? n0 : c.modifiedEndLineNumber;
		const s = model.getPositionAt(starts[b0]);
		const e = model.getPositionAt(starts[b1]);
		return { range: { startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: e.lineNumber, endColumn: e.column }, text: nl.slice(n0, n1).join(''), forceMoveMarkers: true };
	});
	if (!edits.length) return;
	if (ed) {
		const sels = ed.getSelections();
		ed.pushUndoStop();
		ed.executeEdits(source, edits, sels ?? undefined);
		ed.pushUndoStop();
	} else model.pushEditOperations([], edits, () => null);
}

/** Writes `next` as the index of `path` (whose index text is `index`) and re-reads status. */
async function writeIndex(path: string, index: string, next: string): Promise<boolean> {
	const hunks = indexPatch(index, next);
	if (!hunks) return true;
	try {
		await invoke('scm_stage_patch', { rel: path, hunks });
		return true;
	} catch (e) {
		notifications.error(e);
		return false;
	} finally {
		await scm.refresh();
	}
}

/** Sets the buffer to `next` (a revert) and saves it, like VS Code's _revertChanges. */
async function revertTo(view: ScmView, next: string) {
	const model = view.ed.getModel();
	const path = view.path();
	if (!model || !path) return;
	setTextMinimal(model, view.ed, next, 'git.revertChange');
	await saveFile(path);
}

const selectionsOf = (ed: Monaco.editor.ICodeEditor): LineRange[] => (ed.getSelections() ?? []).map((s) => ({ start: s.startLineNumber, end: s.endLineNumber }));

// --- The peek (quickDiffWidget): a zone under the change, an overlay widget drawn over it.

class Peek {
	readonly #view: ScmView;
	readonly #state: State;
	#zone: string | null = null;
	readonly #root = document.createElement('div');
	readonly #widget: Monaco.editor.IOverlayWidget;
	index: number;

	constructor(view: ScmView, state: State, index: number) {
		this.#view = view;
		this.#state = state;
		this.index = index;
		this.#root.className = 'kg-qd-peek';
		this.#root.setAttribute('role', 'dialog');
		for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel']) this.#root.addEventListener(type, (e) => e.stopPropagation());
		this.#root.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this.close();
				view.ed.focus();
			}
		});
		this.#widget = { getId: () => 'kingu.quickDiffPeek', getDomNode: () => this.#root, getPosition: () => null };
		view.ed.addOverlayWidget(this.#widget);
		this.show(index);
	}

	/** Draws change `index`; `reveal` scrolls to it and puts the cursor there (not while typing). */
	show(index: number, reveal = true) {
		const { ed, monaco } = this.#view;
		const c = this.#state.changes[index];
		if (!c) return this.close();
		this.index = index;
		const original = splitLines(this.#state.original);
		const modified = splitLines(this.#state.modified);
		const o0 = c.originalEndLineNumber === 0 ? c.originalStartLineNumber : c.originalStartLineNumber - 1;
		const o1 = c.originalEndLineNumber === 0 ? o0 : c.originalEndLineNumber;
		const m0 = c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber : c.modifiedStartLineNumber - 1;
		const m1 = c.modifiedEndLineNumber === 0 ? m0 : c.modifiedEndLineNumber;
		const removed = original.slice(o0, o1).map((l) => l.replace(/\r?\n$/, ''));
		const added = modified.slice(m0, m1).map((l) => l.replace(/\r?\n$/, ''));
		const lineHeight = ed.getOption(monaco.editor.EditorOption.lineHeight);
		const font = ed.getOption(monaco.editor.EditorOption.fontInfo);
		const shownLines = Math.min(removed.length + added.length, 14);
		const height = 26 + Math.max(shownLines, 1) * lineHeight + 8;
		const after = c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber : c.modifiedEndLineNumber;

		const path = this.#view.path() ?? '';
		const name = path.slice(path.lastIndexOf('/') + 1);
		const header = document.createElement('div');
		header.className = 'kg-qd-peek-head';
		const title = document.createElement('span');
		title.className = 'kg-qd-peek-title';
		title.textContent = name;
		const sub = document.createElement('span');
		sub.className = 'kg-qd-peek-sub';
		sub.textContent = t('scmEditor.peek.position', { index: index + 1, count: this.#state.changes.length });
		const spacer = document.createElement('span');
		spacer.style.flex = '1';
		const tip = (label: string, k?: { id: string; key?: string }) => {
			const key = k && keyOf(k);
			return key ? `${label} (${keyLabel(key)})` : label;
		};
		const button = (text: string, label: string, run: () => unknown) => {
			const b = document.createElement('button');
			b.type = 'button';
			b.textContent = text;
			b.title = label;
			b.setAttribute('aria-label', label);
			b.addEventListener('click', () => void run());
			return b;
		};
		header.append(
			title,
			sub,
			spacer,
			button(t('scmEditor.peek.stage'), t('scmEditor.peek.stageTitle'), () => stagePeek(this.#view)),
			button(t('scmEditor.peek.revert'), t('scmEditor.peek.revertTitle'), () => revertPeek(this.#view)),
			button('↑', tip(t('scmEditor.peek.previous'), QUICK_DIFF_KEYS.previous), () => this.step(-1)),
			button('↓', tip(t('scmEditor.peek.next'), QUICK_DIFF_KEYS.next), () => this.step(1)),
			button('×', tip(t('scmEditor.peek.close')), () => (this.close(), ed.focus()))
		);
		const body = document.createElement('div');
		body.className = 'kg-qd-peek-body';
		Object.assign(body.style, { fontFamily: font.fontFamily, fontSize: `${font.fontSize}px`, lineHeight: `${lineHeight}px`, maxHeight: `${14 * lineHeight}px` });
		const language = ed.getModel()?.getLanguageId() ?? 'plaintext';
		const tabSize = ed.getModel()?.getOptions().tabSize ?? 4;
		const block = (lines: string[], kind: 'removed' | 'added', first: number) => {
			if (!lines.length) return;
			const wrap = document.createElement('div');
			wrap.className = `kg-qd-peek-${kind}`;
			const rows = lines.map((text, i) => {
				const row = document.createElement('div');
				row.className = 'kg-qd-peek-row';
				const num = document.createElement('span');
				num.className = 'kg-qd-peek-num';
				num.textContent = `${kind === 'removed' ? '-' : '+'}${first + i}`;
				const code = document.createElement('span');
				code.className = 'kg-qd-peek-code';
				code.textContent = text || ' ';
				row.append(num, code);
				wrap.append(row);
				return code;
			});
			body.append(wrap);
			void monaco.editor.colorize(lines.join('\n'), language, { tabSize }).then(
				(html) => {
					const parts = html.split('<br/>');
					rows.forEach((code, i) => {
						if (parts[i] !== undefined && lines[i]) code.innerHTML = parts[i];
					});
				},
				() => {}
			);
		};
		block(removed, 'removed', o0 + 1);
		block(added, 'added', m0 + 1);
		if (!removed.length && !added.length) body.textContent = t('scmEditor.peek.empty');
		this.#root.replaceChildren(header, body);
		this.#root.style.height = `${height}px`;

		ed.changeViewZones((a) => {
			if (this.#zone) a.removeZone(this.#zone);
			const spacerNode = document.createElement('div');
			this.#zone = a.addZone({
				afterLineNumber: Math.max(0, after),
				heightInPx: height,
				domNode: spacerNode,
				suppressMouseDown: true,
				onDomNodeTop: (top) => {
					this.#root.style.top = `${top}px`;
				}
			});
		});
		this.#layout();
		if (!reveal) return;
		ed.revealLinesInCenterIfOutsideViewport(Math.max(1, c.modifiedStartLineNumber), Math.max(1, after) + Math.ceil(height / lineHeight));
		ed.setPosition({ lineNumber: Math.max(1, c.modifiedStartLineNumber), column: 1 });
	}

	#layout() {
		const info = this.#view.ed.getLayoutInfo();
		this.#root.style.width = `${Math.max(200, info.width - info.verticalScrollbarWidth - info.minimap.minimapWidth)}px`;
	}

	step(dir: 1 | -1) {
		const n = this.#state.changes.length;
		if (!n) return this.close();
		this.show((this.index + dir + n) % n);
	}

	close() {
		const { ed } = this.#view;
		ed.changeViewZones((a) => {
			if (this.#zone) a.removeZone(this.#zone);
		});
		this.#zone = null;
		ed.removeOverlayWidget(this.#widget);
		if (this.#state.peek === this) this.#state.peek = null;
	}
}

function stagePeek(view: ScmView) {
	const s = states.get(view);
	const path = view.path();
	if (!s?.peek || !path) return;
	const c = s.changes[s.peek.index];
	if (!c) return;
	const next = stageChange(s.original, s.modified, c);
	void writeIndex(path, s.original, next).then((ok) => ok && status.flash(t('scmEditor.staged')));
}

function revertPeek(view: ScmView) {
	const s = states.get(view);
	if (!s?.peek) return;
	const next = revertChange(s.original, s.modified, s.changes, s.peek.index);
	s.peek.close();
	void revertTo(view, next);
}

// --- Decorations.

export type QuickDiffHandle = { render(): void; dispose(): void };

export function attachQuickDiff(view: ScmView): QuickDiffHandle {
	const { ed, monaco } = view;
	const { OverviewRulerLane, MinimapPosition, MouseTargetType } = monaco.editor;
	const decorations = ed.createDecorationsCollection();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastPath: string | null = null;

	const state: State = {
		changes: [],
		original: '',
		modified: '',
		peek: null,
		openPeek(i) {
			if (this.peek) this.peek.show(i);
			else this.peek = new Peek(view, this, i);
		},
		recompute: () => compute()
	};
	states.set(view, state);

	function clear() {
		state.changes = [];
		decorations.clear();
		state.peek?.close();
	}

	function compute() {
		const path = view.path();
		const model = ed.getModel();
		const mode = settings.get<DiffMode>('scm.diffDecorations');
		if (path !== lastPath) {
			state.peek?.close();
			lastPath = path;
		}
		if (!model || !isRepoFile(path) || mode === 'none' || !scm.repo) return clear();
		const original = versions.index(path);
		if (original === undefined) return;
		if (original === null) return clear();
		const modified = model.getValue();
		state.original = original;
		state.modified = modified;
		state.changes = diffLines(splitLines(original), splitLines(modified), { ignoreTrimWhitespace: ignoreTrim() });
		const gutter = mode === 'all' || mode === 'gutter';
		const overview = mode === 'all' || mode === 'overview';
		const minimap = mode === 'all' || mode === 'minimap';
		const pat = pattern();
		const colors = { added: 'rgba(46, 160, 67, 0.6)', modified: 'rgba(0, 120, 212, 0.6)', deleted: 'rgba(248, 81, 73, 0.6)' };
		const n = model.getLineCount();
		decorations.set(
			state.changes.map((c): Monaco.editor.IModelDeltaDecoration => {
				const type = changeType(c);
				const start = Math.min(n, Math.max(1, c.modifiedStartLineNumber));
				const end = type === 'deleted' ? start : Math.min(n, c.modifiedEndLineNumber);
				const patterned = (type === 'added' && pat.added) || (type === 'modified' && pat.modified);
				return {
					range: new monaco.Range(start, 1, end, 1),
					options: {
						isWholeLine: true,
						linesDecorationsClassName: gutter ? `kg-qd kg-qd-${type}${patterned ? ' kg-qd-pattern' : ''}` : undefined,
						overviewRuler: overview ? { color: colors[type], position: OverviewRulerLane.Left } : undefined,
						minimap: minimap ? { color: colors[type], position: MinimapPosition.Gutter } : undefined
					}
				};
			})
		);
		// The open peek follows the edits: same change number, or closes when the changes are gone.
		if (state.peek) {
			if (!state.changes.length) state.peek.close();
			else state.peek.show(Math.min(state.peek.index, state.changes.length - 1), false);
		}
	}

	const subs = [
		ed.onDidChangeModelContent(() => {
			clearTimeout(timer);
			timer = setTimeout(compute, 150);
		}),
		ed.onDidChangeModel(() => compute()),
		ed.onMouseDown((e) => {
			if (e.target.type !== MouseTargetType.GUTTER_LINE_DECORATIONS) return;
			const el = e.target.element;
			if (!el || !el.className.includes('kg-qd')) return;
			if (settings.get<string>('scm.diffDecorationsGutterAction') !== 'diff') return;
			const line = e.target.position?.lineNumber;
			if (!line) return;
			const i = changeAt(state.changes, line);
			if (i < 0) return;
			e.event.preventDefault();
			if (state.peek && state.peek.index === i) state.peek.close();
			else state.openPeek(i);
		})
	];

	return {
		render() {
			// Reactive reads (settings, the index version) re-run the caller's effect.
			void settings.get('scm.diffDecorations');
			void settings.get('scm.diffDecorationsGutterPattern');
			void settings.get('scm.diffDecorationsIgnoreTrimWhitespace');
			void settings.get('diffEditor.ignoreTrimWhitespace');
			void versions.gen;
			const p = view.path();
			if (isRepoFile(p)) void versions.index(p);
			compute();
		},
		dispose() {
			clearTimeout(timer);
			state.peek?.close();
			subs.forEach((s) => s.dispose());
			decorations.clear();
			states.delete(view);
		}
	};
}

// --- Commands (VS Code ids).

function withState(): { view: ScmView; state: State; path: string } | null {
	const view = activeView();
	const state = view && states.get(view);
	const path = view?.path() ?? null;
	return view && state && isRepoFile(path) ? { view, state, path } : null;
}

function showChange(dir: 1 | -1) {
	const at = withState();
	if (!at) return;
	at.state.recompute();
	const { state, view } = at;
	if (!state.changes.length) return status.flash(t('scmEditor.noChanges'));
	if (state.peek) return state.peek.step(dir);
	const line = view.ed.getPosition()?.lineNumber ?? 1;
	state.openPeek(stepChange(state.changes, line, dir));
}

function goToChange(dir: 1 | -1) {
	const at = withState();
	if (!at) return;
	at.state.recompute();
	const { state, view } = at;
	if (!state.changes.length) return status.flash(t('scmEditor.noChanges'));
	const i = stepChange(state.changes, view.ed.getPosition()?.lineNumber ?? 1, dir);
	const line = Math.max(1, state.changes[i].modifiedStartLineNumber);
	view.ed.setPosition({ lineNumber: line, column: 1 });
	view.ed.revealLineInCenterIfOutsideViewport(line);
	view.ed.focus();
}

async function stageSelected() {
	const at = withState();
	if (!at) return;
	const index = await versions.loadIndex(at.path);
	if (index === null) return status.flash(t('scmEditor.notInIndex'));
	const next = stageRanges(index, at.view.ed.getModel()?.getValue() ?? '', selectionsOf(at.view.ed));
	if (next === null) return notifications.info(t('scmEditor.noChangesInSelection'), { source: 'Git' });
	if (await writeIndex(at.path, index, next)) status.flash(t('scmEditor.staged'));
}

async function revertSelected() {
	const at = withState();
	if (!at) return;
	const index = await versions.loadIndex(at.path);
	if (index === null) return status.flash(t('scmEditor.notInIndex'));
	const next = revertRanges(index, at.view.ed.getModel()?.getValue() ?? '', selectionsOf(at.view.ed));
	if (next === null) return notifications.info(t('scmEditor.noChangesInSelection'), { source: 'Git' });
	await revertTo(at.view, next);
}

/** From the Staged Changes diff tab (selections are index lines), else the file's editor. */
async function unstageSelected() {
	const diff = [...indexDiffViews].find((v) => v.key() !== null && v.key() === editors.active);
	const path = diff ? parseIndexDiffKey(diff.key()!) : withState()?.path;
	if (!path) return;
	const [head, index] = await Promise.all([versions.loadHead(path), versions.loadIndex(path)]);
	if (index === null) return status.flash(t('scmEditor.notInIndex'));
	const sel = diff ? diff.selections() : selectionsOf(activeView()!.ed);
	const next = diff ? unstageRangesOfIndex(head ?? '', index, sel) : unstageRanges(head ?? '', index, activeView()?.ed.getModel()?.getValue() ?? '', sel);
	if (next === null) return notifications.info(t('scmEditor.noChangesInSelection'), { source: 'Git' });
	if (await writeIndex(path, index, next)) status.flash(t('scmEditor.unstaged'));
}

/** Git: Open Changes: the active file's working tree diff, or its staged diff when only that is left. */
function openChange() {
	const path = editors.active;
	if (!isRepoFile(path)) return;
	const e = versions.entry(path);
	if (!e) return status.flash(t('scmEditor.noChanges'));
	editors.open(e.worktree || e.conflict ? diffKey(path) : indexDiffKey(path), { preview: false });
}

export function installQuickDiffCommands(): () => void {
	const K = QUICK_DIFF_KEYS;
	const inFile = () => withState() !== null;
	// Below the chat edit and review keys on ⌥F5 (they are enabled only in their own files).
	return [
		commands.register({ ...K.next, when: inFile, weight: -1, run: () => showChange(1) }),
		commands.register({ ...K.previous, when: inFile, weight: -1, run: () => showChange(-1) }),
		commands.register({ ...K.nextChange, when: inFile, run: () => goToChange(1) }),
		commands.register({ ...K.previousChange, when: inFile, run: () => goToChange(-1) }),
		commands.register({ ...K.stageSelected, when: () => inFile() && scm.repo !== null, run: () => stageSelected() }),
		commands.register({ ...K.revertSelected, when: () => inFile() && scm.repo !== null, run: () => revertSelected() }),
		commands.register({ ...K.unstageSelected, when: () => scm.repo !== null && (inFile() || [...indexDiffViews].some((v) => v.key() === editors.active)), run: () => unstageSelected() }),
		commands.register({ id: 'git.stageChange', title: 'Git: Stage Change', palette: false, run: () => { const at = withState(); if (at?.state.peek) stagePeek(at.view); } }),
		commands.register({ id: 'git.revertChange', title: 'Git: Revert Change', palette: false, run: () => { const at = withState(); if (at?.state.peek) revertPeek(at.view); } }),
		commands.register({ id: 'git.openChange', title: 'Git: Open Changes', when: () => scm.repo !== null && isRepoFile(editors.active), run: openChange })
	].reduce((all, u) => () => (all(), u()), () => {});
}
