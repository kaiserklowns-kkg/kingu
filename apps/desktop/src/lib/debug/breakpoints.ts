// Breakpoints (VS Code: IDebugModel breakpoints): source breakpoints per workspace-relative file,
// function breakpoints, exception breakpoint filters and data breakpoints, kept in localStorage
// per folder. Pure, so the toggling, what is sent to the adapter and how the adapter's answer and
// capabilities show are unit-tested.

import type { Breakpoint, Capabilities, DataAccessType, DataBreakpoint, ExceptionFilter, FunctionBreakpoint, SourceBreakpoint } from './protocol.ts';
import { t } from '#lib/i18n/index.ts';

/**
 * `logMessage`: a logpoint (DAP: logs the message with `{expression}`s instead of stopping).
 * `hitCondition`: stop only when the hit count matches (`5`, `>= 3`, `% 2`, as the adapter reads it).
 * `triggeredBy`: a triggered breakpoint (`rel:line` of another breakpoint); like VS Code it is
 * sent to the debugger only once that breakpoint has been hit in the session.
 * `column`: an inline breakpoint (VS Code: Shift+F9), at a column of the line; several can share a line.
 */
export type BreakpointSpec = { line: number; column?: number; condition?: string; hitCondition?: string; logMessage?: string; triggeredBy?: string; enabled: boolean };
export type BreakpointMap = Record<string, BreakpointSpec[]>;
export type GlyphKind = 'breakpoint' | 'verified' | 'unverified' | 'disabled' | 'conditional' | 'log' | 'triggered' | 'unsupported';
export type Glyph = { line: number; column?: number; kind: GlyphKind; hover: string };

const STORE = 'kingu.debug.breakpoints';
export const storageKey = (root: string) => `${STORE}:${root}`;

const byLine = (a: BreakpointSpec, b: BreakpointSpec) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0);
/** Whether a breakpoint is the one at `line` and `column` (no column: the line's whole-line breakpoint). */
const at = (b: BreakpointSpec, line: number, column?: number) => b.line === line && (b.column ?? 0) === (column ?? 0);

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

/** Shift+F9 (VS Code: Toggle Inline Breakpoint): a breakpoint at the column, or the one there removed. */
export function toggleInline(map: BreakpointMap, rel: string, line: number, column: number): BreakpointMap {
	const list = map[rel] ?? [];
	const col = column > 1 ? column : undefined;
	return list.some((b) => at(b, line, col)) ? put(map, rel, list.filter((b) => !at(b, line, col))) : put(map, rel, [...list, { line, ...(col ? { column: col } : {}), enabled: true }]);
}

/** Whether a line has inline (column) breakpoints. */
export const hasInline = (list: readonly BreakpointSpec[] | undefined, line: number) => !!list?.some((b) => b.line === line && b.column);

export function remove(map: BreakpointMap, rel: string, line: number): BreakpointMap {
	return put(map, rel, (map[rel] ?? []).filter((b) => b.line !== line));
}

export function setEnabled(map: BreakpointMap, rel: string, line: number, enabled: boolean): BreakpointMap {
	return put(map, rel, (map[rel] ?? []).map((b) => (b.line === line ? { ...b, enabled } : b)));
}

/** Enable All Breakpoints / Disable All Breakpoints (source ones; the caller does the others). */
export function setAllEnabled(map: BreakpointMap, enabled: boolean): BreakpointMap {
	const next: BreakpointMap = {};
	for (const [rel, list] of Object.entries(map)) next[rel] = list.map((b) => (b.enabled === enabled ? b : { ...b, enabled }));
	return next;
}

