// The image previews' zoom per image (imageZoom.ts), for the viewer, the Image Preview commands
// (Zoom In / Zoom Out) and the status bar's zoom entry.

import { SvelteMap } from 'svelte/reactivity';
import { commands } from './commands.svelte';
import { editors } from './editors.svelte';
import { isImagePath } from './viewers';
import { quick } from './quick.svelte';
import { PICK_SCALES, zoomIn, zoomLabel, zoomOut, type Scale } from './imageZoom';
import { t } from '#lib/i18n/index.ts';

class ImageZoom {
	/** The scale per image key ('fit' when absent). */
	#scales = new SvelteMap<string, Scale>();
	/** The fitted scale per image, reported by the viewer. */
	#fitted = new Map<string, number>();

	scaleOf(path: string): Scale {
		return this.#scales.get(path) ?? 'fit';
	}
	set(path: string, scale: Scale) {
		if (scale === 'fit') this.#scales.delete(path);
		else this.#scales.set(path, scale);
	}
	/** The viewer's report while the image fits: its scale then (zooming from fit starts there). */
	fitted(path: string, scale: number) {
		this.#fitted.set(path, scale);
	}
	zoomIn(path: string) {
		this.set(path, zoomIn(this.scaleOf(path), this.#fitted.get(path) ?? 1));
	}
	zoomOut(path: string) {
		this.set(path, zoomOut(this.scaleOf(path), this.#fitted.get(path) ?? 1));
	}
	fittedOf(path: string) {
		return this.#fitted.get(path) ?? 1;
	}
	/** The status bar label of the active image, or null when no image is active. */
	get label(): string | null {
		const path = activeImage();
		return path ? zoomLabel(this.scaleOf(path), t('workbench.imageZoom.whole')) : null;
	}
	/** The status bar's picker of zoom levels (VS Code's _imagePreview.selectZoomLevel). */
	pick() {
		const path = activeImage();
		if (!path) return;
		quick.pick({
			placeholder: t('workbench.imageZoom.select'),
			items: PICK_SCALES.map((s) => ({ id: String(s), label: zoomLabel(s, t('workbench.imageZoom.whole')) })),
			onAccept: (item) => this.set(path, item.id === 'fit' ? 'fit' : Number(item.id))
		});
	}
}

export const imageZoom = new ImageZoom();

/** The active editor when it is an image preview. */
export const activeImage = () => (editors.active && isImagePath(editors.active) ? editors.active : null);

/** VS Code's Image Preview commands; returns the unregister function. */
export function installImageZoomCommands(): () => void {
	const unregister = [
		commands.register({ id: 'imagePreview.zoomIn', title: 'Zoom in', category: 'Image Preview', when: () => activeImage() !== null, run: () => imageZoom.zoomIn(activeImage()!) }),
		commands.register({ id: 'imagePreview.zoomOut', title: 'Zoom out', category: 'Image Preview', when: () => activeImage() !== null, run: () => imageZoom.zoomOut(activeImage()!) }),
		commands.register({ id: '_imagePreview.selectZoomLevel', title: 'Select zoom level', palette: false, when: () => activeImage() !== null, run: () => imageZoom.pick() })
	];
	return () => unregister.forEach((u) => u());
}
