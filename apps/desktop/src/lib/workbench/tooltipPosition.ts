// Where a tooltip goes: below its anchor, or above when it would leave the window; kept inside horizontally.

export type Box = { left: number; top: number; right: number; bottom: number };

export function tooltipPosition(anchor: Box, tip: { width: number; height: number }, vw: number, vh: number, gap = 6): { x: number; y: number; above: boolean } {
	const above = anchor.bottom + gap + tip.height > vh - 4 && anchor.top - gap - tip.height >= 4;
	const center = (anchor.left + anchor.right) / 2;
	const x = Math.round(Math.min(Math.max(center - tip.width / 2, 4), vw - tip.width - 4));
	const y = Math.round(above ? anchor.top - gap - tip.height : anchor.bottom + gap);
	return { x, y, above };
}
