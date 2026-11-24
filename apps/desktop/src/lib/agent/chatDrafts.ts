// Unsent chat input per chat (VS Code 1.147's saved drafts, sessions/common/savedSessionDrafts.ts:
// each session keeps what was typed in it, across switching chats and restarts). Kept in this
// machine's localStorage only; a draft is dropped once sent or cleared, after 30 days, and past the
// 50 most recent.
// As VS Code's IChatDraft keeps `inputText` and `attachments` (hasSessionDraftContent: text or an
// attachment), a draft keeps the attached files and file chips with the text, and one with only
// attachments is a draft too. The history lists the chats with a draft ("Draft: …", Delete Draft;
// VS Code's Drafts group with Resume Draft / Delete Draft).

const KEY = 'kingu.chat.drafts';
const MAX_DRAFTS = 50;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** Longer text is kept cut to this (a pasted log should not fill the storage). */
const MAX_TEXT = 100_000;
/** At most this many attachments are kept with a draft. */
const MAX_ATTACHMENTS = 50;

/** An attached file (attachments.ts `Attachment`). */
export type DraftFile = { path: string; name: string; image: boolean };
/** A file chip, maybe a line range of it. */
export type DraftPick = { path: string; range?: { startLine: number; endLine: number } };
/** What a draft restores into the input. */
export type DraftInput = { text: string; files?: DraftFile[]; picked?: DraftPick[] };
export type Draft = DraftInput & { at: number };
export type Drafts = Record<string, Draft>;

const isFile = (f: unknown): f is DraftFile => {
	const x = f as DraftFile | null;
	return !!x && typeof x.path === 'string' && !!x.path && typeof x.name === 'string' && typeof x.image === 'boolean';
};
const isPick = (f: unknown): f is DraftPick => {
	const x = f as DraftPick | null;
	if (!x || typeof x.path !== 'string' || !x.path) return false;
	return x.range === undefined || (Number.isInteger(x.range?.startLine) && Number.isInteger(x.range?.endLine));
};

/** Text or an attachment (VS Code's hasSessionDraftContent). */
export const hasDraftContent = (d: DraftInput): boolean => !!d.text.trim() || !!d.files?.length || !!d.picked?.length;

/** The draft as stored: its text cut, its attachments well-formed and capped, empty lists left out. */
function clean(d: DraftInput): DraftInput {
	const files = (d.files ?? []).filter(isFile).slice(0, MAX_ATTACHMENTS);
	const picked = (d.picked ?? []).filter(isPick).slice(0, MAX_ATTACHMENTS);
	return { text: d.text.slice(0, MAX_TEXT), ...(files.length ? { files: files.map(({ path, name, image }) => ({ path, name, image })) } : {}), ...(picked.length ? { picked: picked.map((p) => ({ path: p.path, ...(p.range ? { range: { startLine: p.range.startLine, endLine: p.range.endLine } } : {}) })) } : {}) };
}

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
		const e = d as { text?: unknown; at?: unknown; files?: unknown; picked?: unknown } | null;
		if (typeof e?.text !== 'string' || typeof e.at !== 'number' || now - e.at >= MAX_AGE_MS) continue;
		const draft = clean({ text: e.text, files: Array.isArray(e.files) ? e.files : [], picked: Array.isArray(e.picked) ? e.picked : [] });
		if (hasDraftContent(draft)) out[id] = { ...draft, at: e.at };
	}
	return out;
}

/** `drafts` with `id`'s draft set to `input` (removed when it has nothing), the oldest past the cap dropped. */
export function withDraft(drafts: Drafts, id: string, input: DraftInput | string, now: number): Drafts {
	const d = typeof input === 'string' ? { text: input } : input;
	const next = { ...drafts };
	if (hasDraftContent(d)) next[id] = { ...clean(d), at: now };
	else delete next[id];
	const ids = Object.keys(next);
	if (ids.length > MAX_DRAFTS) for (const old of ids.sort((a, b) => next[a].at - next[b].at).slice(0, ids.length - MAX_DRAFTS)) delete next[old];
	return next;
}

/** Same content (the time aside): saving it again changes nothing. */
export function sameDraft(a: DraftInput | undefined, b: DraftInput): boolean {
	const x = a ? clean(a) : { text: '' };
	const y = clean(b);
	if (!hasDraftContent(y)) return !a || !hasDraftContent(x);
	return JSON.stringify(x) === JSON.stringify(y);
}

/** The history row's line for a draft: its first line of text, else how many attachments it keeps. */
export function draftSummary(d: DraftInput): { text: string } | { files: number } {
	const line = d.text.trim().split('\n')[0]?.trim() ?? '';
	return line ? { text: line } : { files: (d.files?.length ?? 0) + (d.picked?.length ?? 0) };
}

function read(): Drafts {
	try {
		return parseDrafts(localStorage.getItem(KEY), Date.now());
	} catch {
		return {};
	}
}

/** Every kept draft, by key (`chat:<id>`, `new:<folder>`). */
export function listDrafts(): Drafts {
	return read();
}

/** The draft of `id` (an empty one when none). */
export function loadDraft(id: string): DraftInput {
	const d = read()[id];
	return d ? { text: d.text, ...(d.files ? { files: d.files } : {}), ...(d.picked ? { picked: d.picked } : {}) } : { text: '' };
}

/** Saves (or, empty, forgets) `id`'s draft. Storage full or unavailable: nothing is kept. */
export function saveDraft(id: string, input: DraftInput | string) {
	const d = typeof input === 'string' ? { text: input } : input;
	const drafts = read();
	if (sameDraft(drafts[id], d)) return;
	try {
		localStorage.setItem(KEY, JSON.stringify(withDraft(drafts, id, d, Date.now())));
	} catch {
		// Nothing to do: the draft stays in the input only.
	}
}
