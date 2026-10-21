// LSP ⇄ Monaco conversions. Pure (Monaco enum values are inlined) so they run under `bun test`.
//
// Positions: LSP lines and characters are 0-based, Monaco's are 1-based. Characters are
// UTF-16 code units in both (Kingu negotiates `positionEncoding: utf-16`, and Monaco columns
// index JavaScript strings), so a character offset maps to a column by adding one.

import type * as Monaco from 'monaco-editor';
import { keyForPath, within, type WorkspaceFolder } from '#lib/workbench/workspaceFolders.ts';
import type {
	CompletionItem,
	CompletionItemDefaults,
	Diagnostic,
	DocumentHighlight,
	DocumentSymbol,
	Hover,
	Location,
	LocationLink,
	MarkedString,
	MarkupContent,
	Position,
	PrepareRenameResult,
	Range,
	SignatureHelp,
	SymbolInformation,
	TextEdit
} from './protocol';

export type MRange = Monaco.IRange;

export function toMonacoRange(r: Range): MRange {
	return { startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 };
}

export function toLspPosition(p: { lineNumber: number; column: number }): Position {
	return { line: p.lineNumber - 1, character: p.column - 1 };
}

export function toLspRange(r: MRange): Range {
	return { start: { line: r.startLineNumber - 1, character: r.startColumn - 1 }, end: { line: r.endLineNumber - 1, character: r.endColumn - 1 } };
}

export function rangeContains(r: Range, p: Position): boolean {
	const before = (a: Position, b: Position) => a.line < b.line || (a.line === b.line && a.character <= b.character);
	return before(r.start, p) && before(p, r.end);
}

// --- Diagnostics -----------------------------------------------------------------------------

/** monaco.MarkerSeverity: Hint 1, Info 2, Warning 4, Error 8. */
export const MarkerSeverity = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const;

export function toMarkerSeverity(severity: number | undefined): number {
	switch (severity) {
		case 2:
			return MarkerSeverity.Warning;
		case 3:
			return MarkerSeverity.Info;
		case 4:
			return MarkerSeverity.Hint;
		default:
			return MarkerSeverity.Error; // LSP: a missing severity is up to the client; VS Code shows Error.
	}
}

export function toMarker(d: Diagnostic): Monaco.editor.IMarkerData {
	return {
		...toMonacoRange(d.range),
		severity: toMarkerSeverity(d.severity) as Monaco.MarkerSeverity,
		message: d.message,
		source: d.source,
		code: d.code === undefined ? undefined : d.codeDescription ? { value: String(d.code), target: d.codeDescription.href as never } : String(d.code),
		// LSP DiagnosticTag and monaco.MarkerTag share values (Unnecessary 1, Deprecated 2).
		tags: d.tags?.filter((t) => t === 1 || t === 2) as Monaco.MarkerTag[] | undefined
	};
}

/** A Monaco marker back to the LSP diagnostic it came from (for `textDocument/codeAction`). */
export function markerToDiagnostic(m: Monaco.editor.IMarkerData): Diagnostic {
	const severity = m.severity === MarkerSeverity.Warning ? 2 : m.severity === MarkerSeverity.Info ? 3 : m.severity === MarkerSeverity.Hint ? 4 : 1;
	const code = typeof m.code === 'object' ? m.code.value : m.code;
	return {
		range: toLspRange(m),
		severity,
		message: m.message,
		source: m.source,
		code,
		tags: m.tags?.length ? (m.tags as number[]) : undefined
	};
}

export type Severity = 'error' | 'warning' | 'info' | 'hint';
export function severityName(severity: number | undefined): Severity {
	return severity === 2 ? 'warning' : severity === 3 ? 'info' : severity === 4 ? 'hint' : 'error';
}

/** Pushed (`publishDiagnostics`) and pulled (`textDocument/diagnostic`) diagnostics for one file,
 * deduplicated and in reading order. */
export function mergeDiagnostics(...sets: (Diagnostic[] | undefined)[]): Diagnostic[] {
	const seen = new Set<string>();
	const out: Diagnostic[] = [];
	for (const d of sets.flatMap((s) => s ?? [])) {
		const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.severity}:${d.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(d);
	}
	return out.sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}

