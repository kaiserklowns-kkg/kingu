// Where attachments come from: a pasted clipboard image (saved by Rust, `paste_image_save`) and
// files dropped from Finder. The webview gets no HTML5 file drop (Tauri handles drag-drop), so a
// drop arrives as Tauri's drag-drop event with paths and a position, hit-tested against the
// element that wants it.

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';

/** The clipboard's image, when it carries one and no text (Orca: text wins over an image). */
export function clipboardImage(e: ClipboardEvent): File | null {
	const data = e.clipboardData;
	if (!data || data.getData('text/plain')) return null;
	for (const item of data.items) {
		if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
	}
	return null;
}

/** Saves a pasted image in Kingu's paste folder; its path. */
export async function savePastedImage(file: Blob): Promise<string> {
	return invoke<string>('paste_image_save', new Uint8Array(await file.arrayBuffer()));
}

export type DropHandlers = { drop: (paths: string[]) => void; hover?: (over: boolean) => void };

/** Files dropped onto `el` (and, with `hover`, whether a drag is over it). */
export function onFileDrop(el: HTMLElement, handlers: DropHandlers): () => void {
	let over = false;
	const inside = (x: number, y: number) => {
		const r = el.getBoundingClientRect();
		return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
	};
	const setOver = (v: boolean) => {
		if (v !== over) handlers.hover?.((over = v));
	};
	let stop: (() => void) | null = null;
	let disposed = false;
	void getCurrentWebview()
		.onDragDropEvent((e) => {
			const p = e.payload;
			if (p.type === 'leave') return setOver(false);
			const pos = p.position.toLogical(window.devicePixelRatio || 1);
			const hit = inside(pos.x, pos.y);
			if (p.type === 'drop') {
				setOver(false);
				if (hit && p.paths.length) handlers.drop(p.paths);
			} else setOver(hit);
		})
		.then((unlisten) => {
			if (disposed) unlisten();
			else stop = unlisten;
		})
		.catch(() => {});
	return () => {
		disposed = true;
		stop?.();
	};
}
