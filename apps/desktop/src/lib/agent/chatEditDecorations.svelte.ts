// Agent chat edits inside the code editor (VS Code's ChatEditingCodeEditorIntegration,
// ChatEditorOverlayWidget and chatEditingEditorActions): when a file of a chat's working set is
// open in a plain editor, its added and changed lines are highlighted, deleted lines show in view
// zones, the change under the mouse or the cursor gets a Keep / Undo bar, and a floating overlay
// gives "↑ ↓  2 of 5 · Keep · Undo" for the file. The changes are Rust's (`chat_edits_hunks`: the
// snapshot, moved on by kept changes, against the file on disk); Keep / Undo of one change is
// `chat_edits_hunk`, refused while the chat's turn runs.
//
//   chatEditHunks.hunks(path)       the shown changes of an editor file (reactive; reads them
//                                   again when the working set, the file on disk or its
//                                   dirty state moves)
//   attachChatEditDecorations(...)  one editor's decorations, zones and widgets (EditorHost)
//   installChatEditorCommands()     chatEditor.action.* with VS Code's ids and keys

import { invoke } from '@tauri-apps/api/core';
import type * as Monaco from 'monaco-editor';
import { clientLog } from '#lib/client-log.ts';
import { t } from '#lib/i18n/index.ts';
import { hunkAt, stepFrom } from '#lib/ade/hunkReview.ts';
import { commands, keyOf } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { reloadClean } from '#lib/workbench/editorModels.ts';
import { keyLabel } from '#lib/workbench/keys.ts';
import { ask } from '#lib/workbench/messageBox.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { chatEdits } from './chatEdits.svelte.ts';
import { workspacePath } from './chatEdits.ts';
import { chats } from './chats.svelte.ts';
import {
	addedLines,
	afterResolve,
	CHAT_EDITOR_SHORTCUTS as K,
	clampLine,
	findTarget,
	firstLine,
	hunkAtCursor,
	stepTargetFile,
	targetKey,
	zoneAfter,
	type EditHunk,
	type EditTarget,
	type FileEditHunks
} from './chatEditHunks.ts';

type MonacoApi = typeof Monaco;

/** A code editor that may show a working-set file. */
type EditorView = {
	path(): string | null;
	/** Puts the cursor on the change and scrolls to it. */
	reveal(h: EditHunk): void;
	cursorLine(): number | null;
	/** Focus is in the editor (its text or its widgets). */
	focused(): boolean;
};

type Loaded = { key: string; chatId: string; rel: string; data: FileEditHunks };
type Landing = 'first' | 'last' | number;

class ChatEditHunks {
	/** The changes of shown editor files, by workspace path. */
	files = $state<Record<string, Loaded>>({});
	/** By chat id: bumped by the run's edits events (the agent wrote again). */
	#gen = $state<Record<string, number>>({});
	/** By path: bumped when a clean editor took new contents from disk. */
	#disk = $state<Record<string, number>>({});
	#loading = new Map<string, string>();
	#landing: Record<string, Landing> = {};
	#views = new Set<EditorView>();

	constructor() {
		chats.onEvent((id, ev) => {
			if (ev.kind === 'edits_changed' || ev.kind === 'checkpoint' || ev.kind === 'exit') this.#gen[id] = (this.#gen[id] ?? 0) + 1;
		});
	}

	attach(view: EditorView): () => void {
		this.#views.add(view);
		return () => this.#views.delete(view);
	}

