// Source breakpoints per workspace-relative file (VS Code: IDebugModel breakpoints), kept in
// localStorage per folder. Pure, so the toggling and the adapter's verification are unit-tested.

import type { Breakpoint, SourceBreakpoint } from './protocol.ts';

/**
 * `logMessage`: a logpoint (DAP: logs the message with `{expression}`s instead of stopping).
 * `triggeredBy`: a triggered breakpoint (`rel:line` of another breakpoint); like VS Code it is
 * sent to the debugger only once that breakpoint has been hit in the session.
 */
export type BreakpointSpec = { line: number; condition?: string; logMessage?: string; triggeredBy?: string; enabled: boolean };
export type BreakpointMap = Record<string, BreakpointSpec[]>;
export type GlyphKind = 'breakpoint' | 'verified' | 'unverified' | 'disabled' | 'conditional' | 'log' | 'triggered';
export type Glyph = { line: number; kind: GlyphKind; hover: string };

const STORE = 'kingu.debug.breakpoints';
export const storageKey = (root: string) => `${STORE}:${root}`;

const byLine = (a: BreakpointSpec, b: BreakpointSpec) => a.line - b.line;

/** The id a triggered breakpoint names its trigger by. */
export const breakpointKey = (rel: string, line: number) => `${rel}:${line}`;
/** Whether a breakpoint goes to the debugger: enabled, and its trigger (if any) was hit. */
export const isSent = (b: BreakpointSpec, triggered: ReadonlySet<string> = new Set()) => b.enabled && (!b.triggeredBy || triggered.has(b.triggeredBy));

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

/** A logpoint on the line (VS Code: Add Logpoint…); an empty message makes it a plain breakpoint again. */
export function setLogMessage(map: BreakpointMap, rel: string, line: number, message: string): BreakpointMap {
	const list = map[rel] ?? [];
	const log = message.trim() || undefined;
	const has = list.some((b) => b.line === line);
	const next = has ? list.map((b) => (b.line === line ? { ...b, logMessage: log } : b)) : [...list, { line, logMessage: log, enabled: true }];
	return put(map, rel, next);
}

/** A triggered breakpoint on the line, waiting for `trigger` (a `breakpointKey`); null makes it plain again. */
export function setTriggeredBy(map: BreakpointMap, rel: string, line: number, trigger: string | null): BreakpointMap {
	const list = map[rel] ?? [];
	const by = trigger ?? undefined;
	const has = list.some((b) => b.line === line);
	const next = has ? list.map((b) => (b.line === line ? { ...b, triggeredBy: by } : b)) : [...list, { line, triggeredBy: by, enabled: true }];
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
export function sourceBreakpoints(list: BreakpointSpec[] | undefined, triggered?: ReadonlySet<string>): SourceBreakpoint[] {
	return (list ?? [])
		.filter((b) => isSent(b, triggered))
		.sort(byLine)
		.map((b) => ({ line: b.line, ...(b.condition ? { condition: b.condition } : {}), ...(b.logMessage ? { logMessage: b.logMessage } : {}) }));
}

/**
 * Glyph margin decorations. Without a session every breakpoint is plain; during one, the adapter's
 * answer (`verified`, in the order of [`sourceBreakpoints`]) marks each as verified or not.
 */
export function glyphs(list: BreakpointSpec[] | undefined, verified: Breakpoint[] | undefined, triggered?: ReadonlySet<string>): Glyph[] {
	const sorted = [...(list ?? [])].sort(byLine);
	let i = 0;
	return sorted.map((b) => {
		if (!b.enabled) return { line: b.line, kind: 'disabled', hover: 'Breakpoint (ปิดอยู่)' };
		if (!isSent(b, triggered)) return { line: b.line, kind: 'triggered', hover: `Triggered breakpoint: ทำงานหลังหยุดที่ ${b.triggeredBy}` };
		const answer = verified?.[i++];
		const plain: GlyphKind = b.logMessage ? 'log' : b.condition ? 'conditional' : 'breakpoint';
		const hover = b.logMessage ? `Logpoint: ${b.logMessage}` : b.condition ? `Breakpoint: ${b.condition}` : 'Breakpoint';
		if (!verified) return { line: b.line, kind: plain, hover };
		if (!answer || !answer.verified) return { line: b.line, kind: 'unverified', hover: answer?.message ?? 'Breakpoint ยังไม่ถูกยืนยันโดย debugger' };
		return { line: b.line, kind: b.logMessage ? 'log' : b.condition ? 'conditional' : 'verified', hover };
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
				.map((b) => ({
					line: b.line,
					enabled: b.enabled !== false,
					...(typeof b.condition === 'string' && b.condition ? { condition: b.condition } : {}),
					...(typeof b.logMessage === 'string' && b.logMessage ? { logMessage: b.logMessage } : {}),
					...(typeof b.triggeredBy === 'string' && b.triggeredBy ? { triggeredBy: b.triggeredBy } : {})
				}));
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
