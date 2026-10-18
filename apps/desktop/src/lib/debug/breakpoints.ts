// Source breakpoints per workspace-relative file (VS Code: IDebugModel breakpoints), kept in
// localStorage per folder. Pure, so the toggling and the adapter's verification are unit-tested.

import type { Breakpoint, SourceBreakpoint } from './protocol.ts';

export type BreakpointSpec = { line: number; condition?: string; enabled: boolean };
export type BreakpointMap = Record<string, BreakpointSpec[]>;
export type GlyphKind = 'breakpoint' | 'verified' | 'unverified' | 'disabled' | 'conditional';
export type Glyph = { line: number; kind: GlyphKind; hover: string };

const STORE = 'kingu.debug.breakpoints';
export const storageKey = (root: string) => `${STORE}:${root}`;

const byLine = (a: BreakpointSpec, b: BreakpointSpec) => a.line - b.line;

function put(map: BreakpointMap, rel: string, list: BreakpointSpec[]): BreakpointMap {
	const next = { ...map };
	if (list.length) next[rel] = [...list].sort(byLine);
	else delete next[rel];
	return next;
}

/** F9 / a glyph margin click: adds an enabled breakpoint, or removes the one on that line. */
export function toggle(map: BreakpointMap, rel: string, line: number): BreakpointMap {
	const list = map[rel] ?? [];
	return list.some((b) => b.line === line) ? put(map, rel, list.filter((b) => b.line !== line)) : put(map, rel, [...list, { line, enabled: true }]);
}

export function remove(map: BreakpointMap, rel: string, line: number): BreakpointMap {
	return put(map, rel, (map[rel] ?? []).filter((b) => b.line !== line));
}

export function setEnabled(map: BreakpointMap, rel: string, line: number, enabled: boolean): BreakpointMap {
	return put(map, rel, (map[rel] ?? []).map((b) => (b.line === line ? { ...b, enabled } : b)));
}

/** An empty condition makes it a plain breakpoint again; a missing one is added. */
export function setCondition(map: BreakpointMap, rel: string, line: number, condition: string): BreakpointMap {
	const list = map[rel] ?? [];
	const cond = condition.trim() || undefined;
	const has = list.some((b) => b.line === line);
	const next = has ? list.map((b) => (b.line === line ? { ...b, condition: cond } : b)) : [...list, { line, condition: cond, enabled: true }];
	return put(map, rel, next);
}

/** Edits moved breakpoints (Monaco decorations track them): `lines[i]` is the new line of the
 * i-th breakpoint in line order. Breakpoints that land on the same line merge. */
export function moveTo(map: BreakpointMap, rel: string, lines: number[]): BreakpointMap {
	const list = map[rel] ?? [];
	if (lines.length !== list.length || list.every((b, i) => b.line === lines[i])) return map;
	const seen = new Set<number>();
	const moved = list.map((b, i) => ({ ...b, line: lines[i] })).filter((b) => !seen.has(b.line) && (seen.add(b.line), true));
	return put(map, rel, moved);
}

/** What setBreakpoints sends for a file: the enabled ones, in line order. */
export function sourceBreakpoints(list: BreakpointSpec[] | undefined): SourceBreakpoint[] {
	return (list ?? []).filter((b) => b.enabled).sort(byLine).map((b) => (b.condition ? { line: b.line, condition: b.condition } : { line: b.line }));
}

/**
 * Glyph margin decorations. Without a session every breakpoint is plain; during one, the adapter's
 * answer (`verified`, in the order of [`sourceBreakpoints`]) marks each as verified or not.
 */
export function glyphs(list: BreakpointSpec[] | undefined, verified: Breakpoint[] | undefined): Glyph[] {
	const sorted = [...(list ?? [])].sort(byLine);
	let i = 0;
	return sorted.map((b) => {
		if (!b.enabled) return { line: b.line, kind: 'disabled', hover: 'Breakpoint (ปิดอยู่)' };
		const answer = verified?.[i++];
		const plain: GlyphKind = b.condition ? 'conditional' : 'breakpoint';
		const hover = b.condition ? `Breakpoint: ${b.condition}` : 'Breakpoint';
		if (!verified) return { line: b.line, kind: plain, hover };
		if (!answer || !answer.verified) return { line: b.line, kind: 'unverified', hover: answer?.message ?? 'Breakpoint ยังไม่ถูกยืนยันโดย debugger' };
		return { line: b.line, kind: b.condition ? 'conditional' : 'verified', hover };
	});
}

export function parseStored(text: string | null): BreakpointMap {
	if (!text) return {};
	try {
		const raw = JSON.parse(text);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
		const out: BreakpointMap = {};
		for (const [rel, list] of Object.entries(raw)) {
			if (!Array.isArray(list)) continue;
			const ok = list
				.filter((b) => b && Number.isInteger(b.line) && b.line > 0)
				.map((b) => ({ line: b.line, enabled: b.enabled !== false, ...(typeof b.condition === 'string' && b.condition ? { condition: b.condition } : {}) }));
			if (ok.length) out[rel] = ok.sort(byLine);
		}
		return out;
	} catch {
		return {};
	}
}

export function count(map: BreakpointMap): number {
	return Object.values(map).reduce((n, l) => n + l.length, 0);
}
