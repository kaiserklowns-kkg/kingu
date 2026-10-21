// The app's side of a snap view's bridge (src-tauri/src/snap_view.rs injects `window.kingu` into
// the page): the page posts `{ kinguSnapView: 1, id, method, params }` from its sandboxed frame and
// gets `{ kinguSnapView: 1, id, result }` or `{ …, error }` back. A view may only do what its
// manifest entry lists: read the snap settings it names, run the snap tasks it names, show
// notifications when it says so (rate-limited, so a page cannot flood the user), and ask for its
// context. Everything else is refused. Pure: the frame component supplies the effects.

import type { SnapView } from './contributions.ts';

export const BRIDGE_TAG = 'kinguSnapView';
export type ViewRequest = { id: number; method: string; params: Record<string, unknown> };
export type ViewReply = { kinguSnapView: 1; id: number; result?: unknown; error?: string };

export type BridgeEffects = {
	/** The value of the snap's setting `key` (declared by the snap; settings service or default). */
	setting(key: string): unknown;
	runTask(taskId: string): void;
	notify(severity: 'info' | 'warning' | 'error', message: string): void;
	theme(): 'light' | 'dark';
	now(): number;
};

/** At most this many notifications per window of NOTIFY_WINDOW_MS, and task runs per TASK_WINDOW_MS. */
export const NOTIFY_LIMIT = 3;
export const NOTIFY_WINDOW_MS = 10_000;
export const TASK_LIMIT = 2;
export const TASK_WINDOW_MS = 5_000;
const MAX_MESSAGE = 500;

/** A request posted by the page, or null for anything that is not one (other messages are ignored). */
export function parseRequest(data: unknown): ViewRequest | null {
	if (!data || typeof data !== 'object') return null;
	const d = data as Record<string, unknown>;
	if (d[BRIDGE_TAG] !== 1 || typeof d.id !== 'number' || !Number.isSafeInteger(d.id) || typeof d.method !== 'string') return null;
	const params = d.params && typeof d.params === 'object' && !Array.isArray(d.params) ? (d.params as Record<string, unknown>) : {};
	return { id: d.id, method: d.method, params };
}

export class ViewBridge {
	#notified: number[] = [];
	#ran: number[] = [];

	constructor(
		readonly snapId: string,
		readonly view: SnapView,
		readonly effects: BridgeEffects
	) {}

	#limited(times: number[], limit: number, windowMs: number): boolean {
		const now = this.effects.now();
		while (times.length && now - times[0] >= windowMs) times.shift();
		if (times.length >= limit) return true;
		times.push(now);
		return false;
	}

	/** The reply to one message from the page, or null when it is not a bridge request. */
	handle(data: unknown): ViewReply | null {
		const req = parseRequest(data);
		if (!req) return null;
		const ok = (result: unknown): ViewReply => ({ [BRIDGE_TAG]: 1, id: req.id, result }) as ViewReply;
		const fail = (error: string): ViewReply => ({ [BRIDGE_TAG]: 1, id: req.id, error }) as ViewReply;
		const p = req.params;
		switch (req.method) {
			case 'context':
				return ok({ snap: this.snapId, view: this.view.id, theme: this.effects.theme() });
			case 'getSetting': {
				const key = typeof p.key === 'string' ? p.key : '';
				if (!this.view.settings.includes(key)) return fail(`setting "${key}" is not declared for this view`);
				const v = this.effects.setting(key);
				return ok(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null);
			}
			case 'runTask': {
				const task = typeof p.task === 'string' ? p.task : '';
				if (!this.view.tasks.includes(task)) return fail(`task "${task}" is not declared for this view`);
				if (this.#limited(this.#ran, TASK_LIMIT, TASK_WINDOW_MS)) return fail('too many task runs; try again shortly');
				this.effects.runTask(task);
				return ok(true);
			}
			case 'notify': {
				if (!this.view.notifications) return fail('notifications are not declared for this view');
				const message = typeof p.message === 'string' ? p.message.trim().slice(0, MAX_MESSAGE) : '';
				if (!message) return fail('empty message');
				if (this.#limited(this.#notified, NOTIFY_LIMIT, NOTIFY_WINDOW_MS)) return fail('too many notifications; try again shortly');
				const severity = p.severity === 'warning' || p.severity === 'error' ? p.severity : 'info';
				this.effects.notify(severity, message);
				return ok(true);
			}
			default:
				return fail(`unknown method "${req.method}"`);
		}
	}
}

/** The message telling a page the theme changed (`kingu-theme` event in the page). */
export const themeMessage = (kind: 'light' | 'dark') => ({ [BRIDGE_TAG]: 1, event: 'theme', kind });
