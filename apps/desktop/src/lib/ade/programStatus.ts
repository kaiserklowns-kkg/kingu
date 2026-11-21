// Program Status Protocol (OSC 7501): a program in a terminal reports idle/working/blocked/done/error
// and a 0-100 progress for itself, and the terminal's tab draws it (Orca's progress ring). Pure; the
// per-pane store is paneProgram.svelte.ts and the xterm wiring is terminal/Terminal.svelte.
//
// Ported from Orca's source:
// - wire grammar, limits, validation: shared/program-status/protocol.ts
// - one terminal's record and when it goes (root `clear`, a new prompt, RIS): shared/program-status/records.ts
// - display-safe message: shared/program-status/facet.ts
// - what a tab shows, and progress only while both the row and the report are live:
//   shared/program-status/presentation.ts, renderer/src/components/AgentStateDot.tsx
// - a finished result stays until the user types: renderer/src/lib/program-status/result-retention.ts
//
// The body is untrusted: whatever runs in the terminal (or a file it prints) wrote it.

import { t } from '#lib/i18n/index.ts';

export const PROGRAM_STATUS_OSC = 7501;

const STATES = ['idle', 'working', 'done', 'blocked', 'error'] as const;
export type ProgramState = (typeof STATES)[number];
const KINDS = ['permission', 'question', 'auth'] as const;
export type ProgramKind = (typeof KINDS)[number];

/** The spec caps the whole sequence at 4096 bytes; `ESC ] 7501 ;` and `ESC \` take 9 of them. */
export const MAX_BODY_BYTES = 4087;
const MAX_KEY_BYTES = 16;
const MAX_MSG_ENCODED = 2732;
const MAX_MSG_DECODED = 2048;
const MAX_TITLE_ENCODED = 256;
const MAX_TITLE_DECODED = 192;
const MAX_ID_LENGTH = 128;
const MAX_ID_DEPTH = 8;
const MAX_APP_BYTES = 32;
/** Longest message a tab's tooltip shows. */
const MAX_DISPLAY_LENGTH = 400;

export type ProgramReport = {
	/** Null addresses the root record (the program itself). */
	id: string | null;
	state: ProgramState | 'clear';
	kind?: ProgramKind;
	progress?: number;
	app?: string;
	title?: string;
	msg?: string;
};

export type ProgramMessage = { type: 'query' } | { type: 'report'; report: ProgramReport };

const KEY_RE = /^[a-z]+$/;
const VALUE_RE = /^[A-Za-z0-9_.,+/=-]*$/;
const SEGMENT_RE = /^[A-Za-z0-9_.+-]{1,32}$/;
const APP_RE = /^[A-Za-z0-9_.+-]+$/;
const PROGRESS_RE = /^0*(\d{1,3})$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// The spec refuses decoded C0/DEL/C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
// Bidi and invisible formatting could disguise a claim outside the terminal grid.
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁩﻿]/g;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** `text` is at most `max` UTF-8 bytes, without encoding a string that cannot fit. */
function withinBytes(text: string, max: number): boolean {
	if (text.length > max) return false;
	if (text.length * 3 <= max) return true;
	return encoder.encode(text).length <= max;
}

const isState = (v: unknown): v is ProgramState => STATES.some((s) => s === v);
const isKind = (v: unknown): v is ProgramKind => KINDS.some((k) => k === v);
/** Live states: the only ones whose reports may carry `progress`. */
export const carriesProgress = (state: ProgramState | 'clear') => state === 'working' || state === 'blocked';
/** done/error outlive the program that reported them, so the user still finds the result. */
export const outlivesProgram = (state: ProgramState) => state === 'done' || state === 'error';

function validId(id: string): boolean {
	if (id.length > MAX_ID_LENGTH) return false;
	const segments = id.split('/');
	return segments.length <= MAX_ID_DEPTH && segments.every((s) => SEGMENT_RE.test(s));
}