/** Sets one optional field of the breakpoint on `line` (adding the breakpoint when there is none). */
function setField(map: BreakpointMap, rel: string, line: number, field: 'condition' | 'hitCondition' | 'logMessage' | 'triggeredBy', value: string | undefined): BreakpointMap {
	const list = map[rel] ?? [];
	const has = list.some((b) => b.line === line);
	const apply = (b: BreakpointSpec): BreakpointSpec => {
		const next = { ...b };
		if (value === undefined) delete next[field];
		else next[field] = value;
		return next;
	};
	return put(map, rel, has ? list.map((b) => (b.line === line ? apply(b) : b)) : [...list, apply({ line, enabled: true })]);
}

/** An empty condition makes it a plain breakpoint again; a missing one is added. */
export function setCondition(map: BreakpointMap, rel: string, line: number, condition: string): BreakpointMap {
	return setField(map, rel, line, 'condition', condition.trim() || undefined);
}

/** A hit count condition (VS Code's breakpoint widget, Hit Count); empty removes it. */
export function setHitCondition(map: BreakpointMap, rel: string, line: number, hitCondition: string): BreakpointMap {
	return setField(map, rel, line, 'hitCondition', hitCondition.trim() || undefined);
}

/** A logpoint on the line (VS Code: Add Logpoint…); an empty message makes it a plain breakpoint again. */
export function setLogMessage(map: BreakpointMap, rel: string, line: number, message: string): BreakpointMap {
	return setField(map, rel, line, 'logMessage', message.trim() || undefined);
}

/** A triggered breakpoint on the line, waiting for `trigger` (a `breakpointKey`); null makes it plain again. */
export function setTriggeredBy(map: BreakpointMap, rel: string, line: number, trigger: string | null): BreakpointMap {
	return setField(map, rel, line, 'triggeredBy', trigger ?? undefined);
}

/** Edits moved breakpoints (Monaco decorations track them): `lines[i]` is the new line of the
 * i-th breakpoint in line order. Breakpoints that land on the same line merge. */
export function moveTo(map: BreakpointMap, rel: string, lines: number[]): BreakpointMap {
	const list = map[rel] ?? [];
	if (lines.length !== list.length || list.every((b, i) => b.line === lines[i])) return map;
	const seen = new Set<string>();
	const moved = list.map((b, i) => ({ ...b, line: lines[i] })).filter((b) => !seen.has(`${b.line}:${b.column ?? 0}`) && (seen.add(`${b.line}:${b.column ?? 0}`), true));
	return put(map, rel, moved);
}

/** What setBreakpoints sends for a file: the enabled ones, in line order (none while breakpoints
 * are deactivated, VS Code's Toggle Activate Breakpoints). */
export function sourceBreakpoints(list: BreakpointSpec[] | undefined, triggered?: ReadonlySet<string>, activated = true): SourceBreakpoint[] {
	if (!activated) return [];
	return (list ?? [])
		.filter((b) => isSent(b, triggered))
		.sort(byLine)
		.map((b) => ({
			line: b.line,
			...(b.column ? { column: b.column } : {}),
			...(b.condition ? { condition: b.condition } : {}),
			...(b.hitCondition ? { hitCondition: b.hitCondition } : {}),
			...(b.logMessage ? { logMessage: b.logMessage } : {})
		}));
}

/** VS Code's Breakpoint.supported: false when the adapter lacks a capability the breakpoint uses. */
export function isSupported(b: Pick<BreakpointSpec, 'condition' | 'hitCondition' | 'logMessage'>, caps: Capabilities): boolean {
	if (b.logMessage && !caps.supportsLogPoints) return false;
	if (b.condition && !caps.supportsConditionalBreakpoints) return false;
	if (b.hitCondition && !caps.supportsHitConditionalBreakpoints) return false;
	return true;
}

