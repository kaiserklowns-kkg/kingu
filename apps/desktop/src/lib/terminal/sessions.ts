// Terminal session keys and their persistence (pure, so `bun test` covers it).
// PTYs live outside the page (the kingu-ptyd daemon, or the Rust process as a fallback) under a
// key the page picks. Keys carry a short hash of the workspace root, so two folders never share
// a key. The lists that decide which terminals exist go to localStorage per root, so a reloaded
// page, and the next launch after a quit, mount the same terminals and re-attach to them.

import { leaf, leaves, parsePaneNode, type PaneNode } from './paneLayout.ts';

/** Short, stable tag of a workspace root (FNV-1a, 8 hex digits); `null` is "no folder open". */
export function rootTag(root: string | null): string {
	let h = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(root ?? '')) {
		h ^= byte;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/** A terminal of the IDE panel. */
export const panelKey = (tag: string, id: number) => `panel:${tag}:${id}`;
/** A terminal tab of an ADE worktree ('' is the folder itself). */
export const adeKey = (tag: string, worktree: string, tabId: string) => `ade:${tag}:${worktree}:${tabId}`;
/** A task's agent CLI; `startedAt` makes a restarted CLI a new session. */
export const cliKey = (tag: string, slug: string, startedAt: number) => `cli:${tag}:${slug}:${startedAt}`;

const TAB_ID = /^t\d+$/;

const KEY_RE = /^[A-Za-z0-9:_.-]{1,128}$/;
/** Same rule as Rust's `validate_key`. */
export const isValidKey = (key: string) => KEY_RE.test(key);

/** The root tag of a key built above; null for anything else (a key from an older build). */
export function keyTag(key: string): string | null {
	const m = /^(?:panel|ade|cli):([0-9a-f]{8}):/.exec(key);
	return m ? m[1] : null;
}

/** What `pty_list` returns per live session. */
export type PtyInfo = { key: string; cwd: string; alive: boolean };

/** Live PTYs of root `tag` that the restored page does not show: left over, so safe to kill.
 *  Other roots' sessions keep running until their folder is opened again. */
export function orphanKeys(live: string[], wanted: Set<string>, tag: string): string[] {
	return live.filter((k) => keyTag(k) === tag && !wanted.has(k));
}

/** Live PTYs this window does not show (other folders, or left over from an older build). */
export function backgroundKeys(live: string[], wanted: Set<string>): string[] {
	return live.filter((k) => !wanted.has(k));
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

function storage(): Storage | null {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

/** The storage name of one root's list. */
export const storeName = (base: string, tag: string) => `${base}:${tag}`;

/** Reads `name` and lets `parse` vet it: anything unexpected reads as nothing. */
export function restore<T>(name: string, parse: (raw: unknown) => T | null, store: Storage | null = storage()): T | null {
	try {
		const text = store?.getItem(name);
		return text ? parse(JSON.parse(text)) : null;
	} catch {
		return null;
	}
}

export function persist(name: string, value: unknown, store: Storage | null = storage()) {
	try {
		store?.setItem(name, JSON.stringify(value));
	} catch {
		// Storage can be unavailable; terminals then start over with the page.
	}
}

/** A restored terminal re-attaches, or starts a plain shell: its command never runs again. */
export function withoutRun<T extends { run?: string[] }>(t: T): Omit<T, 'run'> {
	const { run: _, ...rest } = t;
	return rest;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const isArgv = (v: unknown): v is string[] => Array.isArray(v) && v.every((a) => typeof a === 'string');
const optString = (v: unknown) => (typeof v === 'string' ? v : undefined);
const optArgv = (v: unknown) => (isArgv(v) ? v : undefined);
/** Any root tag: key validity only depends on its length. */
const SAMPLE_TAG = '00000000';

export type PanelTerminalsState = { list: { id: number; title: string; run?: string[] }[]; active: number; seq: number; groups: PaneNode[] };

/** VS Code's terminal groups: each a pane tree of terminal ids; every terminal is in exactly one. */
export function panelGroups(raw: unknown, ids: number[]): PaneNode[] {
	const known = new Set(ids.map(String));
	const seen = new Set<string>();
	const groups: PaneNode[] = [];
	for (const g of Array.isArray(raw) ? raw : []) {
		const tree = parsePaneNode(g, (id) => known.has(id));
		if (!tree || leaves(tree).some((id) => seen.has(id))) continue;
		leaves(tree).forEach((id) => seen.add(id));
		groups.push(tree);
	}
	for (const id of ids) if (!seen.has(String(id))) groups.push(leaf(String(id)));
	return groups;
}

export function parsePanelTerminals(raw: unknown): PanelTerminalsState | null {
	if (!isObject(raw) || !Array.isArray(raw.list) || !isInt(raw.active) || !isInt(raw.seq)) return null;
	const list = raw.list.filter((t) => isObject(t) && isInt(t.id) && t.id > 0).map((t) => ({ id: t.id as number, title: optString(t.title) ?? 'zsh', run: optArgv(t.run) }));
	if (!list.length) return null;
	const seq = Math.max(raw.seq, ...list.map((t) => t.id));
	const active = list.some((t) => t.id === raw.active) ? raw.active : list[0].id;
	return { list, active, seq, groups: panelGroups(raw.groups, list.map((t) => t.id)) };
}

export type AdeTerminalsState = {
	terminals: Record<string, { id: string; n: number; title?: string; run?: string[]; layout?: PaneNode; pane?: string; expanded?: string }[]>;
	active: Record<string, string>;
	seq: number;
};

export function parseAdeTerminals(raw: unknown): AdeTerminalsState | null {
	if (!isObject(raw) || !isObject(raw.terminals) || !isInt(raw.seq)) return null;
	const terminals: AdeTerminalsState['terminals'] = {};
	let seq = raw.seq;
	for (const [worktree, list] of Object.entries(raw.terminals)) {
		if (!Array.isArray(list)) continue;
		const taken = new Set<string>();
		const tabs = list
			.filter((t) => isObject(t) && typeof t.id === 'string' && TAB_ID.test(t.id) && isInt(t.n))
			.map((t) => {
				const layout = parsePaneNode(t.layout, (id) => TAB_ID.test(id)) ?? undefined;
				const panes = layout ? leaves(layout) : [t.id as string];
				const pane = optString(t.pane);
				const expanded = optString(t.expanded);
				return {
					id: t.id as string,
					n: t.n as number,
					title: optString(t.title),
					run: optArgv(t.run),
					// One pane left that is not the tab's first keeps its tree: the tree names its PTY.
					...(layout && (layout.type === 'split' || layout.id !== t.id) ? { layout } : {}),
					...(layout && pane && panes.includes(pane) ? { pane } : {}),
					...(layout && expanded && panes.includes(expanded) ? { expanded } : {})
				};
			})
			// A pane id names one PTY: two tabs claiming it keep the first.
			.filter((t) => {
				const panes = t.layout ? leaves(t.layout) : [t.id];
				if (panes.some((p) => taken.has(p))) return false;
				panes.forEach((p) => taken.add(p));
				return true;
			});
		for (const t of tabs) for (const p of [t.id, ...(t.layout ? leaves(t.layout) : [])]) seq = Math.max(seq, Number(p.slice(1)));
		if (tabs.length && isValidKey(adeKey(SAMPLE_TAG, worktree, 't0'))) terminals[worktree] = tabs;
	}
	const active: Record<string, string> = {};
	if (isObject(raw.active)) for (const [k, v] of Object.entries(raw.active)) if (typeof v === 'string') active[k] = v;
	return { terminals, active, seq };
}

export type CliSessionsState = Record<string, { run: string[]; startedAt: number; hookToken?: string }>;

export function parseCliSessions(raw: unknown): CliSessionsState | null {
	if (!isObject(raw)) return null;
	const out: CliSessionsState = {};
	for (const [slug, s] of Object.entries(raw)) {
		if (isObject(s) && isArgv(s.run) && s.run.length && isInt(s.startedAt) && isValidKey(cliKey(SAMPLE_TAG, slug, s.startedAt))) out[slug] = { run: s.run, startedAt: s.startedAt, ...(typeof s.hookToken === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(s.hookToken) ? { hookToken: s.hookToken } : {}) };
	}
	return out;
}

/** Restored CLI sessions split by whether their PTY is still alive (only those show a terminal). */
export function liveCliSessions(saved: CliSessionsState, tag: string, live: Set<string>): { kept: CliSessionsState; gone: CliSessionsState } {
	const kept: CliSessionsState = {};
	const gone: CliSessionsState = {};
	for (const [slug, s] of Object.entries(saved)) (live.has(cliKey(tag, slug, s.startedAt)) ? kept : gone)[slug] = s;
	return { kept, gone };
}

/** terminal.integrated.hideOnStartup: whether the terminal view hides on the first load (`restored`: a saved list came back). */
export function hideOnStartup(setting: string, restored: boolean): boolean {
	return setting === 'always' || (setting === 'whenEmpty' && !restored);
}
