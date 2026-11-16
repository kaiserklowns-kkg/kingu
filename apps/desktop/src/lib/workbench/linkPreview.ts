// Link preview card helpers (LinkPreview.svelte): which links get a card and where it goes.

/** What Rust's link_preview_get returns (Orca's preview fields). */
export type Preview = {
	url: string;
	title: string | null;
	description: string | null;
	siteName: string | null;
	imageDataUrl: string | null;
	faviconDataUrl: string | null;
};

/** How long the pointer rests on a link before the card is asked for (Kingu's choice). */
export const HOVER_DELAY_MS = 600;
export const CARD_WIDTH = 320;
const CARD_HEIGHT = 260;
const GAP = 6;

/** The web link under the pointer: an `<a>` to http(s), not inside editable text or the card itself. */
export function linkTarget(target: EventTarget | null): HTMLAnchorElement | null {
	const el = target as Element | null;
	const a = el?.closest?.('a[href]') as HTMLAnchorElement | null;
	if (!a || a.closest('[data-link-preview], [contenteditable="true"], .monaco-editor')) return null;
	return /^https?:\/\//i.test(a.href) ? a : null;
}

/** Below the link, or above it when there is no room; kept inside the window. */
export function cardPlacement(link: { left: number; top: number; bottom: number }, view: { width: number; height: number }): { left: number; top: number } {
	const left = Math.max(GAP, Math.min(link.left, view.width - CARD_WIDTH - GAP));
	const below = link.bottom + GAP;
	const top = below + CARD_HEIGHT <= view.height ? below : Math.max(GAP, link.top - CARD_HEIGHT - GAP);
	return { left, top };
}