/** VS Code's getBreakpointMessageAndIcon text for a breakpoint with a condition, hit count or log message. */
export function breakpointMessage(b: Pick<BreakpointSpec, 'condition' | 'hitCondition' | 'logMessage' | 'triggeredBy'>): string | null {
	const lines: string[] = [];
	if (b.logMessage) lines.push(t('debugger.bp.logMessage', { message: b.logMessage }));
	if (b.condition) lines.push(t('debugger.bp.condition', { condition: b.condition }));
	if (b.hitCondition) lines.push(t('debugger.bp.hitCount', { hits: b.hitCondition }));
	if (b.triggeredBy) lines.push(t('debugger.bp.triggeredBy', { at: b.triggeredBy }));
	return lines.length ? lines.join('\n') : null;
}

/**
 * Glyph margin decorations. Without a session every breakpoint is plain; during one, the adapter's
 * answer (`verified`, in the order of [`sourceBreakpoints`]) marks each as verified or not, and
 * `caps` marks the ones using a feature the adapter does not have.
 */
export function glyphs(list: BreakpointSpec[] | undefined, verified: Breakpoint[] | undefined, triggered?: ReadonlySet<string>, caps?: Capabilities, activated = true): Glyph[] {
	const sorted = [...(list ?? [])].sort(byLine);
	let i = 0;
	return sorted.map((b) => {
		const column = b.column ? { column: b.column } : {};
		if (!b.enabled || !activated) return { line: b.line, ...column, kind: 'disabled', hover: b.logMessage ? t('debugger.bp.disabledLogpoint') : t('tools.debug.bp.disabled') };
		if (!isSent(b, triggered)) return { line: b.line, ...column, kind: 'triggered', hover: t('tools.debug.bp.triggered', { at: b.triggeredBy ?? '' }) };
		const answer = verified?.[i++];
		const message = breakpointMessage(b);
		const plain: GlyphKind = b.logMessage ? 'log' : b.condition || b.hitCondition ? 'conditional' : 'breakpoint';
		const hover = message ?? t('debugger.bp.breakpoint');
		if (!verified) return { line: b.line, ...column, kind: plain, hover };
		if (!answer || !answer.verified)
			return { line: b.line, ...column, kind: 'unverified', hover: answer?.message ?? (b.logMessage ? t('debugger.bp.unverifiedLogpoint') : t('tools.debug.bp.unverified')) };
		if (caps && !isSupported(b, caps)) return { line: b.line, ...column, kind: 'unsupported', hover: `${t('debugger.bp.unsupported')}\n${hover}` };
		const withAnswer = answer.message ? `${hover}, ${answer.message}` : hover;
		return { line: b.line, ...column, kind: plain === 'breakpoint' ? 'verified' : plain, hover: withAnswer };
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
			const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
			const ok = list
				.filter((b) => b && Number.isInteger(b.line) && b.line > 0)
				.map((b) => {
					const spec: BreakpointSpec = { line: b.line, ...(Number.isInteger(b.column) && b.column > 1 ? { column: b.column } : {}), enabled: b.enabled !== false };
					for (const k of ['condition', 'hitCondition', 'logMessage', 'triggeredBy'] as const) {
						const v = str(b[k]);
						if (v) spec[k] = v;
					}
					return spec;
				});
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

// --- Function breakpoints (VS Code: Add Function Breakpoint) ------------------------------------

export type FunctionBreakpointSpec = { name: string; condition?: string; hitCondition?: string; enabled: boolean };

export function addFunctionBreakpoint(list: readonly FunctionBreakpointSpec[], name: string): FunctionBreakpointSpec[] {
	const n = name.trim();
	if (!n || list.some((f) => f.name === n)) return [...list];
	return [...list, { name: n, enabled: true }];
}

/** What setFunctionBreakpoints sends (enabled ones; none while deactivated). */
export function functionBreakpoints(list: readonly FunctionBreakpointSpec[], activated = true): FunctionBreakpoint[] {
	if (!activated) return [];
	return list
		.filter((f) => f.enabled)
		.map((f) => ({ name: f.name, ...(f.condition ? { condition: f.condition } : {}), ...(f.hitCondition ? { hitCondition: f.hitCondition } : {}) }));
}

export function parseFunctionBreakpoints(text: string | null): FunctionBreakpointSpec[] {
	try {
		const raw = text ? JSON.parse(text) : [];
		if (!Array.isArray(raw)) return [];
		return raw
			.filter((f) => f && typeof f.name === 'string' && f.name)
			.map((f) => ({
				name: f.name,
				enabled: f.enabled !== false,
				...(typeof f.condition === 'string' && f.condition ? { condition: f.condition } : {}),
				...(typeof f.hitCondition === 'string' && f.hitCondition ? { hitCondition: f.hitCondition } : {})
			}));
	} catch {
		return [];
	}
}

// --- Exception breakpoints (VS Code: the filters in the Breakpoints view) ----------------------

/** Per filter id: checked, and its condition when the filter supports one. */
export type ExceptionState = Record<string, { enabled: boolean; condition?: string }>;
/** The filters last offered (shown before a session starts, like VS Code) and their state. */
export type ExceptionSettings = { filters: ExceptionFilter[]; state: ExceptionState };

/** The Breakpoints view's exception rows: each filter, checked by the user's choice or its default. */
export function exceptionRows(filters: readonly ExceptionFilter[], state: ExceptionState): { filter: ExceptionFilter; enabled: boolean; condition?: string }[] {
	return filters.map((f) => ({ filter: f, enabled: state[f.filter]?.enabled ?? !!f.default, condition: state[f.filter]?.condition }));
}

/** setExceptionBreakpoints arguments: `filterOptions` (with conditions) when the adapter takes them. */
export function exceptionArgs(filters: readonly ExceptionFilter[], state: ExceptionState, caps: Capabilities): { filters: string[]; filterOptions?: { filterId: string; condition?: string }[] } {
	const on = exceptionRows(filters, state).filter((r) => r.enabled);
	if (caps.supportsExceptionFilterOptions)
		return { filters: [], filterOptions: on.map((r) => ({ filterId: r.filter.filter, ...(r.condition && r.filter.supportsCondition ? { condition: r.condition } : {}) })) };
	return { filters: on.map((r) => r.filter.filter) };
}

export function setException(state: ExceptionState, filter: string, enabled: boolean, condition?: string): ExceptionState {
	const prev = state[filter];
	const cond = condition === undefined ? prev?.condition : condition.trim() || undefined;
	return { ...state, [filter]: { enabled, ...(cond ? { condition: cond } : {}) } };
}

export function parseExceptionSettings(text: string | null): ExceptionSettings {
	try {
		const raw = text ? JSON.parse(text) : {};
		const filters = Array.isArray(raw?.filters) ? raw.filters.filter((f: ExceptionFilter) => f && typeof f.filter === 'string' && typeof f.label === 'string') : [];
		const state: ExceptionState = {};
		if (raw?.state && typeof raw.state === 'object')
			for (const [k, v] of Object.entries(raw.state as Record<string, { enabled?: unknown; condition?: unknown }>))
				if (v && typeof v.enabled === 'boolean') state[k] = { enabled: v.enabled, ...(typeof v.condition === 'string' && v.condition ? { condition: v.condition } : {}) };
		return { filters, state };
	} catch {
		return { filters: [], state: {} };
	}
}

// --- Data breakpoints (VS Code: Break on Value Change / Read / Access) ---------------------------

export type DataBreakpointSpec = { dataId: string; description: string; accessType: DataAccessType; enabled: boolean; canPersist: boolean };

export const dataBreakpoints = (list: readonly DataBreakpointSpec[], activated = true): DataBreakpoint[] =>
	activated ? list.filter((d) => d.enabled).map((d) => ({ dataId: d.dataId, accessType: d.accessType })) : [];

/** At the end of a session, the data breakpoints the adapter said cannot outlive it go (VS Code). */
export const persistentData = (list: readonly DataBreakpointSpec[]) => list.filter((d) => d.canPersist);