/** Decoded single-line text, or null when the report must be discarded whole. */
function decodeText(encoded: string, maxDecoded: number): string | null {
	if (!BASE64_RE.test(encoded)) return null;
	const unpadded = encoded.replace(/=+$/, '');
	if (unpadded.length % 4 === 1) return null;
	let binary: string;
	try {
		binary = atob(unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4));
	} catch {
		return null;
	}
	if (binary.length > maxDecoded) return null;
	let text: string;
	try {
		text = decoder.decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
	} catch {
		return null;
	}
	return CONTROL_RE.test(text) ? null : text;
}

/**
 * The body between `OSC 7501 ;` and its terminator: `key=value` pairs joined by `:`
 * (`state=working:progress=40:msg=<base64>`), or `?` for a capability query. Null means ignore:
 * no state, a bad id, or anything over a limit.
 */
export function parseProgramStatus(body: string): ProgramMessage | null {
	if (!withinBytes(body, MAX_BODY_BYTES)) return null;
	if (body.trim() === '?') return { type: 'query' };
	const pairs = new Map<string, string>();
	const texts: { msg?: string; title?: string } = {};
	for (const pair of body.split(':')) {
		const eq = pair.indexOf('=');
		if (eq === -1) continue;
		const key = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		// Per occurrence, before the grammar skip: a broken cap voids the report even if a duplicate
		// follows. The encoded caps also bound the decoding work.
		if (
			!withinBytes(key, MAX_KEY_BYTES) ||
			(key === 'app' && !withinBytes(value, MAX_APP_BYTES)) ||
			(key === 'msg' && !withinBytes(value, MAX_MSG_ENCODED)) ||
			(key === 'title' && !withinBytes(value, MAX_TITLE_ENCODED)) ||
			(key === 'id' && !validId(value))
		)
			return null;
		// A malformed pair is skipped; the rest of the report still applies.
		if (!KEY_RE.test(key) || !VALUE_RE.test(value)) continue;
		if (key === 'msg' || key === 'title') {
			const text = decodeText(value, key === 'msg' ? MAX_MSG_DECODED : MAX_TITLE_DECODED);
			if (text === null) return null;
			texts[key] = text;
			continue;
		}
		pairs.set(key, value);
	}
	const state = pairs.get('state');
	if (state === undefined || (state !== 'clear' && !isState(state))) return null;
	const report: ProgramReport = { id: pairs.get('id') ?? null, state };
	const kind = pairs.get('kind');
	if (state === 'blocked' && isKind(kind)) report.kind = kind;
	const digits = PROGRESS_RE.exec(pairs.get('progress') ?? '')?.[1];
	if (carriesProgress(state) && digits !== undefined) {
		const value = Number.parseInt(digits, 10);
		if (value <= 100) report.progress = value;
	}
	const app = pairs.get('app');
	if (app !== undefined && APP_RE.test(app)) report.app = app;
	if (texts.msg) report.msg = texts.msg;
	if (texts.title) report.title = texts.title;
	return { type: 'report', report };
}

/** A program-supplied string made safe and bounded for display, or undefined when empty. */
export function displayText(text: string | undefined): string | undefined {
	const cleaned = text?.replace(INVISIBLE_RE, '').trim();
	if (!cleaned) return undefined;
	return cleaned.length > MAX_DISPLAY_LENGTH ? `${cleaned.slice(0, MAX_DISPLAY_LENGTH - 1)}…` : cleaned;
}

/** What one terminal pane's program last said about itself (its root record). Live only, never saved. */
export type ProgramFacet = {
	state: ProgramState;
	/** Only on `blocked`: what the program waits for. */
	kind?: ProgramKind;
	/** 0-100, only on `working`/`blocked`. Absent means indeterminate. */
	progress?: number;
	message?: string;
	/** The program's `app` name, when it gave one. */
	app?: string;
	/** When the latest report was read (Unix ms). */
	observedAt: number;
};

/** What happens to a pane's record, in stream order. */
export type ProgramEvent =
	| { type: 'report'; report: ProgramReport }
	/** A new shell prompt (OSC 133;A / 633;A): the program ended. */
	| { type: 'end' }
	/** A full terminal reset (RIS, `ESC c`). */
	| { type: 'reset' }
	/** The user typed into the terminal. */
	| { type: 'input' };

/** A repeated report refreshes `observedAt` at most this often, so redraw loops do not churn the UI. */
const REFRESH_MS = 5000;

