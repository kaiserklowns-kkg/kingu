// The context window gauge in the chat input (VS Code's chatContextUsageWidget, Cursor's
// contextUsagePercent): how full the window was after the last turn, from the host's
// `context_usage` event. Pure, for `bun test`.

import type { ContextUsage } from './events';

/** From here the ring turns to a warning and the popover suggests compacting. */
export const WARN_AT = 80;
export const FULL_AT = 95;

/** 0–100, rounded; 0 for an unknown window. */
export function contextPercent(u: ContextUsage | null | undefined): number {
	if (!u || u.max <= 0) return 0;
	return Math.min(100, Math.max(0, Math.round((u.used / u.max) * 100)));
}

export type ContextLevel = 'ok' | 'warn' | 'full';

export const contextLevel = (percent: number): ContextLevel => (percent >= FULL_AT ? 'full' : percent >= WARN_AT ? 'warn' : 'ok');

/** 950 · 12.3k · 200k · 1M */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${+(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
	return String(Math.round(n));
}

/** The ring's arc: `stroke-dasharray` for a circle of radius `r` filled to `percent`. */
export function ringDash(percent: number, r: number): string {
	const c = 2 * Math.PI * r;
	const filled = (Math.min(100, Math.max(0, percent)) / 100) * c;
	return `${filled.toFixed(2)} ${c.toFixed(2)}`;
}
