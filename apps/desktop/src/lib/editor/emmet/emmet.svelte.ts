// Emmet in Monaco (VS Code: the built-in emmet extension): expanded abbreviations in IntelliSense
// (`emmet.showExpandedAbbreviation`, `emmet.showAbbreviationSuggestions`,
// `emmet.showSuggestionsAsSnippets`), Tab expansion (`emmet.triggerExpansionOnTab`), and the
// Emmet commands of the palette. The rules and text work are pure (emmetConfig.ts, markup.ts,
// textActions.ts); this file is the editor glue.

import type * as Monaco from 'monaco-editor';
import { t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { activeCodeEditor, writableEditor } from '../activeEditor.ts';
import { abbreviationAt, ALL_TRIGGER_CHARACTERS, emmetSyntax, expandAbbreviation, isAbbreviationValid, isExpansionNoise, isMarkupOrStylesheetLanguage, isStylesheet, isValidLocation, markupSnippets, snippetPreview, TRIGGER_CHARACTERS, type EmmetSettings } from './emmetConfig.ts';
import { balanceIn, balanceOut, elementAt, innerRange, markupItems, matchingTag, mergeLines, parseMarkup, removeTag, splitJoinTag, stepItem, toggleMarkupComment, updateTag, type TextEdit } from './markup.ts';
import { addToNumber, cssItems, editPoint, evaluate, formatResult, mathExpressionBefore, numberAt, toggleCssComment } from './textActions.ts';

type MonacoApi = typeof Monaco;
type Model = Monaco.editor.ITextModel;
type SnippetController = { insert(template: string, opts?: { overwriteBefore?: number; overwriteAfter?: number }): void };

/** Files larger than this are not parsed for the embedded `<style>` / `<script>` check. */
const PARSE_LIMIT = 200_000;
/** `<script type="…">` whose content is markup (VS Code allowedMimeTypesInScriptTag). */
const MARKUP_SCRIPT_TYPES = ['text/html', 'text/plain', 'text/x-template', 'text/template', 'text/ng-template'];

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function emmetSettings(): EmmetSettings {
	return {
		includeLanguages: obj(settings.get('emmet.includeLanguages')),
		excludeLanguages: settings.get<string[]>('emmet.excludeLanguages') ?? [],
		variables: obj(settings.get('emmet.variables')),
		syntaxProfiles: obj(settings.get('emmet.syntaxProfiles')),
		preferences: obj(settings.get('emmet.preferences'))
	};
}

/** The syntax at an offset: inside an HTML `<style>` it is css; inside a JavaScript `<script>` none. */
function syntaxAt(model: Model, offset: number, syntax: string): string | undefined {
	if (syntax !== 'html' || model.getValueLength() > PARSE_LIMIT) return syntax;
	const el = elementAt(parseMarkup(model.getValue()), offset);
	if (!el?.close) return syntax;
	const [s, e] = innerRange(el);
	if (offset < s || offset > e) return syntax;
	const name = el.name.toLowerCase();
	if (name === 'style') return 'css';
	if (name === 'script') {
		const text = model.getValue();
		const type = el.open.attributes.find((a) => a.name === 'type');
		const value = type?.valueStart !== undefined ? text.slice(type.valueStart, type.valueEnd) : '';
		return MARKUP_SCRIPT_TYPES.includes(value) ? 'html' : undefined;
	}
	return syntax;
}

type Expansion = { abbreviation: string; syntax: string; snippet: string; start: number; end: number };

/** The abbreviation that would expand at the position, with its expansion, or undefined. */
function expansionAt(model: Model, position: Monaco.IPosition, s: EmmetSettings, opts: { forTab?: boolean } = {}): Expansion | undefined {
	const base = emmetSyntax(model.getLanguageId(), s);
	if (!base) return undefined;
	const syntax = syntaxAt(model, model.getOffsetAt(position), base);
	if (!syntax) return undefined;
	const line = model.getLineContent(position.lineNumber);
	const found = abbreviationAt(line, position.column, syntax);
	if (!found || !isAbbreviationValid(syntax, found.abbreviation)) return undefined;
	const fromLine = Math.max(1, position.lineNumber - 40);
	const before = model.getValueInRange({ startLineNumber: fromLine, startColumn: 1, endLineNumber: position.lineNumber, endColumn: found.start });
	if (!isValidLocation(syntax, before, found.abbreviation)) return undefined;
	const snippet = expandAbbreviation(found.abbreviation, syntax, s);
	if (!snippet) return undefined;
	// Tab expands only what would be suggested (a plain word like `foo` stays a word).
	if (opts.forTab && isExpansionNoise(syntax, found.abbreviation, snippet, s)) return undefined;
	return { abbreviation: found.abbreviation, syntax, snippet, start: found.start, end: found.end };
}

function insertSnippet(editor: Monaco.editor.ICodeEditor, snippet: string, opts?: { overwriteBefore?: number; overwriteAfter?: number }) {
	editor.getContribution<Monaco.editor.IEditorContribution & SnippetController>('snippetController2')?.insert(snippet, opts);
}

/** Expand Abbreviation at the cursor (or the selected text as the abbreviation). */
function expandAtCursor(editor: Monaco.editor.ICodeEditor): boolean {
	const model = editor.getModel();
	const sel = editor.getSelection();
	if (!model || !sel) return false;
	const s = emmetSettings();
	if (!sel.isEmpty()) {
		const syntax = emmetSyntax(model.getLanguageId(), s) ?? 'html';
		const snippet = expandAbbreviation(model.getValueInRange(sel).trim(), syntax, s);
		if (!snippet) return false;
		insertSnippet(editor, snippet);
		return true;
	}
	const exp = expansionAt(model, sel.getPosition(), s);
	if (!exp) return false;
	insertSnippet(editor, exp.snippet, { overwriteBefore: sel.positionColumn - exp.start, overwriteAfter: Math.max(0, exp.end - sel.positionColumn) });
	return true;
}

/** Common leading whitespace off every line (the text Wrap with Abbreviation puts inside). */
function dedent(text: string): string[] {
	const lines = text.split(/\r?\n/);
	const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
	const cut = indents.length ? Math.min(...indents) : 0;
	return lines.map((l) => l.slice(cut)).filter((l, i, all) => l.trim() || (i > 0 && i < all.length - 1));
}

/** The range Wrap with Abbreviation wraps: the selection, else the element at the cursor (markup), else the line. */
function wrapRange(model: Model, sel: Monaco.Selection, syntax: string): Monaco.IRange {
	if (!sel.isEmpty()) return sel;
	if (!isStylesheet(syntax) && model.getValueLength() <= PARSE_LIMIT) {
		const el = elementAt(parseMarkup(model.getValue()), model.getOffsetAt(sel.getPosition()));
		if (el) {
			const a = model.getPositionAt(el.start);
			const b = model.getPositionAt(el.end);
			return { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column };
		}
	}
	const line = model.getLineContent(sel.startLineNumber);
	const lead = line.length - line.trimStart().length;
	return { startLineNumber: sel.startLineNumber, startColumn: lead + 1, endLineNumber: sel.startLineNumber, endColumn: line.trimEnd().length + 1 };
}

async function wrapWithAbbreviation() {
	const editor = writableEditor();
	const model = editor?.getModel();
	const sel = editor?.getSelection();
	if (!editor || !model || !sel) return;
	const s = emmetSettings();
	const syntax = emmetSyntax(model.getLanguageId(), s) ?? 'html';
	if (isStylesheet(syntax)) return status.flash(t('editing.emmet.notInStylesheet'));
	const range = wrapRange(model, sel, syntax);
	const lines = dedent(model.getValueInRange(range));
	const abbreviation = await quick.input({
		placeholder: t('editing.emmet.enterAbbreviation'),
		hint: (v) => {
			const out = v.trim() && expandAbbreviation(v.trim(), syntax, s, lines);
			return out ? snippetPreview(out).replace(/\s*\n\s*/g, ' ') : t('editing.emmet.enterAbbreviationHint');
		}
	});
	if (!abbreviation) return;
	const snippet = expandAbbreviation(abbreviation, syntax, s, lines);
	if (!snippet) return status.flash(t('editing.emmet.invalid', { abbreviation }));
	editor.focus();
	editor.setSelection(range);
	insertSnippet(editor, snippet);
}

/** Runs a markup action on the model text. */
function withMarkup(run: (editor: Monaco.editor.ICodeEditor, model: Model, text: string, m: ReturnType<typeof parseMarkup>) => void, writable = false) {
	return () => {
		const editor = writable ? writableEditor() : activeCodeEditor();
		const model = editor?.getModel();
		if (!editor || !model) return;
		const s = emmetSettings();
		const syntax = emmetSyntax(model.getLanguageId(), s);
		if (syntax && isStylesheet(syntax)) return status.flash(t('editing.emmet.notInStylesheet'));
		if (model.getValueLength() > PARSE_LIMIT) return status.flash(t('editing.emmet.tooLarge'));
		const text = model.getValue();
		run(editor, model, text, parseMarkup(text));
	};
}

const toRange = (model: Model, start: number, end: number): Monaco.IRange => {
	const a = model.getPositionAt(start);
	const b = model.getPositionAt(end);
	return { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column };
};

function applyEdits(editor: Monaco.editor.ICodeEditor, model: Model, edits: TextEdit[], source: string) {
	if (!edits.length) return;
	editor.pushUndoStop();
	editor.executeEdits(source, edits.map((e) => ({ range: toRange(model, e.start, e.end), text: e.text })));
	editor.pushUndoStop();
}

/** Offsets of each selection, anchor-independent ([start, end]). */
const selectionOffsets = (editor: Monaco.editor.ICodeEditor, model: Model) => (editor.getSelections() ?? []).map((sel) => [model.getOffsetAt(sel.getStartPosition()), model.getOffsetAt(sel.getEndPosition())] as [number, number]);

function setSelections(editor: Monaco.editor.ICodeEditor, model: Model, ranges: ([number, number] | undefined)[], fallback: Monaco.Selection[]) {
	const api = monacoRef;
	if (!api) return;
	const sels = ranges.map((r, i) => (r ? api.Selection.fromPositions(model.getPositionAt(r[0]), model.getPositionAt(r[1])) : fallback[i]));
	editor.setSelections(sels);
	editor.revealRangeInCenterIfOutsideViewport(sels[sels.length - 1]);
}

const balance = (direction: 'in' | 'out') =>
	withMarkup((editor, model, _text, m) => {
		const current = editor.getSelections() ?? [];
		setSelections(editor, model, selectionOffsets(editor, model).map(([s, e]) => (direction === 'out' ? balanceOut(m, s, e) : balanceIn(m, s, e))), current);
	});

const matchTag = withMarkup((editor, model, _text, m) => {
	const current = editor.getSelections() ?? [];
	setSelections(editor, model, selectionOffsets(editor, model).map(([s]) => {
		const to = matchingTag(m, s);
		return to === undefined ? undefined : [to, to];
	}), current);
});

/** Edits for each cursor, the later ones first so earlier offsets stay right; overlapping ones dropped. */
function perCursor(editor: Monaco.editor.ICodeEditor, model: Model, make: (s: number, e: number) => TextEdit[]): TextEdit[] {
	const all = selectionOffsets(editor, model).flatMap(([s, e]) => make(s, e)).sort((a, b) => b.start - a.start);
	const out: TextEdit[] = [];
	for (const e of all) if (!out.some((o) => e.start < o.end && o.start < e.end)) out.push(e);
	return out;
}

const removeTagCommand = withMarkup((editor, model, text, m) => applyEdits(editor, model, perCursor(editor, model, (s) => removeTag(text, m, s)), 'emmet.removeTag'), true);

async function updateTagCommand() {
	const editor = writableEditor();
	const model = editor?.getModel();
	if (!editor || !model) return;
	const text = model.getValue();
	const m = parseMarkup(text);
	const current = elementAt(m, model.getOffsetAt(editor.getPosition()!));
	const name = await quick.input({ placeholder: t('editing.emmet.enterTag'), value: current?.name, hint: (v) => (v.trim() ? t('editing.emmet.updateTo', { name: v.trim() }) : t('editing.emmet.removeTagHint')) });
	if (name === undefined) return;
	editor.focus();
	applyEdits(editor, model, perCursor(editor, model, (s) => updateTag(text, m, s, name.trim())), 'emmet.updateTag');
}

const splitJoin = withMarkup((editor, model, text, m) => {
	const syntax = emmetSyntax(model.getLanguageId(), emmetSettings()) ?? 'html';
	applyEdits(editor, model, perCursor(editor, model, (s) => splitJoinTag(text, m, s, syntax)), 'emmet.splitJoinTag');
}, true);

const mergeLinesCommand = withMarkup((editor, model, text, m) => {
	applyEdits(editor, model, perCursor(editor, model, (s, e) => {
		const edit = mergeLines(text, m, s, e);
		return edit ? [edit] : [];
	}), 'emmet.mergeLines');
}, true);

function toggleComment() {
	const editor = writableEditor();
	const model = editor?.getModel();
	if (!editor || !model) return;
	const syntax = emmetSyntax(model.getLanguageId(), emmetSettings()) ?? 'html';
	const text = model.getValue();
	if (isStylesheet(syntax)) return applyEdits(editor, model, perCursor(editor, model, (s, e) => [toggleCssComment(text, s, e)].filter((x): x is TextEdit => !!x)), 'emmet.toggleComment');
	if (text.length > PARSE_LIMIT) return status.flash(t('editing.emmet.tooLarge'));
	const m = parseMarkup(text);
	applyEdits(editor, model, perCursor(editor, model, (s, e) => toggleMarkupComment(text, m, s, e)), 'emmet.toggleComment');
}

function selectItem(direction: 1 | -1) {
	const editor = activeCodeEditor();
	const model = editor?.getModel();
	if (!editor || !model) return;
	const syntax = emmetSyntax(model.getLanguageId(), emmetSettings()) ?? 'html';
	const text = model.getValue();
	if (text.length > PARSE_LIMIT) return status.flash(t('editing.emmet.tooLarge'));
	const items = isStylesheet(syntax) ? cssItems(text) : markupItems(text, parseMarkup(text));
	setSelections(editor, model, selectionOffsets(editor, model).map(([s, e]) => stepItem(items, s, e, direction)), editor.getSelections() ?? []);
}

function editPointCommand(direction: 1 | -1) {
	const editor = activeCodeEditor();
	const model = editor?.getModel();
	if (!editor || !model) return;
	const lines = model.getLinesContent();
	const current = editor.getSelections() ?? [];
	const ranges = current.map((sel): [number, number] | undefined => {
		const p = editPoint(lines, sel.positionLineNumber - 1, sel.positionColumn - 1, direction);
		if (!p) return undefined;
		const off = model.getOffsetAt({ lineNumber: p[0] + 1, column: p[1] + 1 });
		return [off, off];
	});
	setSelections(editor, model, ranges, current);
}

function incrementBy(delta: number) {
	const editor = writableEditor();
	const model = editor?.getModel();
	if (!editor || !model) return;
	const edits: Monaco.editor.IIdentifiedSingleEditOperation[] = [];
	for (const sel of editor.getSelections() ?? []) {
		const line = model.getLineContent(sel.positionLineNumber);
		const r = numberAt(line, sel.positionColumn - 1);
		if (!r) continue;
		edits.push({ range: { startLineNumber: sel.positionLineNumber, startColumn: r[0] + 1, endLineNumber: sel.positionLineNumber, endColumn: r[1] + 1 }, text: addToNumber(line.slice(r[0], r[1]), delta) });
	}
	if (!edits.length) return;
	editor.pushUndoStop();
	editor.executeEdits('emmet.incrementDecrement', edits);
	editor.pushUndoStop();
}

function evaluateMath() {
	const editor = writableEditor();
	const model = editor?.getModel();
	if (!editor || !model) return;
	const edits: Monaco.editor.IIdentifiedSingleEditOperation[] = [];
	for (const sel of editor.getSelections() ?? []) {
		if (!sel.isEmpty()) {
			const v = evaluate(model.getValueInRange(sel));
			if (v !== undefined) edits.push({ range: sel, text: formatResult(v) });
			continue;
		}
		const line = model.getLineContent(sel.positionLineNumber);
		const r = mathExpressionBefore(line, sel.positionColumn - 1);
		const v = r && evaluate(line.slice(r[0], r[1]));
		if (r && v !== undefined) edits.push({ range: { startLineNumber: sel.positionLineNumber, startColumn: r[0] + 1, endLineNumber: sel.positionLineNumber, endColumn: r[1] + 1 }, text: formatResult(v) });
	}
	if (!edits.length) return status.flash(t('editing.emmet.noMath'));
	editor.pushUndoStop();
	editor.executeEdits('emmet.evaluateMathExpression', edits);
	editor.pushUndoStop();
}

/** What each Emmet command runs (emmetCommands.svelte.ts registers them and loads this file on first use). */
export const EMMET_ACTIONS: Readonly<Record<string, () => unknown>> = {
	'editor.emmet.action.expandAbbreviation': () => {
		const editor = writableEditor();
		if (editor && !expandAtCursor(editor)) status.flash(t('editing.emmet.nothingToExpand'));
	},
	'editor.emmet.action.wrapWithAbbreviation': wrapWithAbbreviation,
	'editor.emmet.action.removeTag': removeTagCommand,
	'editor.emmet.action.updateTag': updateTagCommand,
	'editor.emmet.action.matchTag': matchTag,
	'editor.emmet.action.balanceIn': balance('in'),
	'editor.emmet.action.balanceOut': balance('out'),
	'editor.emmet.action.prevEditPoint': () => editPointCommand(-1),
	'editor.emmet.action.nextEditPoint': () => editPointCommand(1),
	'editor.emmet.action.mergeLines': mergeLinesCommand,
	'editor.emmet.action.selectPrevItem': () => selectItem(-1),
	'editor.emmet.action.selectNextItem': () => selectItem(1),
	'editor.emmet.action.splitJoinTag': splitJoin,
	'editor.emmet.action.toggleComment': toggleComment,
	'editor.emmet.action.evaluateMathExpression': evaluateMath,
	'editor.emmet.action.incrementNumberByOneTenth': () => incrementBy(0.1),
	'editor.emmet.action.incrementNumberByOne': () => incrementBy(1),
	'editor.emmet.action.incrementNumberByTen': () => incrementBy(10),
	'editor.emmet.action.decrementNumberByOneTenth': () => incrementBy(-0.1),
	'editor.emmet.action.decrementNumberByOne': () => incrementBy(-1),
	'editor.emmet.action.decrementNumberByTen': () => incrementBy(-10)
};

let monacoRef: MonacoApi | undefined;
let providerInstalled = false;

function installProvider(monaco: MonacoApi) {
	if (providerInstalled) return;
	providerInstalled = true;
	monaco.languages.registerCompletionItemProvider('*', {
		triggerCharacters: ALL_TRIGGER_CHARACTERS,
		provideCompletionItems(model, position, context) {
			const show = settings.get<string>('emmet.showExpandedAbbreviation');
			if (show === 'never') return { suggestions: [] };
			if (show === 'inMarkupAndStylesheetFilesOnly' && !isMarkupOrStylesheetLanguage(model.getLanguageId())) return { suggestions: [] };
			const s = emmetSettings();
			const exp = expansionAt(model, position, s);
			if (!exp) return { suggestions: [] };
			const trigger = context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? context.triggerCharacter : undefined;
			if (trigger && !TRIGGER_CHARACTERS[exp.syntax]?.includes(trigger)) return { suggestions: [] };
			const asSnippet = settings.get<boolean>('emmet.showSuggestionsAsSnippets');
			const ln = position.lineNumber;
			const range = { insert: new monaco.Range(ln, exp.start, ln, position.column), replace: new monaco.Range(ln, exp.start, ln, Math.max(position.column, exp.end)) };
			const item = (label: string, snippet: string): Monaco.languages.CompletionItem => ({
				label,
				kind: asSnippet ? monaco.languages.CompletionItemKind.Snippet : monaco.languages.CompletionItemKind.Property,
				detail: t('editing.emmet.abbreviation'),
				documentation: { value: '```' + (isStylesheet(exp.syntax) ? 'css' : 'html') + '\n' + snippetPreview(snippet) + '\n```' },
				insertText: snippet,
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				filterText: label,
				range
			});
			const suggestions: Monaco.languages.CompletionItem[] = [];
			if (!isExpansionNoise(exp.syntax, exp.abbreviation, exp.snippet, s)) suggestions.push(item(exp.abbreviation, exp.snippet));
			// emmet's own snippet names that continue what was typed (`a:` → a:link, a:mail…).
			if (settings.get<boolean>('emmet.showAbbreviationSuggestions') && !isStylesheet(exp.syntax) && /^[\w:!-]+$/.test(exp.abbreviation)) {
				for (const name of markupSnippets(exp.syntax)) {
					if (name === exp.abbreviation || !name.startsWith(exp.abbreviation)) continue;
					const snippet = expandAbbreviation(name, exp.syntax, s);
					if (snippet) suggestions.push(item(name, snippet));
				}
			}
			// Typing on changes the abbreviation: ask again instead of filtering this list.
			return { suggestions, incomplete: true };
		}
	});
	// emmet.useInlineCompletions: the expansion as an inline suggestion too (VS Code's emmet inline provider).
	monaco.languages.registerInlineCompletionsProvider('*', {
		provideInlineCompletions(model, position) {
			if (!settings.get<boolean>('emmet.useInlineCompletions') || settings.get<string>('emmet.showExpandedAbbreviation') === 'never') return { items: [] };
			const s = emmetSettings();
			const exp = expansionAt(model, position, s, { forTab: true });
			if (!exp) return { items: [] };
			const ln = position.lineNumber;
			return { items: [{ insertText: { snippet: exp.snippet }, range: new monaco.Range(ln, exp.start, ln, Math.max(position.column, exp.end)) }] };
		},
		disposeInlineCompletions() {}
	});
}

/** Per editor: Tab expands the abbreviation at the cursor when `emmet.triggerExpansionOnTab` is on. */
export function attachEmmet(monaco: MonacoApi, editor: Monaco.editor.IStandaloneCodeEditor) {
	monacoRef = monaco;
	installProvider(monaco);
	const canExpand = editor.createContextKey<boolean>('kingu.emmetCanExpand', false);
	const update = () => {
		const model = editor.getModel();
		const sel = editor.getSelection();
		const on = !!model && !!sel && sel.isEmpty() && settings.get<boolean>('emmet.triggerExpansionOnTab');
		canExpand.set(on && !!expansionAt(model!, sel!.getPosition(), emmetSettings(), { forTab: true }));
	};
	editor.onDidChangeCursorSelection(update);
	editor.onDidChangeModel(update);
	editor.addCommand(
		monaco.KeyCode.Tab,
		() => {
			if (!expandAtCursor(editor)) editor.trigger('keyboard', 'tab', null);
		},
		'editorTextFocus && kingu.emmetCanExpand && !kingu.hasSnippetCompletions && !editorTabMovesFocus && !inSnippetMode && !suggestWidgetVisible && !inlineSuggestionVisible && !editorReadonly'
	);
}
