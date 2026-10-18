// Review notes inside a Monaco diff (Orca's useDiffCommentDecorator): a "+" button follows the
// hovered line of the modified side (Monaco glyphs take no clicks), a click opens a draft card in
// a view zone under the line (the selected lines when the selection covers it), and each saved
// note of the file is a card in a view zone under its last line. Only changed lines and the
// three lines of context around them take notes, like the hunks of a git diff.

import { mount, unmount, type ComponentProps } from 'svelte';
import type * as Monaco from 'monaco-editor';
import DiffNoteCard from './DiffNoteCard.svelte';
import { diffNotes } from './diffNotes.svelte.ts';
import { commentableLines, lineTarget, notesOfFile, type NoteTarget } from './diffNotes.ts';

const BUTTON = 18;

type Zone = { id: string; node: HTMLElement; zone: Monaco.editor.IViewZone; app: ReturnType<typeof mount>; observer: ResizeObserver };

export type NoteFile = { key: string; file: string };

export type DiffNotesHandle = {
	/** Rebuilds the note cards (the notes or the shown file changed). */
	refresh(): void;
	/** Opens a draft for the selected lines (the editor's context menu). */
	addFromSelection(): void;
	reveal(line: number): void;
	dispose(): void;
};

export function installDiffNotes(monaco: typeof Monaco, diff: Monaco.editor.IStandaloneDiffEditor, current: () => NoteFile | null): DiffNotesHandle {
	const ed = diff.getModifiedEditor();
	let zones: Zone[] = [];
	let draft: Zone | null = null;
	let commentable = new Set<number>();
	let hovered: number | null = null;
	let disposed = false;

	const plus = document.createElement('button');
	plus.type = 'button';
	plus.className = 'kg-note-add';
	plus.title = 'เพิ่มโน้ตรีวิวถึง agent';
	plus.setAttribute('aria-label', 'เพิ่มโน้ตรีวิว');
	plus.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>';
	plus.style.display = 'none';
	ed.getDomNode()?.appendChild(plus);

	function addZone(afterLine: number, props: ComponentProps<typeof DiffNoteCard>): Zone {
		const node = document.createElement('div');
		node.className = 'kg-note-zone';
		// Monaco would take a press inside the card as a click on the text and steal focus.
		for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'keydown', 'keyup', 'keypress']) node.addEventListener(type, (e) => e.stopPropagation());
		const zone: Monaco.editor.IViewZone = { afterLineNumber: afterLine, heightInPx: 96, domNode: node, suppressMouseDown: false };
		let id = '';
		ed.changeViewZones((a) => (id = a.addZone(zone)));
		const app = mount(DiffNoteCard, { target: node, props });
		const observer = new ResizeObserver(() => {
			const card = node.firstElementChild as HTMLElement | null;
			const h = card ? Math.ceil(card.getBoundingClientRect().height) + 8 : 0;
			if (h > 8 && h !== zone.heightInPx) {
				zone.heightInPx = h;
				ed.changeViewZones((a) => a.layoutZone(id));
			}
		});
		if (node.firstElementChild) observer.observe(node.firstElementChild);
		return { id, node, zone, app, observer };
	}

	function removeZone(z: Zone) {
		z.observer.disconnect();
		void unmount(z.app);
		ed.changeViewZones((a) => a.removeZone(z.id));
	}

	function closeDraft() {
		if (draft) removeZone(draft);
		draft = null;
	}

	function openDraft(target: NoteTarget) {
		const at = current();
		if (!at) return;
		closeDraft();
		draft = addZone(target.lineNumber, {
			target,
			onSave: async (body: string) => {
				const ok = await diffNotes.add(at.key, at.file, target, body);
				if (ok) closeDraft();
				return ok;
			},
			onCancel: closeDraft
		});
	}

	function refresh() {
		if (disposed) return;
		for (const z of zones) removeZone(z);
		zones = [];
		const at = current();
		if (!at || !ed.getModel()) return;
		const send = diffNotes.delivery(at.key) === 'none' ? 'คัดลอกโน้ตนี้' : 'ส่งโน้ตนี้ถึง agent';
		for (const n of notesOfFile(diffNotes.list(at.key), at.file)) {
			zones.push(
				addZone(n.lineNumber, {
					target: { lineNumber: n.lineNumber, startLine: n.startLine },
					note: n,
					sendLabel: send,
					sending: !!diffNotes.sending[n.id],
					onSave: (body: string) => diffNotes.update(at.key, n.id, body),
					onDelete: () => void diffNotes.remove(at.key, n.id),
					onSend: () => void diffNotes.send(at.key, [n])
				})
			);
		}
	}

	/** The note's lines for a press on `line`: the selection when it covers that line, else the line. */
	function targetAt(line: number): NoteTarget {
		const sel = ed.getSelection();
		if (sel && !sel.isEmpty() && sel.startLineNumber <= line && line <= sel.endLineNumber) {
			// A selection ending at column 1 does not take that last line.
			const end = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
			const lines = Array.from({ length: end - sel.startLineNumber + 1 }, (_, i) => sel.startLineNumber + i);
			if (lines.every((l) => commentable.has(l))) return lineTarget(sel.startLineNumber, end);
		}
		return lineTarget(line);
	}

	function place(line: number | null) {
		hovered = line;
		if (line === null || !commentable.has(line) || !current()) {
			plus.style.display = 'none';
			return;
		}
		const lineHeight = ed.getOption(monaco.editor.EditorOption.lineHeight);
		const top = ed.getTopForLineNumber(line) - ed.getScrollTop() + Math.round((lineHeight - BUTTON) / 2);
		const info = ed.getLayoutInfo();
		plus.style.top = `${top}px`;
		plus.style.left = `${Math.max(0, info.contentLeft - BUTTON - 2)}px`;
		plus.style.display = 'flex';
	}

	let hide: ReturnType<typeof setTimeout> | undefined;
	const subs = [
		ed.onMouseMove((e) => {
			clearTimeout(hide);
			const T = monaco.editor.MouseTargetType;
			const zoneHit = e.target.type === T.CONTENT_VIEW_ZONE || e.target.type === T.GUTTER_VIEW_ZONE;
			place(zoneHit ? null : (e.target.position?.lineNumber ?? null));
		}),
		ed.onMouseLeave(() => {
			hide = setTimeout(() => place(null), 120);
		}),
		ed.onDidScrollChange(() => hovered !== null && place(hovered)),
		diff.onDidUpdateDiff(() => {
			commentable = commentableLines(diff.getLineChanges() ?? [], ed.getModel()?.getLineCount() ?? 0);
		}),
		// The view (and its zones) is rebuilt with a new model.
		ed.onDidChangeModel(() => {
			for (const z of zones) (z.observer.disconnect(), void unmount(z.app));
			if (draft) (draft.observer.disconnect(), void unmount(draft.app));
			zones = [];
			draft = null;
			commentable = new Set();
			place(null);
		})
	];
	plus.addEventListener('mouseenter', () => clearTimeout(hide));
	plus.addEventListener('mousedown', (e) => (e.preventDefault(), e.stopPropagation()));
	plus.addEventListener('click', (e) => {
		e.stopPropagation();
		if (hovered !== null) openDraft(targetAt(hovered));
		place(null);
	});

	return {
		refresh,
		addFromSelection() {
			const sel = ed.getSelection();
			if (!sel) return;
			const line = sel.isEmpty() ? sel.startLineNumber : sel.endLineNumber;
			if (!commentable.has(line) && !commentable.has(sel.startLineNumber)) return;
			openDraft(targetAt(commentable.has(line) ? line : sel.startLineNumber));
		},
		reveal(line: number) {
			ed.revealLineInCenter(line);
			ed.setPosition({ lineNumber: line, column: 1 });
		},
		dispose() {
			disposed = true;
			clearTimeout(hide);
			for (const s of subs) s.dispose();
			for (const z of zones) removeZone(z);
			closeDraft();
			plus.remove();
		}
	};
}