	/** The focused editor, else one showing the active editor's file. */
	activeView(): EditorView | undefined {
		const all = [...this.#views];
		return all.find((v) => v.focused()) ?? all.find((v) => v.path() !== null && v.path() === editors.active);
	}

	#viewFor(path: string): EditorView | undefined {
		const all = [...this.#views].filter((v) => v.path() === path);
		return all.find((v) => v.focused()) ?? all[0];
	}

	diskChanged(path: string) {
		this.#disk[path] = (this.#disk[path] ?? 0) + 1;
	}

	/** The shown changes of editor file `path`; schedules a read when they are missing or stale. */
	hunks(path: string): { target: EditTarget; data: FileEditHunks } | null {
		const target = findTarget(chatEdits.views, path);
		if (!target) return null;
		const key = `${targetKey(target, this.#gen[target.chatId] ?? 0)}|${this.#disk[path] ?? 0}|${editors.isDirty(path) ? 'dirty' : ''}`;
		const loaded = this.files[path];
		if (loaded?.key !== key && this.#loading.get(path) !== key) {
			this.#loading.set(path, key);
			queueMicrotask(() => void this.#load(path, target, key));
		}
		return loaded && loaded.chatId === target.chatId && loaded.rel === target.rel ? { target, data: loaded.data } : null;
	}

	async #load(path: string, target: EditTarget, key: string) {
		let data: FileEditHunks;
		try {
			data = await invoke<FileEditHunks>('chat_edits_hunks', { id: target.chatId, path: target.rel });
		} catch (e) {
			clientLog('info', `chat edit hunks ${path}: ${e}`);
			return;
		} finally {
			if (this.#loading.get(path) === key) this.#loading.delete(path);
		}
		this.files[path] = { key, chatId: target.chatId, rel: target.rel, data };
	}

	/** Where to put the cursor once `path` shows its changes (after stepping into another file). */
	takeLanding(path: string, count: number): number | null {
		const land = this.#landing[path];
		if (land === undefined || !count) return null;
		delete this.#landing[path];
		return land === 'first' ? 0 : land === 'last' ? count - 1 : Math.min(land, count - 1);
	}

	/** The change `i` of `path` (by default the one at the active editor's cursor, else the next below it). */
	#at(path?: string, i?: number) {
		const view = path ? this.#viewFor(path) : this.activeView();
		const p = path ?? view?.path() ?? null;
		const shown = p ? this.hunks(p) : null;
		if (!p || !shown?.data.hunks.length) return null;
		const line = view?.cursorLine() ?? null;
		const index = i ?? (line === null ? 0 : hunkAt(shown.data.hunks, line));
		const h = shown.data.hunks[index];
		return h ? { path: p, view, ...shown, index, h } : null;
	}

	/** Keep (`keep`) or Undo one change, then show the next one (VS Code's revealNextChangeOnResolve). */
	async resolve(keep: boolean, path?: string, i?: number) {
		const at = this.#at(path, i);
		if (!at) return;
		const { chatId, rel } = at.target;
		if (chatEdits.views[chatId]?.running) {
			status.flash(t('chatEditor.running'));
			return;
		}
		if (!keep && editors.isDirty(at.path)) {
			const ok = await ask(t('chatEdits.dirtyConfirm', { count: 1, paths: at.path }), { kind: 'warning', okLabel: t('chatEdits.dirtyOk') });
			if (!ok) return;
		}
		try {
			const data = await invoke<FileEditHunks>('chat_edits_hunk', { id: chatId, path: rel, hunk: at.h.id, keep });
			const loaded = this.files[at.path];
			if (loaded) this.files[at.path] = { ...loaded, data };
			if (!keep) await reloadClean([at.path]);
			status.flash(keep ? t('chatEditor.kept') : t('chatEditor.undone'));
			const next = afterResolve(at.index, data.hunks.length);
			if (next !== null) at.view?.reveal(data.hunks[next]);
		} catch (e) {
			notifications.error(t('chatEdits.failed', { error: String(e) }));
		}
		void chatEdits.refresh(chatId);
	}

	#target(path?: string): { path: string; target: EditTarget } | null {
		const p = path ?? this.activeView()?.path() ?? null;
		const target = p ? findTarget(chatEdits.views, p) : null;
		return p && target ? { path: p, target } : null;
	}

	/** Keep / Undo of the whole file (the overlay's buttons, ⇧⌘Y / ⇧⌘N). */
	async resolveFile(keep: boolean, path?: string) {
		const at = this.#target(path);
		if (!at) return;
		if (keep) await chatEdits.keep(at.target.chatId, [at.target.rel]);
		else await chatEdits.undo(at.target.chatId, [at.target.rel]);
	}

	/** Keep All Chat Edits of the chat that changed the active file. */
	async keepAll(path?: string) {
		const at = this.#target(path);
		if (at) await chatEdits.keep(at.target.chatId, null);
	}

	/** Next / previous change from the cursor; past the last (first) one, the next (previous) working-set file. */
	step(dir: 1 | -1, path?: string) {
		const view = path ? this.#viewFor(path) : this.activeView();
		const p = path ?? view?.path() ?? null;
		const shown = p ? this.hunks(p) : null;
		if (!p || !view || !shown) return;
		const hunks = shown.data.hunks;
		const i = stepFrom(hunks, view.cursorLine(), dir);
		if (i !== null) return view.reveal(hunks[i]);
		const v = chatEdits.views[shown.target.chatId];
		const next = v ? stepTargetFile(v, shown.target.rel, dir) : null;
		if (next) {
			const nextPath = workspacePath(shown.target.prefix, next);
			this.#landing[nextPath] = dir === 1 ? 'first' : 'last';
			editors.open(nextPath, { preview: true });
		} else if (hunks.length) view.reveal(hunks[dir === 1 ? 0 : hunks.length - 1]);
	}
}

