// Unsent chat input per chat (VS Code 1.147's saved drafts: each session keeps what was typed in
// it, across switching chats and restarts). Kept in this machine's localStorage only; a draft is
// dropped once sent or cleared, after 30 days, and past the 50 most recent.

const KEY = 'kingu.chat.drafts';
const MAX_DRAFTS = 50;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** Longer text is kept cut to this (a pasted log should not fill the storage). */
const MAX_TEXT = 100_000;

export type Drafts = Record<string, { text: string; at: number }>;

/** The stored drafts, recent and well-formed ones only. */
export function parseDrafts(raw: string | null, now: number): Drafts {
	let v: unknown;
	try {
		v = raw ? JSON.parse(raw) : null;
	} catch {
		return {};
	}
	if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
	const out: Drafts = {};
	for (const [id, d] of Object.entries(v as Record<string, unknown>)) {
		const e = d as { text?: unknown; at?: unknown } | null;
		if (typeof e?.text === 'string' && e.text && typeof e.at === 'number' && now - e.at < MAX_AGE_MS) out[id] = { text: e.text.slice(0, MAX_TEXT), at: e.at };
	}
	return out;
}

/** `drafts` with `id`'s draft set to `text` (removed when blank), the oldest past the cap dropped. */
export function withDraft(drafts: Drafts, id: string, text: string, now: number): Drafts {
	const next = { ...drafts };
	if (text.trim()) next[id] = { text: text.slice(0, MAX_TEXT), at: now };
	else delete next[id];
	const ids = Object.keys(next);
	if (ids.length > MAX_DRAFTS) for (const old of ids.sort((a, b) => next[a].at - next[b].at).slice(0, ids.length - MAX_DRAFTS)) delete next[old];
	return next;
}

function read(): Drafts {
	try {
		return parseDrafts(localStorage.getItem(KEY), Date.now());
	} catch {
		return {};
	}
}

/** The draft of chat `id` ('' when none). */
export function loadDraft(id: string): string {
	return read()[id]?.text ?? '';
}

/** Saves (or, blank, forgets) chat `id`'s draft. Storage full or unavailable: nothing is kept. */
export function saveDraft(id: string, text: string) {
	const drafts = read();
	if ((drafts[id]?.text ?? '') === (text.trim() ? text.slice(0, MAX_TEXT) : '')) return;
	try {
		localStorage.setItem(KEY, JSON.stringify(withDraft(drafts, id, text, Date.now())));
	} catch {
		// Nothing to do: the draft stays in the input only.
	}
}
