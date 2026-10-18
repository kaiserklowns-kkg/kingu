// Native message boxes (src-tauri/src/dialog.rs). Every question goes through here rather than the
// dialog plugin's ask/message: macOS gives Escape only to a button titled exactly "Cancel", so the
// plugin's alerts with Thai labels ignored Escape (VS Code: Escape = Cancel).

import { invoke } from '@tauri-apps/api/core';

export type MessageKind = 'info' | 'warning' | 'error';

export type MessageBoxOptions = {
	title?: string;
	kind?: MessageKind;
	/** Left to right; the first is the default (Return). 1 to 3 buttons. */
	buttons: string[];
	/** The answer for Escape. Defaults to the last button. */
	cancelId?: number;
	/** Gets ⌘D on macOS (NSAlert's "Don't Save"). */
	dontSaveId?: number;
};

export const CANCEL = 'ยกเลิก (Cancel)';

/** The request sent to Rust (pure, for tests). */
export function messageBoxRequest(message: string, o: MessageBoxOptions) {
	const cancelId = o.cancelId ?? o.buttons.length - 1;
	return { title: o.title ?? 'Kingu', message, kind: o.kind ?? 'info', buttons: o.buttons, cancelId, dontSaveId: o.dontSaveId ?? null };
}

/** Resolves to the index of the pressed button (`cancelId` for Escape). */
export function messageBox(message: string, o: MessageBoxOptions): Promise<number> {
	return invoke<number>('message_box', { options: messageBoxRequest(message, o) });
}

/** Resolves to the label of the pressed button. */
export async function choose(message: string, o: MessageBoxOptions): Promise<string> {
	return o.buttons[await messageBox(message, o)] ?? o.buttons[o.cancelId ?? o.buttons.length - 1];
}

/** OK / Cancel: true for OK. Same options as the dialog plugin's `ask`. */
export async function ask(message: string, o: { title?: string; kind?: MessageKind; okLabel?: string; cancelLabel?: string } = {}): Promise<boolean> {
	return (await messageBox(message, { title: o.title, kind: o.kind, buttons: [o.okLabel ?? 'OK', o.cancelLabel ?? CANCEL], cancelId: 1 })) === 0;
}

/** A message with one OK button. */
export async function message(text: string, o: { title?: string; kind?: MessageKind; okLabel?: string } = {}): Promise<void> {
	await messageBox(text, { title: o.title, kind: o.kind, buttons: [o.okLabel ?? 'OK'], cancelId: 0 });
}