// --- URIs ------------------------------------------------------------------------------------

export function pathToUri(path: string): string {
	return 'file://' + path.split('/').map(encodeURIComponent).join('/');
}

export function uriToPath(uri: string): string | null {
	if (!uri.startsWith('file://')) return null;
	try {
		return decodeURIComponent(uri.slice('file://'.length).replace(/^localhost\//, '/'));
	} catch {
		return null;
	}
}

/** Workspace-relative path of `uri`, or null when it is outside `root`. */
export function relOfUri(root: string, uri: string): string | null {
	const path = uriToPath(uri);
	if (!path) return null;
	const base = root.endsWith('/') ? root : root + '/';
	return path.startsWith(base) ? path.slice(base.length) : null;
}

/** A file of another root folder of a multi-root workspace has an absolute path already. */
export function uriOfRel(root: string, rel: string): string {
	if (rel.startsWith('/')) return pathToUri(rel);
	return pathToUri(`${root.replace(/\/$/, '')}/${rel}`);
}

/**
 * The workbench key of an LSP URI in a multi-root workspace: relative in the first folder,
 * absolute in another (workspaceFolders.ts), null outside every folder or for a folder itself.
 */
export function keyOfUri(folders: readonly WorkspaceFolder[], uri: string): string | null {
	const path = uriToPath(uri);
	if (!path) return null;
	const key = keyForPath(path.replace(/\/+$/, '') || '/', folders);
	return key ? key : null;
}

/** The Monaco model path of a workbench key (editorModels.ts `modelPath`: `/rel`, or the absolute path). */
export function modelPathOf(key: string): string {
	return key.startsWith('/') ? key : '/' + key;
}

/** The workbench key of a Monaco model path: absolute when it lies in a root folder other than the first, else `/rel`. */
export function keyOfModelPath(path: string, folders: readonly WorkspaceFolder[]): string {
	return folders.slice(1).some((f) => within(path, f.path)) ? path : path.replace(/^\//, '');
}

/** An LSP workspace folder (`WorkspaceFolder` in the protocol). */
export type LspFolder = { uri: string; name: string };

export function lspFolders(folders: readonly WorkspaceFolder[]): LspFolder[] {
	return folders.map((f) => ({ uri: pathToUri(f.path.replace(/\/+$/, '') || '/'), name: f.name || f.path.slice(f.path.lastIndexOf('/') + 1) }));
}

/** `workspace/didChangeWorkspaceFolders`' event between two folder lists (by URI; a renamed folder is removed and added). */
export function folderChanges(before: readonly LspFolder[], after: readonly LspFolder[]): { added: LspFolder[]; removed: LspFolder[] } {
	const same = (a: LspFolder, b: LspFolder) => a.uri === b.uri && a.name === b.name;
	return { added: after.filter((f) => !before.some((b) => same(b, f))), removed: before.filter((f) => !after.some((a) => same(a, f))) };
}

// --- Hover and documentation -----------------------------------------------------------------

function markedToMarkdown(m: MarkedString): string {
	return typeof m === 'string' ? m : '```' + m.language + '\n' + m.value + '\n```';
}

const escapeMarkdown = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');

export function markupToMarkdown(m: string | MarkupContent | undefined): Monaco.IMarkdownString | undefined {
	if (m === undefined) return undefined;
	if (typeof m === 'string') return { value: escapeMarkdown(m) };
	return { value: m.kind === 'markdown' ? m.value : escapeMarkdown(m.value) };
}

export function hoverContents(h: Hover): Monaco.IMarkdownString[] {
	const c = h.contents;
	if (Array.isArray(c)) return c.map((m) => ({ value: markedToMarkdown(m) }));
	if (typeof c === 'object' && 'kind' in c) return [markupToMarkdown(c)!];
	return [{ value: markedToMarkdown(c) }];
}

// --- Completion ------------------------------------------------------------------------------

/** LSP CompletionItemKind (1-based) → monaco.languages.CompletionItemKind. */
const completionKinds: Record<number, number> = {
	1: 18, // Text
	2: 0, // Method
	3: 1, // Function
	4: 2, // Constructor
	5: 3, // Field
	6: 4, // Variable
	7: 5, // Class
	8: 7, // Interface
	9: 8, // Module
	10: 9, // Property
	11: 12, // Unit
	12: 13, // Value
	13: 15, // Enum
	14: 17, // Keyword
	15: 28, // Snippet
	16: 19, // Color
	17: 20, // File
	18: 21, // Reference
	19: 23, // Folder
	20: 16, // EnumMember
	21: 14, // Constant
	22: 6, // Struct
	23: 10, // Event
	24: 11, // Operator
	25: 24 // TypeParameter
};
export function toCompletionKind(kind: number | undefined): number {
	return completionKinds[kind ?? 1] ?? 18;
}

const InsertAsSnippet = 4;
const SnippetFormat = 2;

type EditRange = MRange | { insert: MRange; replace: MRange };

function toEditRange(r: Range | { insert: Range; replace: Range }): EditRange {
	return 'insert' in r ? { insert: toMonacoRange(r.insert), replace: toMonacoRange(r.replace) } : toMonacoRange(r);
}

/** `fallback` is the word range at the cursor, used when the item has no edit range of its own. */
export function toCompletionItem(item: CompletionItem, fallback: MRange, defaults?: CompletionItemDefaults): Monaco.languages.CompletionItem {
	let range: EditRange = defaults?.editRange ? toEditRange(defaults.editRange) : fallback;
	let insertText = item.textEditText ?? item.insertText ?? item.label;
	if (item.textEdit) {
		range = 'range' in item.textEdit ? toMonacoRange(item.textEdit.range) : toEditRange(item.textEdit);
		insertText = item.textEdit.newText;
	}
	const format = item.insertTextFormat ?? defaults?.insertTextFormat;
	const deprecated = item.deprecated || item.tags?.includes(1);
	return {
		label: item.labelDetails ? { label: item.label, detail: item.labelDetails.detail, description: item.labelDetails.description } : item.label,
		kind: toCompletionKind(item.kind) as Monaco.languages.CompletionItemKind,
		tags: deprecated ? [1 as Monaco.languages.CompletionItemTag] : undefined,
		detail: item.detail,
		documentation: markupToMarkdown(item.documentation),
		sortText: item.sortText,
		filterText: item.filterText,
		preselect: item.preselect,
		insertText,
		insertTextRules: format === SnippetFormat ? (InsertAsSnippet as Monaco.languages.CompletionItemInsertTextRule) : undefined,
		range,
		commitCharacters: item.commitCharacters ?? defaults?.commitCharacters,
		additionalTextEdits: item.additionalTextEdits?.map((e) => ({ range: toMonacoRange(e.range), text: e.newText }))
	};
}

// --- Definition ------------------------------------------------------------------------------

export type Target = { uri: string; range: Range };

export function toTargets(result: Location | Location[] | LocationLink[] | null | undefined): Target[] {
	if (!result) return [];
	const list = Array.isArray(result) ? result : [result];
	return list.map((l) => ('targetUri' in l ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : { uri: l.uri, range: l.range }));
}

// --- Symbols ---------------------------------------------------------------------------------

/** LSP SymbolKind is 1-based and in the same order as monaco.languages.SymbolKind. */
export const toSymbolKind = (kind: number) => Math.max(0, kind - 1);

const isDocumentSymbol = (s: DocumentSymbol | SymbolInformation): s is DocumentSymbol => 'selectionRange' in s;

export function toMonacoSymbols(symbols: (DocumentSymbol | SymbolInformation)[]): Monaco.languages.DocumentSymbol[] {
	return symbols.map((s) =>
		isDocumentSymbol(s)
			? {
					name: s.name,
					detail: s.detail ?? '',
					kind: toSymbolKind(s.kind) as Monaco.languages.SymbolKind,
					tags: [],
					range: toMonacoRange(s.range),
					selectionRange: toMonacoRange(s.selectionRange),
					children: s.children ? toMonacoSymbols(s.children) : undefined
				}
			: {
					name: s.name,
					detail: '',
					kind: toSymbolKind(s.kind) as Monaco.languages.SymbolKind,
					tags: [],
					containerName: s.containerName,
					range: toMonacoRange(s.location.range),
					selectionRange: toMonacoRange(s.location.range)
				}
	);
}

export type Crumb = { name: string; kind: number; range: Range };

/** Symbols enclosing `pos`, outermost first (the breadcrumbs after the file name). */
export function symbolPath(symbols: (DocumentSymbol | SymbolInformation)[], pos: Position): Crumb[] {
	const out: Crumb[] = [];
	if (symbols.length && isDocumentSymbol(symbols[0])) {
		let level = symbols as DocumentSymbol[];
		for (;;) {
			const hit = level.find((s) => rangeContains(s.range, pos));
			if (!hit) break;
			out.push({ name: hit.name, kind: hit.kind, range: hit.selectionRange });
			level = hit.children ?? [];
		}
		return out;
	}
	const size = (r: Range) => (r.end.line - r.start.line) * 1e6 + (r.end.character - r.start.character);
	return (symbols as SymbolInformation[])
		.filter((s) => rangeContains(s.location.range, pos))
		.sort((a, b) => size(b.location.range) - size(a.location.range))
		.map((s) => ({ name: s.name, kind: s.kind, range: s.location.range }));
}

// --- Edits -----------------------------------------------------------------------------------

export function toMonacoTextEdits(edits: TextEdit[] | null | undefined): Monaco.languages.TextEdit[] {
	return (edits ?? []).map((e) => ({ range: toMonacoRange(e.range), text: e.newText }));
}

/** Where F2 starts and what it shows, from `textDocument/prepareRename`. `word` is the word at
 * the cursor, used for `defaultBehavior` and when the server has no prepare support. Null when
 * the element cannot be renamed. */
export function toRenameLocation(result: PrepareRenameResult | undefined, word: { range: MRange; text: string } | null, textIn: (r: MRange) => string): { range: MRange; text: string } | null {
	if (result === undefined) return word;
	if (result === null) return null;
	if ('defaultBehavior' in result) return result.defaultBehavior ? word : null;
	if ('placeholder' in result) return { range: toMonacoRange(result.range), text: result.placeholder };
	const range = toMonacoRange(result);
	return { range, text: textIn(range) };
}

// --- Signature help, highlights --------------------------------------------------------------

export function toSignatureHelp(h: SignatureHelp): Monaco.languages.SignatureHelp {
	return {
		signatures: h.signatures.map((s) => ({
			label: s.label,
			documentation: markupToMarkdown(s.documentation),
			parameters: (s.parameters ?? []).map((p) => ({ label: p.label, documentation: markupToMarkdown(p.documentation) })),
			activeParameter: s.activeParameter
		})),
		activeSignature: Math.max(0, Math.min(h.activeSignature ?? 0, h.signatures.length - 1)),
		activeParameter: h.activeParameter ?? 0
	};
}

/** Monaco's previous signature help back to LSP (the `activeSignatureHelp` of a retrigger). */
export function fromSignatureHelp(h: Monaco.languages.SignatureHelp): SignatureHelp {
	return {
		signatures: h.signatures.map((s) => ({ label: s.label, parameters: s.parameters.map((p) => ({ label: p.label })), activeParameter: s.activeParameter })),
		activeSignature: h.activeSignature,
		activeParameter: h.activeParameter
	};
}

/** LSP DocumentHighlightKind Text 1, Read 2, Write 3 → monaco 0, 1, 2. */
export function toDocumentHighlights(list: DocumentHighlight[] | null | undefined): Monaco.languages.DocumentHighlight[] {
	return (list ?? []).map((h) => ({ range: toMonacoRange(h.range), kind: Math.max(0, (h.kind ?? 1) - 1) as Monaco.languages.DocumentHighlightKind }));
}