export const chatEditHunks = new ChatEditHunks();

const tip = (title: string, cmd: { id: string; key?: string }) => {
	const k = keyOf(cmd);
	return k ? `${title} (${keyLabel(k)})` : title;
};

function button(text: string, title: string, run: () => unknown, cls = ''): HTMLButtonElement {
	const b = document.createElement('button');
	b.type = 'button';
	b.className = cls;
	b.textContent = text;
	b.title = title;
	b.setAttribute('aria-label', title);
	b.onclick = () => void run();
	return b;
}

/** Monaco would take a press on a widget as a click on the text. */
function shield(el: HTMLElement) {
	for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) el.addEventListener(type, (e) => e.stopPropagation());
}

export type ChatEditDecorations = { render(): void; dispose(): void };

/** Draws the chat edits of the file `path()` shows in `ed`; `render` follows the stores (call it from an effect). */
export function attachChatEditDecorations(monaco: MonacoApi, ed: Monaco.editor.IStandaloneCodeEditor, path: () => string | null): ChatEditDecorations {
	const { EditorOption, OverviewRulerLane, MinimapPosition, TrackedRangeStickiness, MouseTargetType } = monaco.editor;
	const lines = ed.createDecorationsCollection();
	let zones: string[] = [];
	/** What the lines and zones were drawn for. */
	let drawn: { path: string | null; data: FileEditHunks | null } = { path: null, data: null };
	let hunks: EditHunk[] = [];
	/** The change under the mouse (-1: none). */
	let hover = -1;
	let barSig = '';
	let overlaySig = '';

	const root = document.createElement('div');
	root.className = 'kg-ce-widgets';
	const bar = document.createElement('div');
	bar.className = 'kg-ce-hunk-bar';
	bar.style.display = 'none';
	const overlay = document.createElement('div');
	overlay.className = 'kg-ce-overlay';
	overlay.style.display = 'none';
	overlay.setAttribute('role', 'toolbar');
	shield(bar);
	shield(overlay);
	root.append(bar, overlay);
	const widget: Monaco.editor.IOverlayWidget = { getId: () => 'kingu.chatEditWidgets', getDomNode: () => root, getPosition: () => null };
	ed.addOverlayWidget(widget);

	const cursorLine = () => ed.getPosition()?.lineNumber ?? null;
	const lineCount = () => ed.getModel()?.getLineCount() ?? 1;

	function drawLines() {
		const n = lineCount();
		const sticky = TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;
		const added = 'rgba(155, 185, 85, 0.6)';
		const removed = 'rgba(255, 0, 0, 0.6)';
		lines.set(
			hunks.flatMap((h): Monaco.editor.IModelDeltaDecoration[] => {
				const r = addedLines(h);
				if (!r) {
					const at = clampLine(zoneAfter(h) || 1, n);
					return [{ range: new monaco.Range(at, 1, at, 1), options: { overviewRuler: { color: removed, position: OverviewRulerLane.Full }, stickiness: sticky } }];
				}
				return [
					{
						range: new monaco.Range(clampLine(r[0], n), 1, clampLine(r[1], n), 1),
						options: {
							isWholeLine: true,
							className: 'kg-ce-added',
							linesDecorationsClassName: 'kg-ce-added-gutter',
							overviewRuler: { color: added, position: OverviewRulerLane.Full },
							minimap: { color: added, position: MinimapPosition.Gutter },
							stickiness: sticky
						}
					}
				];
			})
		);
	}

	function drawZones(data: FileEditHunks | null) {
		const n = lineCount();
		const font = ed.getOption(EditorOption.fontInfo);
		const lineHeight = ed.getOption(EditorOption.lineHeight);
		const language = ed.getModel()?.getLanguageId() ?? 'plaintext';
		const tabSize = ed.getModel()?.getOptions().tabSize ?? 4;
		ed.changeViewZones((a) => {
			for (const id of zones) a.removeZone(id);
			zones = [];
			for (const h of hunks) {
				if (!h.removed.length) continue;
				const node = document.createElement('div');
				node.className = 'kg-ce-removed';
				Object.assign(node.style, { fontFamily: font.fontFamily, fontSize: `${font.fontSize}px`, lineHeight: `${lineHeight}px` });
				for (const text of h.removed) {
					const line = document.createElement('div');
					line.textContent = text || ' ';
					node.append(line);
				}
				const margin = document.createElement('div');
				margin.className = 'kg-ce-removed-margin';
				zones.push(a.addZone({ afterLineNumber: Math.min(zoneAfter(h), n), heightInLines: h.removed.length, domNode: node, marginDomNode: margin, suppressMouseDown: true }));
				// Deleted lines in the file's colors, like VS Code's inline diff.
				void monaco.editor.colorize(h.removed.join('\n'), language, { tabSize }).then(
					(html) => {
						if (drawn.data === data) node.innerHTML = html;
					},
					() => {}
				);
			}
		});
	}

	/** The change the bar is for: under the mouse, else at the cursor. */
	function barIndex(): number {
		if (hover >= 0 && hover < hunks.length) return hover;
		const line = cursorLine();
		return line === null ? -1 : hunkAtCursor(hunks, line);
	}

	function drawBar() {
		const p = path();
		const i = barIndex();
		const h = hunks[i];
		const sig = p && h ? `${p}|${h.id}|${i}|${keyOf(K.acceptHunk)}|${t('chatEdits.keep')}` : '';
		if (sig === barSig) return;
		barSig = sig;
		if (!p || !h) {
			bar.replaceChildren();
			bar.style.display = 'none';
			return;
		}
		bar.style.display = '';
		bar.dataset.line = String(clampLine(firstLine(h), lineCount()));
		bar.replaceChildren(
			button(t('chatEdits.keep'), tip(t('chatEditor.keepHunk'), K.acceptHunk), () => chatEditHunks.resolve(true, p, i), 'kg-ce-primary'),
			button(t('chatEdits.undo'), tip(t('chatEditor.undoHunk'), K.undoHunk), () => chatEditHunks.resolve(false, p, i))
		);
	}

	function drawOverlay() {
		const p = path();
		const line = cursorLine();
		const i = line === null ? -1 : hunkAtCursor(hunks, line);
		const label = i >= 0 ? t('chatEditor.position', { index: i + 1, count: hunks.length }) : t('chatEditor.changes', { count: hunks.length });
		const sig = p && hunks.length ? `${p}|${label}|${keyOf(K.next)}|${t('chatEdits.keep')}` : '';
		if (sig === overlaySig) return;
		overlaySig = sig;
		if (!p || !hunks.length) {
			overlay.replaceChildren();
			overlay.style.display = 'none';
			return;
		}
		overlay.style.display = '';
		overlay.setAttribute('aria-label', t('chatEditor.overlay'));
		const count = document.createElement('span');
		count.className = 'kg-ce-count';
		count.textContent = label;
		const sep = () => {
			const s = document.createElement('span');
			s.className = 'kg-ce-sep';
			return s;
		};
		overlay.replaceChildren(
			button('↑', tip(t('chatEditor.previous'), K.previous), () => chatEditHunks.step(-1, p), 'kg-ce-icon'),
			button('↓', tip(t('chatEditor.next'), K.next), () => chatEditHunks.step(1, p), 'kg-ce-icon'),
			count,
			sep(),
			button(t('chatEdits.keep'), tip(t('chatEditor.keepFile'), K.acceptFile), () => chatEditHunks.resolveFile(true, p), 'kg-ce-primary'),
			button(t('chatEdits.undo'), tip(t('chatEditor.undoFile'), K.undoFile), () => chatEditHunks.resolveFile(false, p))
		);
	}

	/** Places the bar at its change and the overlay at the bottom middle, for the current scroll. */
	function layout() {
		const info = ed.getLayoutInfo();
		root.style.width = `${info.width}px`;
		const right = info.verticalScrollbarWidth + info.minimap.minimapWidth + 6;
		if (bar.dataset.line && bar.style.display !== 'none') {
			const y = ed.getTopForLineNumber(Number(bar.dataset.line)) - ed.getScrollTop();
			bar.style.top = `${y}px`;
			bar.style.right = `${right}px`;
			bar.style.visibility = y < -18 || y > info.height ? 'hidden' : '';
		}
		if (overlay.style.display !== 'none') {
			overlay.style.top = `${Math.max(0, info.height - overlay.offsetHeight - 16)}px`;
			overlay.style.left = `${Math.max(8, (info.width - right - overlay.offsetWidth) / 2)}px`;
		}
	}

	function render() {
		const p = path();
		const shown = p ? chatEditHunks.hunks(p) : null;
		const data = shown && !shown.data.binary ? shown.data : null;
		if (p !== drawn.path || data !== drawn.data) {
			drawn = { path: p, data };
			hunks = data?.hunks ?? [];
			hover = -1;
			drawLines();
			drawZones(data);
		}
		drawBar();
		drawOverlay();
		layout();
		const land = p && hunks.length ? chatEditHunks.takeLanding(p, hunks.length) : null;
		if (land !== null) queueMicrotask(() => view.reveal(hunks[land]));
	}

	const view: EditorView = {
		path,
		reveal(h) {
			const line = clampLine(firstLine(h), lineCount());
			ed.setPosition({ lineNumber: line, column: 1 });
			ed.revealLineInCenterIfOutsideViewport(line);
			ed.focus();
		},
		cursorLine,
		focused: () => ed.hasWidgetFocus()
	};
	const detach = chatEditHunks.attach(view);

	let diskTimer: ReturnType<typeof setTimeout> | undefined;
	const subs = [
		ed.onDidScrollChange(layout),
		ed.onDidLayoutChange(layout),
		ed.onDidChangeCursorPosition(() => {
			drawBar();
			drawOverlay();
			layout();
		}),
		ed.onMouseMove((e) => {
			if (e.target.type === MouseTargetType.OVERLAY_WIDGET) return;
			const line = e.target.position?.lineNumber;
			const next = line ? hunkAtCursor(hunks, line) : -1;
			if (next === hover) return;
			hover = next;
			drawBar();
			layout();
		}),
		ed.onMouseLeave(() => {
			hover = -1;
			drawBar();
			layout();
		}),
		// The agent (or Undo) wrote the file and a clean editor took it: read the changes again.
		ed.onDidChangeModelContent(() => {
			const p = path();
			if (!p || !drawn.data) return;
			clearTimeout(diskTimer);
			diskTimer = setTimeout(() => {
				if (path() === p && !editors.isDirty(p)) chatEditHunks.diskChanged(p);
			}, 300);
		})
	];

	return {
		render,
		dispose() {
			clearTimeout(diskTimer);
			subs.forEach((s) => s.dispose());
			detach();
			lines.clear();
			ed.changeViewZones((a) => zones.forEach((id) => a.removeZone(id)));
			ed.removeOverlayWidget(widget);
		}
	};
}

