// Floating terminal geometry (Orca's FloatingTerminalPanel): kept inside the window.

export type Rect = { x: number; y: number; w: number; h: number };

export const MIN_W = 360;
export const MIN_H = 200;

/** Clamps a panel rect so its title bar stays reachable in a `vw`×`vh` window. */
export function clampRect(r: Rect, vw: number, vh: number): Rect {
	const w = Math.min(Math.max(r.w, MIN_W), vw - 16);
	const h = Math.min(Math.max(r.h, MIN_H), vh - 16);
	return { w, h, x: Math.min(Math.max(r.x, 8), vw - w - 8), y: Math.min(Math.max(r.y, 8), vh - h - 8) };
}

/** Bottom-right default, above the status bar. */
export const defaultRect = (vw: number, vh: number): Rect => clampRect({ w: 640, h: 360, x: vw - 640 - 24, y: vh - 360 - 48 }, vw, vh);
