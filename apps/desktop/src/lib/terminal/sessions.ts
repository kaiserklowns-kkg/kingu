// Terminal session keys and their persistence across webview reloads (pure, so `bun test` covers it).
// PTYs live in the Rust process under a key the page picks; the lists that decide which terminals
// exist go to sessionStorage, so a reloaded page mounts the same terminals and re-attaches. After an
// app restart sessionStorage is empty: nothing re-attaches and no agent CLI is started again.

/** A terminal of the IDE panel. */
export const panelKey = (id: number) => `panel:${id}`;
/** A terminal tab of an ADE worktree ('' is the folder itself). */
export const adeKey = (worktree: string, tabId: string) => `ade:${worktree}:${tabId}`;
/** A task's agent CLI; `startedAt` makes a restarted CLI a new session. */
export const cliKey = (slug: string, startedAt: number) => `cli:${slug}:${startedAt}`;

const KEY_RE = /^[A-Za-z0-9:_.-]{1,128}$/;
/** Same rule as Rust's `pty::validate_key`. */
export const isValidKey = (key: string) => KEY_RE.test(key);

/** Live PTYs the page no longer shows (left over from before a reload). */
export function orphanKeys(live: string[], wanted: Set<string>): string[] {
	return live.filter((k) => !wanted.has(k));
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

function storage(): Storage | null {
	try {
		return globalThis.sessionStorage ?? null;
	} catch {
		return null;
	}
}

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
		// Storage can be unavailable; terminals then restart with the page.
	}
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const isArgv = (v: unknown): v is string[] => Array.isArray(v) && v.every((a) => typeof a === 'string');
const optString = (v: unknown) => (typeof v === 'string' ? v : undefined);
const optArgv = (v: unknown) => (isArgv(v) ? v : undefined);

export type PanelTerminalsState = { list: { id: number; title: string; run?: string[] }[]; active: number; seq: number };

export function parsePanelTerminals(raw: unknown): PanelTerminalsState | null {
	if (!isObject(raw) || !Array.isArray(raw.list) || !isInt(raw.active) || !isInt(raw.seq)) return null;
	const list = raw.list.filter((t) => isObject(t) && isInt(t.id) && t.id > 0).map((t) => ({ id: t.id as number, title: optString(t.title) ?? 'zsh', run: optArgv(t.run) }));
	if (!list.length) return null;
	const seq = Math.max(raw.seq, ...list.map((t) => t.id));
	const active = list.some((t) => t.id === raw.active) ? raw.active : list[0].id;
	return { list, active, seq };
}

export type AdeTerminalsState = {
	terminals: Record<string, { id: string; n: number; title?: string; run?: string[] }[]>;
	active: Record<string, string>;
	seq: number;
};

export function parseAdeTerminals(raw: unknown): AdeTerminalsState | null {
	if (!isObject(raw) || !isObject(raw.terminals) || !isInt(raw.seq)) return null;
	const terminals: AdeTerminalsState['terminals'] = {};
	let seq = raw.seq;
	for (const [worktree, list] of Object.entries(raw.terminals)) {
		if (!Array.isArray(list)) continue;
		const tabs = list
			.filter((t) => isObject(t) && typeof t.id === 'string' && /^t\d+$/.test(t.id) && isInt(t.n))
			.map((t) => ({ id: t.id as string, n: t.n as number, title: optString(t.title), run: optArgv(t.run) }));
		for (const t of tabs) seq = Math.max(seq, Number(t.id.slice(1)));
		if (tabs.length && isValidKey(adeKey(worktree, 't0'))) terminals[worktree] = tabs;
	}
	const active: Record<string, string> = {};
	if (isObject(raw.active)) for (const [k, v] of Object.entries(raw.active)) if (typeof v === 'string') active[k] = v;
	return { terminals, active, seq };
}

export type CliSessionsState = Record<string, { run: string[]; startedAt: number }>;

export function parseCliSessions(raw: unknown): CliSessionsState | null {
	if (!isObject(raw)) return null;
	const out: CliSessionsState = {};
	for (const [slug, s] of Object.entries(raw)) {
		if (isObject(s) && isArgv(s.run) && s.run.length && isInt(s.startedAt) && isValidKey(cliKey(slug, s.startedAt))) out[slug] = { run: s.run, startedAt: s.startedAt };
	}
	return out;
}