/**
 * The pane's record after `event`. Each report replaces the record whole; a root `clear` or a reset
 * removes it; a new prompt removes all but a finished result; typing dismisses that result.
 * Reports for ids beneath the root (a program's sub-tasks) leave it alone (`reduceChildren`).
 */
export function reduceProgram(prev: ProgramFacet | undefined, event: ProgramEvent, now: number): ProgramFacet | undefined {
	switch (event.type) {
		case 'reset':
			return undefined;
		case 'end':
			return prev && outlivesProgram(prev.state) ? prev : undefined;
		case 'input':
			return prev && outlivesProgram(prev.state) ? undefined : prev;
		case 'report': {
			const r = event.report;
			if (r.id !== null) return prev;
			if (r.state === 'clear') return undefined;
			const message = displayText(r.msg);
			const next: ProgramFacet = { state: r.state, observedAt: now };
			if (r.kind !== undefined) next.kind = r.kind;
			if (r.progress !== undefined) next.progress = r.progress;
			if (message !== undefined) next.message = message;
			if (r.app !== undefined) next.app = r.app;
			const same = prev && prev.state === next.state && prev.kind === next.kind && prev.progress === next.progress && prev.message === next.message && prev.app === next.app;
			return same && now - prev.observedAt < REFRESH_MS ? prev : next;
		}
	}
}

/** A program's live sub-task (a report for an id beneath the root, Orca's subagent row). */
export type ProgramChild = { id: string; state: 'working' | 'blocked' | 'idle'; kind?: ProgramKind; label?: string; app?: string };

/** Orca's record cap is 256 for every id; a tab only needs the live children, newest kept. */
const MAX_CHILDREN = 64;

/**
 * A pane's live sub-tasks after `event` (Orca records.ts + `subagentState`): a child report
 * replaces that child (done / error end it: a finished child is not a live row); clearing an id
 * clears it and everything beneath it; a root `clear`, a reset or a new prompt ends them all.
 */
export function reduceChildren(prev: readonly ProgramChild[], event: ProgramEvent): readonly ProgramChild[] {
	switch (event.type) {
		case 'reset':
		case 'end':
			return prev.length ? [] : prev;
		case 'input':
			return prev;
		case 'report': {
			const r = event.report;
			if (r.id === null) return r.state === 'clear' && prev.length ? [] : prev;
			const id = r.id;
			const beneath = (c: ProgramChild) => c.id === id || c.id.startsWith(`${id}/`);
			if (r.state === 'clear') return prev.some(beneath) ? prev.filter((c) => !beneath(c)) : prev;
			const rest = prev.filter((c) => c.id !== id);
			if (r.state === 'done' || r.state === 'error') return rest.length === prev.length ? prev : rest;
			const label = displayText(r.title) ?? displayText(r.msg);
			const child: ProgramChild = { id, state: r.state };
			if (r.kind !== undefined) child.kind = r.kind;
			if (label !== undefined) child.label = label;
			if (r.app !== undefined) child.app = r.app;
			return [...rest, child].slice(-MAX_CHILDREN);
		}
	}
}

/**
 * Orca's held turn (`foldMainAgentWithRowChildWork`): a program whose own record is done, idle or
 * gone while sub-tasks still work or wait is still working (async subagents outlive the turn).
 * OpenCode keys its records by peer sessions, not children, so its sub-records are ignored.
 */
export function withChildren(i: ProgramIndicator | null, f: ProgramFacet | undefined, children: readonly ProgramChild[], now: number): ProgramIndicator | null {
	if (f?.app === 'opencode') return i;
	const live = children.filter((c) => c.state !== 'idle');
	if (!live.length || (i && i.status !== 'done')) return i && live.length ? { ...i, children: live } : i;
	if (f && now - f.observedAt > PROGRAM_STALE_AFTER_MS) return i;
	return { status: live.some((c) => c.state === 'blocked') ? 'permission' : 'working', children: live };
}

/** Orca's AGENT_STATUS_STALE_AFTER_MS: a live report nothing refreshed for this long is not trusted. */
export const PROGRAM_STALE_AFTER_MS = 30 * 60_000;

