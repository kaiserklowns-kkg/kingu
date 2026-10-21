// Extras of VS Code's HTML and CSS language clients (extensions/html-language-features,
// css-language-features) on top of vscode-html-language-server / vscode-css-language-server:
// - Auto closing tags and auto quotes (`html.autoClosingTags`, `html.autoCreateQuotes`): after a
//   typed `>` or `/` (or `=`), the server's `html/autoInsert` gives a snippet to insert
//   (autoInsertion.ts).
// - Custom data (`html.customData`, `css.customData`): the data files' URIs go to the server
//   (`html/customDataChanged`, `css/customDataChanged`), which reads them, the HTML server through
//   the client's `html/customDataContent` (customData.ts).
// Pure, so bun tests cover it; lsp.svelte.ts talks to the servers.

export type AutoInsertKind = 'autoClose' | 'autoQuote';
/** One change of a model content change (Monaco's IModelContentChange, the fields used here). */
export type ContentChange = { text: string; rangeLength: number; range: { startLineNumber: number; startColumn: number } };

export const AUTO_INSERT_REQUEST = 'html/autoInsert';
/** VS Code waits this long after the keystroke before asking. */
export const AUTO_INSERT_DELAY_MS = 100;

/**
 * Whether the last change of an edit asks for an auto insert, and where (1-based, after the typed
 * character): a single-line insertion ending in `=` (auto quote) or `>` / `/` (auto close). Undo
 * and redo never do (VS Code's onDidChangeTextDocument).
 */
export function autoInsertAt(
	changes: readonly ContentChange[],
	enabled: { autoClose: boolean; autoQuote: boolean },
	undoRedo: boolean
): { kind: AutoInsertKind; line: number; column: number } | null {
	if (undoRedo || !changes.length || (!enabled.autoClose && !enabled.autoQuote)) return null;
	const last = changes[changes.length - 1];
	if (last.rangeLength !== 0 || !last.text || /\n/.test(last.text)) return null;
	const ch = last.text[last.text.length - 1];
	const kind: AutoInsertKind | null = enabled.autoQuote && ch === '=' ? 'autoQuote' : enabled.autoClose && (ch === '>' || ch === '/') ? 'autoClose' : null;
	return kind && { kind, line: last.range.startLineNumber, column: last.range.startColumn + last.text.length };
}

/** A string that is a URI (has a scheme), not a path (customData.ts isURI). */
const isUri = (value: string) => /^(?<scheme>\w[\w\d+.-]*):/.test(value);

/** `path` (a file path or file URI) as a file URI. */
const fileUri = (path: string) => 'file://' + path.split('/').map(encodeURIComponent).join('/');

/** `rel` against folder `dir` (`./` and `../` resolved). */
function resolvePath(dir: string, rel: string): string {
	if (rel.startsWith('/')) return rel;
	const parts = dir.replace(/\/+$/, '').split('/');
	for (const seg of rel.split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') parts.pop();
		else parts.push(seg);
	}
	return parts.join('/') || '/';
}

/**
 * The custom data files of `html.customData` / `css.customData` as URIs (customData.ts
 * collectInWorkspaces): each root folder's own value against that folder, and for the first folder
 * also the workspace file's and the user's values. Paths are relative to the folder; URIs pass as
 * they are. Duplicates go.
 */
export function customDataUris(folders: readonly { path: string; value?: unknown }[], workspaceValue: unknown, userValue: unknown): string[] {
	const out = new Set<string>();
	const collect = (value: unknown, dir: string) => {
		if (!Array.isArray(value)) return;
		for (const v of value) if (typeof v === 'string' && v.trim()) out.add(isUri(v) ? v : fileUri(resolvePath(dir, v.trim())));
	};
	folders.forEach((f, i) => {
		collect(f.value, f.path);
		if (i === 0) {
			collect(workspaceValue, f.path);
			collect(userValue, f.path);
		}
	});
	return [...out];
}

/** The notification that tells a server its custom data changed, by server key. */
export const CUSTOM_DATA_NOTIFICATION: Readonly<Record<string, string>> = { html: 'html/customDataChanged', css: 'css/customDataChanged' };
/** The HTML server asks the client for a data file's text. */
export const CUSTOM_DATA_CONTENT_REQUEST = 'html/customDataContent';
