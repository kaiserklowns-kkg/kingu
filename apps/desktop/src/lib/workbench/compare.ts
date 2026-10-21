// Compare editors (VS Code: Select for Compare / Compare with Selected, Compare Active File
// With…, Compare with Saved, Compare with Clipboard). Pure: the tab key of a comparison of two
// resources, `compare://<left>/<right>` (each an editor key, URI-encoded), and its label. The left
// side may also be `saved:<key>` (the file on disk under its unsaved edits) or `clipboard:<n>`
// (clipboard text captured when the command ran, see compare.svelte.ts).

export const COMPARE_PREFIX = 'compare://';
const SAVED = 'saved:';
const CLIPBOARD = 'clipboard:';

export type CompareSide = { kind: 'resource'; key: string } | { kind: 'saved'; key: string } | { kind: 'clipboard'; id: string };

const encodeSide = (s: CompareSide) => encodeURIComponent(s.kind === 'resource' ? s.key : s.kind === 'saved' ? SAVED + s.key : CLIPBOARD + s.id);

function decodeSide(text: string): CompareSide | null {
	let v: string;
	try {
		v = decodeURIComponent(text);
	} catch {
		return null;
	}
	if (!v) return null;
	if (v.startsWith(SAVED)) return { kind: 'saved', key: v.slice(SAVED.length) };
	if (v.startsWith(CLIPBOARD)) return { kind: 'clipboard', id: v.slice(CLIPBOARD.length) };
	return { kind: 'resource', key: v };
}

/** The tab key comparing `left` with the resource `right` (the right side is always a file). */
export const compareKey = (left: CompareSide, right: string) => `${COMPARE_PREFIX}${encodeSide(left)}/${encodeURIComponent(right)}`;

export const isCompareKey = (key: string) => key.startsWith(COMPARE_PREFIX);

export function parseCompareKey(key: string): { left: CompareSide; right: string } | null {
	if (!isCompareKey(key)) return null;
	const [l, r, ...rest] = key.slice(COMPARE_PREFIX.length).split('/');
	if (rest.length || r === undefined) return null;
	const left = decodeSide(l);
	const right = decodeSide(r);
	return left && right?.kind === 'resource' ? { left, right: right.key } : null;
}

/** The file name of an editor key (`src/a.ts`, `external:/tmp/b.ts`, `untitled:Untitled-1`). */
const nameOf = (key: string) => key.replace(/^[a-zA-Z][\w+.-]*:(?!\/\/)/, '').split(/[/\\]/).filter(Boolean).pop() ?? key;

/** VS Code's labels: `a.ts ↔ b.ts`, `a.ts (Saved) ↔ a.ts`, `Clipboard ↔ a.ts`. */
export function compareLabel(left: CompareSide, right: string, words: { saved: string; clipboard: string }): string {
	const r = nameOf(right);
	if (left.kind === 'saved') return `${nameOf(left.key)} (${words.saved}) ↔ ${r}`;
	if (left.kind === 'clipboard') return `${words.clipboard} ↔ ${r}`;
	return `${nameOf(left.key)} ↔ ${r}`;
}