/** Bytes xterm sends without anyone typing: focus reports, button-less mouse motion, replies to queries. */
// eslint-disable-next-line no-control-regex
const PASSIVE_INPUT_RE = /^(?:\x1b\[[IO]|\x1b\[<(?:3[5-9]|[4-6]\d);\d+;\d+[Mm]|\x1b\[[?>]?[\d;]*(?:[Rcn]|\$y)|\x1b[\]P][^\x07\x1b]*(?:\x07|\x1b\\))+$/;
export const isPassiveInput = (data: string) => PASSIVE_INPUT_RE.test(data);

/** The state glyph a tab draws; `progress` set means a ring filled that far instead of the glyph. */
export type ProgramIndicator = {
	status: 'working' | 'permission' | 'done' | 'failed';
	progress?: number;
	kind?: ProgramKind;
	message?: string;
	/** Sub-tasks still working or waiting (Orca's subagent rows). */
	children?: readonly ProgramChild[];
};

/**
 * What a pane without an agent shows for its program. A live report (working, blocked) is dropped
 * when the shell is back in front (`atPrompt`: the program exited without a prompt mark) or when it
 * went stale; done/error stay as a result; idle shows nothing.
 */
export function programIndicator(f: ProgramFacet | undefined, now: number, atPrompt = false): ProgramIndicator | null {
	if (!f) return null;
	const rest = f.message !== undefined ? { message: f.message } : {};
	if (f.state === 'done') return { status: 'done', ...rest };
	if (f.state === 'error') return { status: 'failed', ...rest };
	if (f.state === 'idle' || atPrompt || now - f.observedAt > PROGRAM_STALE_AFTER_MS) return null;
	return {
		status: f.state === 'working' ? 'working' : 'permission',
		...(f.progress !== undefined ? { progress: f.progress } : {}),
		...(f.kind !== undefined ? { kind: f.kind } : {}),
		...rest
	};
}

/**
 * The percentage an agent's own state glyph becomes a ring for: only while the agent row is live
 * (working, or waiting for you) and its program's report is live too, so a finished row never shows
 * a leftover percentage.
 */
export function agentRingProgress(rowState: 'working' | 'permission' | 'question' | 'idle', f: ProgramFacet | undefined, now: number): number | undefined {
	if (!f || rowState === 'idle' || !carriesProgress(f.state) || now - f.observedAt > PROGRAM_STALE_AFTER_MS) return undefined;
	return f.progress;
}

/** A 1% arc on a small ring is invisible, which reads as "no progress shown". */
const MIN_VISIBLE_PERCENT = 8;
export const clampPercent = (percent: number) => Math.min(100, Math.max(0, Math.round(percent)));
/** The arc length (of 100) the ring draws for `percent`. */
export function ringArc(percent: number): number {
	const p = clampPercent(percent);
	return p === 0 ? 0 : Math.max(MIN_VISIBLE_PERCENT, p);
}
/** A state's label with the percentage, as the ring announces it: "Working · 40%". */
export const withPercent = (label: string, progress: number | undefined) => (progress === undefined ? label : `${label} · ${clampPercent(progress)}%`);

const BLOCKED_KEY = { permission: 'ade.program.permission', question: 'ade.program.question', auth: 'ade.program.auth' } as const;

/** The tooltip and accessible name of a program's indicator: "Working · 40%: Compiling". */
export function programLabel(i: ProgramIndicator): string {
	const base =
		i.status === 'working' ? t('ade.program.working') : i.status === 'done' ? t('ade.program.done') : i.status === 'failed' ? t('ade.program.failed') : t(i.kind ? BLOCKED_KEY[i.kind] : 'ade.program.blocked');
	const label = withPercent(base, i.progress);
	const head = i.message ? `${label}: ${i.message}` : label;
	if (!i.children?.length) return head;
	const lines = i.children.slice(-5).map((c) => `• ${c.label ?? c.app ?? c.id}${c.state === 'blocked' ? ` (${t(c.kind ? BLOCKED_KEY[c.kind] : 'ade.program.blocked')})` : ''}`);
	return [head, t('ade.program.subtasks', { count: i.children.length }), ...lines].join('\n');
}
