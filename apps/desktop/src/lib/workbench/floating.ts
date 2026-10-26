// Floating workspace geometry, as Orca computes it: the panel and its toggle button are stored
// anchored to the nearest window corner (offsets from that corner), so they keep their place when
// the window resizes; both are clamped under the 36px title bar.

export type Rect = { left: number; top: number; width: number; height: number };
export type Anchor = { anchorX: 'left' | 'right'; anchorY: 'top' | 'bottom'; offsetX: number; offsetY: number };
export type AnchoredBounds = Anchor & { width: number; height: number };

export const TITLEBAR = 36;
export const MARGIN = 8;
export const MIN_W = 420;
export const MIN_H = 280;
export const BUTTON = 36;

export const DEFAULT_BOUNDS: AnchoredBounds = { anchorX: 'right', anchorY: 'bottom', offsetX: 24, offsetY: 84, width: 920, height: 560 };
export const DEFAULT_BUTTON: Anchor = { anchorX: 'right', anchorY: 'bottom', offsetX: 24, offsetY: 72 };

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Orca's `rt`: a panel rect kept on screen at no less than the minimum size. */
export function clampRect(r: Rect, vw: number, vh: number): Rect {
	const width = clamp(r.width, MIN_W, vw - 16);
	const height = clamp(r.height, MIN_H, vh - TITLEBAR - MARGIN);
	return { width, height, left: clamp(r.left, MARGIN, vw - width - MARGIN), top: clamp(r.top, TITLEBAR, vh - height - MARGIN) };
}

/** The panel's first rect: bottom right, 920×560 when it fits. */
export function defaultRect(vw: number, vh: number): Rect {
	const width = Math.min(920, Math.max(MIN_W, vw - 48));
	const height = Math.min(560, Math.max(MIN_H, vh - 96));
	return { width, height, left: Math.max(16, vw - width - 24), top: Math.max(TITLEBAR, vh - height - 84) };
}

/** Maximized: the whole window under the title bar, 12px gutters, the status bar left free. */
export const maximizedRect = (vw: number, vh: number): Rect => ({ left: 12, top: TITLEBAR, width: Math.max(MIN_W, vw - 24), height: Math.max(MIN_H, vh - 72) });

/** Stores a rect by the corner its centre is nearest to. */
export function anchorRect(r: Rect, vw: number, vh: number): AnchoredBounds {
	const right = r.left + r.width / 2 > vw / 2;
	const bottom = r.top + r.height / 2 > vh / 2;
	return {
		anchorX: right ? 'right' : 'left',
		anchorY: bottom ? 'bottom' : 'top',
		offsetX: right ? vw - r.left - r.width : r.left,
		offsetY: bottom ? vh - r.top - r.height : r.top,
		width: r.width,
		height: r.height
	};
}

export function rectFromAnchor(b: AnchoredBounds, vw: number, vh: number): Rect {
	const left = b.anchorX === 'right' ? vw - b.offsetX - b.width : b.offsetX;
	const top = b.anchorY === 'bottom' ? vh - b.offsetY - b.height : b.offsetY;
	return clampRect({ left, top, width: b.width, height: b.height }, vw, vh);
}

/** The toggle button's position, kept inside the window and under the title bar. */
export function buttonPos(a: Anchor, vw: number, vh: number): { left: number; top: number } {
	const left = a.anchorX === 'right' ? vw - BUTTON - a.offsetX : a.offsetX;
	const top = a.anchorY === 'bottom' ? vh - BUTTON - a.offsetY : a.offsetY;
	return { left: clamp(left, MARGIN, vw - BUTTON - MARGIN), top: clamp(top, TITLEBAR, vh - BUTTON - MARGIN) };
}

export function anchorButton(p: { left: number; top: number }, vw: number, vh: number): Anchor {
	const right = p.left + BUTTON / 2 > vw / 2;
	const bottom = p.top + BUTTON / 2 > vh / 2;
	return { anchorX: right ? 'right' : 'left', anchorY: bottom ? 'bottom' : 'top', offsetX: right ? vw - BUTTON - p.left : p.left, offsetY: bottom ? vh - BUTTON - p.top : p.top };
}

export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Resizing from `edge` by (dx, dy); the opposite edge stays put at the minimum size. */
export function resizeRect(r: Rect, edge: Edge, dx: number, dy: number): Rect {
	let { left, top, width, height } = r;
	if (edge.includes('e')) width = Math.max(MIN_W, r.width + dx);
	if (edge.includes('s')) height = Math.max(MIN_H, r.height + dy);
	if (edge.includes('w')) {
		width = Math.max(MIN_W, r.width - dx);
		left = r.left + r.width - width;
	}
	if (edge.includes('n')) {
		height = Math.max(MIN_H, r.height - dy);
		top = r.top + r.height - height;
	}
	return { left, top, width, height };
}

/** The URL a browser tab loads: a bare host is https, except this machine (dev servers are http). */
export function browserUrl(raw: string): string {
	const s = raw.trim();
	if (!s) return 'about:blank';
	if (/^about:/i.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
	return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s) ? `http://${s}` : `https://${s}`;
}

/** Whether a URL is the floating browser's own new-tab page (the app serves it). */
export function isNewTabPage(url: string): boolean {
	return url === '' || url === 'about:blank' || url.startsWith('kingu-newtab:');
}

/** A browser tab's title: the page's host, or New Tab while the page is blank. */
export function browserTitle(url: string): string {
	if (isNewTabPage(url)) return 'New Tab';
	try {
		return new URL(url).host || 'New Tab';
	} catch {
		return 'New Tab';
	}
}
