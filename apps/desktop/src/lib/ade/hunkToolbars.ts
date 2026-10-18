// The hunk toolbars of a task diff (VS Code's chat editing Keep / Undo per change): a small
// Accept / Reject bar at the right end of each hunk's first line on the modified side, drawn in
// one overlay widget that follows scrolling, plus a highlight of the hunk at the cursor and a
// mark on accepted ones. The hunks and actions come from hunkReview.svelte.ts.

import type * as Monaco from 'monaco-editor';
import { keyOf } from '#lib/workbench/commands.svelte.ts';
import { keyLabel } from '#lib/workbench/keys.ts';
import { hunkReview, type HunkView } from './hunkReview.svelte.ts';
import { HUNK_SHORTCUTS, hunkAt, hunkLines, type Hunk } from './hunkReview.ts';
import { t } from '#lib/i18n/index.ts';

export type HunkToolbars = HunkView & { dispose(): void };

const tip = (title: string, cmd: { id: string; key?: string }) => {
	const k = keyOf(cmd);
	return k ? `${title} (${keyLabel(k)})` : title;
};

export function installHunkToolbars(diff: Monaco.editor.IStandaloneDiffEditor, shownKey: () => string | null): HunkToolbars {
	const ed = diff.getModifiedEditor();
	const root = document.createElement('div');
	root.className = 'kg-hunk-bars';
	const widget: Monaco.editor.IOverlayWidget = { getId: () => 'kingu.hunkToolbars', getDomNode: () => root, getPosition: () => null };
	ed.addOverlayWidget(widget);
	const current = ed.createDecorationsCollection();
	const accepted = ed.createDecorationsCollection();
	/** The user (or a reveal) placed the cursor since this file was shown. */
	let placed = false;
	let shownFor: string | null = null;

	const hunks = (): Hunk[] => {
		const key = shownKey();
		return (key && hunkReview.files[key]?.hunks) || [];
	};

	function bar(key: string, h: Hunk, i: number, count: number, isCurrent: boolean): HTMLElement {
		const ok = hunkReview.accepted(key, h.id);
		const el = document.createElement('div');
		el.className = 'kg-hunk-bar' + (isCurrent ? ' kg-hunk-bar-current' : '') + (ok ? ' kg-hunk-bar-ok' : '');
		el.dataset.line = String(hunkLines(h)[0]);
		// Monaco would take a press here as a click on the text.
		for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) el.addEventListener(type, (e) => e.stopPropagation());
		const label = document.createElement('span');
		label.className = 'kg-hunk-count';
		label.textContent = `${i + 1}/${count}`;
		const accept = document.createElement('button');
		accept.type = 'button';
		accept.textContent = ok ? t('ade.hunks.accepted') : t('ade.hunks.accept');
		accept.title = ok ? t('ade.hunks.unaccept') : tip(t('ade.hunks.acceptTip'), HUNK_SHORTCUTS.acceptHunk);
		accept.onclick = () => (ok ? hunkReview.toggle(key, i) : hunkReview.accept(key, i));
		const reject = document.createElement('button');
		reject.type = 'button';
		reject.textContent = t('ade.hunks.reject');
		reject.title = tip(t('ade.hunks.rejectTip'), HUNK_SHORTCUTS.rejectHunk);
		reject.onclick = () => void hunkReview.reject(key, i);
		el.append(label, accept, reject);
		return el;
	}

	/** Places the bars for the current scroll position. */
	function layout() {
		const info = ed.getLayoutInfo();
		root.style.width = `${info.width}px`;
		const right = info.verticalScrollbarWidth + info.minimap.minimapWidth + 6;
		const top = ed.getScrollTop();
		const lineHeight = 18;
		for (const el of root.children as HTMLCollectionOf<HTMLElement>) {
			const y = ed.getTopForLineNumber(Number(el.dataset.line)) - top;
			el.style.top = `${y}px`;
			el.style.right = `${right}px`;
			el.style.display = y < -lineHeight || y > info.height ? 'none' : '';
		}
	}

	function refresh() {
		const key = shownKey();
		if (key !== shownFor) {
			shownFor = key;
			placed = false;
		}
		const list = hunks();
		const cur = placed ? hunkAt(list, ed.getPosition()?.lineNumber ?? 1) : -1;
		root.replaceChildren(...(key ? list.map((h, i) => bar(key, h, i, list.length, i === cur)) : []));
		const range = (h: Hunk) => {
			const [a, b] = hunkLines(h);
			return { startLineNumber: a, startColumn: 1, endLineNumber: b, endColumn: 1 };
		};
		const c = list[cur];
		current.set(c ? [{ range: range(c), options: { isWholeLine: true, className: 'kg-hunk-current', linesDecorationsClassName: 'kg-hunk-current-gutter' } }] : []);
		accepted.set(key ? list.filter((h) => hunkReview.accepted(key, h.id)).map((h) => ({ range: range(h), options: { isWholeLine: true, linesDecorationsClassName: 'kg-hunk-accepted-gutter' } })) : []);
		layout();
	}

	const subs = [
		ed.onDidScrollChange(layout),
		ed.onDidLayoutChange(layout),
		ed.onDidChangeCursorPosition((e) => {
			if (e.source !== 'api' || placed) {
				placed = true;
				refresh();
			}
		})
	];

	return {
		key: shownKey,
		reveal(h: Hunk) {
			const [a] = hunkLines(h);
			placed = true;
			ed.setPosition({ lineNumber: a, column: 1 });
			ed.revealLineInCenterIfOutsideViewport(a);
			ed.focus();
			refresh();
		},
		cursorLine: () => (placed ? (ed.getPosition()?.lineNumber ?? null) : null),
		focused: () => diff.getContainerDomNode().contains(document.activeElement),
		refresh,
		dispose() {
			subs.forEach((s) => s.dispose());
			current.clear();
			accepted.clear();
			ed.removeOverlayWidget(widget);
		}
	};
}