/** Focus is in an editor whose cursor is in a change (VS Code's ctxCursorInChangeRange + editorFocus). */
function cursorInChange(): boolean {
	const v = chatEditHunks.activeView();
	const p = v?.path();
	const line = v?.cursorLine();
	const shown = p ? chatEditHunks.hunks(p) : null;
	return !!v?.focused() && !!shown && line != null && hunkAtCursor(shown.data.hunks, line) >= 0;
}

/** The chat editing editor actions (palette, keybindings.json), for the file in the active editor. */
export function installChatEditorCommands(): () => void {
	const hasChanges = () => {
		const p = chatEditHunks.activeView()?.path();
		return !!p && (chatEditHunks.hunks(p)?.data.hunks.length ?? 0) > 0;
	};
	const inTarget = () => {
		const p = chatEditHunks.activeView()?.path();
		return !!p && findTarget(chatEdits.views, p) !== null;
	};
	const focused = () => chatEditHunks.activeView()?.focused() ?? false;
	// Weights as VS Code's: the change keys over New File (⌘N), the file keys over New Window.
	const cmd = (s: { id: string; title: string; key: string }, run: () => unknown, when: () => boolean, keyWhen: () => boolean, weight: number) =>
		commands.register({ ...s, category: 'Chat', when, keyWhen, weight, run });
	const off = [
		cmd(K.acceptHunk, () => chatEditHunks.resolve(true), hasChanges, cursorInChange, 101),
		cmd(K.undoHunk, () => chatEditHunks.resolve(false), hasChanges, cursorInChange, 101),
		cmd(K.acceptFile, () => chatEditHunks.resolveFile(true), inTarget, focused, 110),
		cmd(K.undoFile, () => chatEditHunks.resolveFile(false), inTarget, focused, 110),
		cmd(K.next, () => chatEditHunks.step(1), hasChanges, focused, 100),
		cmd(K.previous, () => chatEditHunks.step(-1), hasChanges, focused, 100),
		cmd(K.acceptAll, () => chatEditHunks.keepAll(), inTarget, focused, 100)
	];
	return () => off.forEach((f) => f());
}
