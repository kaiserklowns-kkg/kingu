// Where dictated text goes (Orca's dictation-insertion-target): the element focused when the
// dictation started, kept until the text arrives. A terminal (xterm's helper textarea) gets it
// as a paste through INSERT_EVENT, which Terminal.svelte and adeTerminal.svelte.ts answer; a
// text box, Monaco's input area or a contenteditable as typed text, so undo and the app's
// bindings see it.

/** Dispatched (bubbling, cancelable) on a terminal's textarea with `{ text }`; a terminal that pastes it calls preventDefault. */
export const INSERT_EVENT = 'kingu:insert-text';

export type InsertTarget = { kind: 'terminal'; element: HTMLElement } | { kind: 'text'; element: HTMLInputElement | HTMLTextAreaElement } | { kind: 'editable'; element: HTMLElement };

type ElementLike = Pick<HTMLElement, 'closest' | 'isContentEditable' | 'tagName'> & { type?: string; readOnly?: boolean; disabled?: boolean };

/** Input types that hold free text. */
const TEXT_INPUTS = new Set(['text', 'search', 'url', 'email', '']);

/** What kind of target `el` is, or null when nothing can take text. */
export function targetKind(el: ElementLike | null): InsertTarget['kind'] | null {
	if (!el) return null;
	if (el.closest('.xterm')) return 'terminal';
	if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT_INPUTS.has(el.type ?? ''))) return el.readOnly || el.disabled ? null : 'text';
	if (el.isContentEditable) return 'editable';
	return null;
}

export function captureTarget(doc: Document = document): InsertTarget | null {
	const el = doc.activeElement as HTMLElement | null;
	const kind = targetKind(el);
	if (!el || !kind) return null;
	return kind === 'text' ? { kind, element: el as HTMLInputElement | HTMLTextAreaElement } : { kind, element: el };
}

/** `text` with a space before it when it would otherwise run into the word before the caret. */
export function spaced(before: string, text: string): string {
	return before && !/\s$/.test(before) && !/^[\s.,!?;:)]/.test(text) ? ` ${text}` : text;
}

/** Puts `text` into `target`; false when the target is gone or refused it. */
export function insertText(target: InsertTarget, text: string): boolean {
	const el = target.element;
	if (!el.isConnected || !text) return false;
	if (target.kind === 'terminal') {
		const ev = new CustomEvent(INSERT_EVENT, { detail: { text }, bubbles: true, cancelable: true });
		el.dispatchEvent(ev);
		return ev.defaultPrevented;
	}
	el.focus();
	let value = text;
	if (target.kind === 'text') {
		const box = target.element;
		value = spaced(box.value.slice(0, box.selectionStart ?? box.value.length), text);
		// execCommand keeps undo and fires `input`; WebKit still supports it for text controls.
		if (document.execCommand('insertText', false, value)) return true;
		box.setRangeText(value, box.selectionStart ?? box.value.length, box.selectionEnd ?? box.value.length, 'end');
		box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
		return true;
	}
	const sel = el.ownerDocument.getSelection();
	const before = sel?.anchorNode?.textContent?.slice(0, sel.anchorOffset) ?? '';
	return document.execCommand('insertText', false, spaced(before, value));
}
