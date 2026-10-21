// Zoom of the image preview (VS Code's media-preview imagePreview.js and zoomStatusBarEntry.ts):
// the image starts scaled to fit ('fit'), click / Zoom In steps up through fixed levels, ⌥-click
// (Ctrl-click off macOS) / Zoom Out steps down, and the status bar shows "Whole Image" or the
// percentage with a picker of common levels. Pure, so bun tests cover it.

export type Scale = number | 'fit';

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 20;
/** Images shown above this scale render pixelated, so pixels stay sharp. */
export const PIXELATION_THRESHOLD = 3;
export const ZOOM_LEVELS: readonly number[] = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.5, 2, 3, 5, 7, 10, 15, 20];
/** The status bar picker's levels. */
export const PICK_SCALES: readonly Scale[] = [10, 5, 2, 1, 0.5, 0.2, 'fit'];

const clamp = (v: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));

/** `fitted`: the scale the image has while it fits the pane (zooming from 'fit' starts there). */
const current = (scale: Scale, fitted: number) => (scale === 'fit' ? clamp(fitted > 0 ? fitted : 1) : scale);

/** The next level up from `scale`. */
export function zoomIn(scale: Scale, fitted: number): number {
	const s = current(scale, fitted);
	return ZOOM_LEVELS.find((l) => l > s) ?? MAX_SCALE;
}

/** The next level down from `scale`. */
export function zoomOut(scale: Scale, fitted: number): number {
	const s = current(scale, fitted);
	return [...ZOOM_LEVELS].reverse().find((l) => l < s) ?? MIN_SCALE;
}

/** A pinch or ⌃-wheel step (VS Code's SCALE_PINCH_FACTOR): `deltaY` from the wheel event. */
export function zoomByWheel(scale: Scale, fitted: number, deltaY: number): number {
	const s = current(scale, fitted);
	return clamp(s * (1 - deltaY * 0.075 * 0.1));
}

/** "Whole Image", or the percentage. */
export const zoomLabel = (scale: Scale, whole: string) => (scale === 'fit' ? whole : `${Math.round(scale * 100)}%`);

/** Whether a click zooms out: ⌥ on macOS, Ctrl elsewhere. */
export const clickZoomsOut = (e: Pick<MouseEvent, 'altKey' | 'ctrlKey'>, mac: boolean) => (mac ? e.altKey : e.ctrlKey);
