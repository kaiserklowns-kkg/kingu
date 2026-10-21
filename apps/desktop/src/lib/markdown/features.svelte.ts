// Markdown language features in Monaco (VS Code's built-in Markdown Language Features): outline
// and breadcrumbs, `#` workspace symbols, folding, smart select, path / header / reference
// completions, Follow Link, Go to Definition, Find All References, Rename, link validation, link
// updates on file move, and drop / paste of files and URLs. The logic lives in the pure modules
// next to this one; this file only adapts it to Monaco and the workbench.

import { invoke } from '@tauri-apps/api/core';
import type * as Monaco from 'monaco-editor';
import { t } from '#lib/i18n/index.ts';
import { lsp } from '#lib/lsp/lsp.svelte.ts';
import { takeRenamePreview } from '#lib/lsp/refactorPreview.svelte.ts';
import { keyOfModelPath, modelPathOf, pathToUri } from '#lib/lsp/convert.ts';
import type { Diagnostic, TextEdit as LspTextEdit, WorkspaceEdit } from '#lib/lsp/protocol.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { fuzzyMatch } from '#lib/workbench/fuzzy.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { onDidMoveFiles } from '#lib/workbench/fileMoves.ts';
import { choose } from '#lib/workbench/messageBox.ts';
import { completionContext, contextFile, contextFolder, folderEntries, withExtensionStyle, type HeaderMode } from './completions.ts';
import { createsLinks, inCode, isMedia, linkPath, markdownForFiles, urlPaste, type SmartMode } from './insertLinks.ts';
import { baseOf, dirOf, FileIndex, globMatches, isMarkdownFile, linkHref, relativePath, resolveHref, validateDocument, type Level, type MdDiagnostic } from './links.ts';
import { linkAt, type Pos, type Range } from './parse.ts';
import { findReferences, linkEditsForMoves, renameEdits, renameRange, type FileEdits, type Move } from './references.ts';
import { documentSymbols, foldingRanges, selectionRanges, type MdSymbol } from './symbols.ts';
import { allDocuments, documentOf, fileIndex, invalidate, modelDocument } from './workspaceDocs.ts';

type MonacoApi = typeof Monaco;
type Model = Monaco.editor.ITextModel;

const LANGUAGE = 'markdown';
/** Follow Link targets: `kingu-md:/<rel>#<fragment>`; `L<n>` fragments are 1-based lines. */
const LINK_SCHEME = 'kingu-md';
const VALIDATE_DELAY_MS = 400;
const DIAGNOSTIC_OWNER = 'markdown';
const SEVERITY: Record<MdDiagnostic['level'], number> = { error: 1, warning: 2, hint: 4 };

let installed = false;
let api: MonacoApi;

/** Workspace key of a model, or null for a file outside the first root folder (or not a file). */
function relOf(model: Model): string | null {
	if (model.uri.scheme !== 'file') return null;
	const key = keyOfModelPath(model.uri.path, workspace.folders);
	return key.startsWith('/') ? null : key;
}

const toRange = (r: Range) => new api.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const toPos = (p: Monaco.IPosition): Pos => ({ line: p.lineNumber - 1, character: p.column - 1 });
const modelUri = (rel: string) => api.Uri.file(modelPathOf(rel));
const absPath = (rel: string) => `${(workspace.root ?? '').replace(/\/$/, '')}/${rel}`;

/** Every document, with the open model's text for `rel`. */
async function docsWith(model: Model, rel: string) {
	const docs = await allDocuments();
	docs.set(rel, modelDocument(model));
	return docs;
}

/** Called for every code editor (editorAttach.ts). */
export function attachMarkdown(monaco: MonacoApi, editor: Monaco.editor.IStandaloneCodeEditor) {
	install(monaco);
	attachDropAndPaste(editor);
}

function install(monaco: MonacoApi) {
	if (installed) return;
	installed = true;
	api = monaco;
	const L = monaco.languages;

	L.registerDocumentSymbolProvider(LANGUAGE, {
		displayName: 'Markdown',
		provideDocumentSymbols: (model) => {
			const convert = (s: MdSymbol): Monaco.languages.DocumentSymbol => ({
				name: s.name,
				detail: '',
				kind: L.SymbolKind.String,
				tags: [],
				range: toRange(s.range),
				selectionRange: toRange(s.selectionRange),
				children: s.children.map(convert)
			});
			return documentSymbols(modelDocument(model)).map(convert);
		}
	});

	L.registerFoldingRangeProvider(LANGUAGE, {
		provideFoldingRanges: (model) =>
			foldingRanges(modelDocument(model)).map((f) => ({
				start: f.start + 1,
				end: f.end + 1,
				kind: f.kind === 'region' ? L.FoldingRangeKind.Region : f.kind === 'comment' ? L.FoldingRangeKind.Comment : undefined
			}))
	});

	L.registerSelectionRangeProvider(LANGUAGE, {
		provideSelectionRanges: (model, positions) => positions.map((p) => selectionRanges(modelDocument(model), toPos(p)).map((r) => ({ range: toRange(r) })))
	});

	L.registerCompletionItemProvider(LANGUAGE, {
		triggerCharacters: ['.', '/', '#', '['],
		provideCompletionItems: async (model, position) => provideCompletions(model, position)
	});

	L.registerLinkProvider(LANGUAGE, {
		provideLinks: async (model) => {
			const rel = relOf(model);
			if (rel === null) return { links: [] };
			const doc = modelDocument(model);
			const index = await fileIndex();
			const links: Monaco.languages.ILink[] = [];
			for (const link of doc.links) {
				if (link.kind === 'reference') {
					const def = doc.definitions.get(link.ref!)?.[0];
					if (def) links.push({ range: toRange(link.hrefRange), url: linkUri(rel, `L${def.range.start.line + 1}`), tooltip: t('markdown.link.definition') });
					continue;
				}
				const target = resolveHref(link.href, rel, index);
				if (!target) continue;
				if (target.kind === 'external') {
					if (/^(https?|mailto):/i.test(target.url)) links.push({ range: toRange(link.hrefRange), url: target.url, tooltip: t('markdown.link.follow') });
				} else if (target.kind === 'fragment') links.push({ range: toRange(link.hrefRange), url: linkUri(rel, target.fragment), tooltip: t('markdown.link.follow') });
				else if (target.exists && !target.dir) links.push({ range: toRange(link.hrefRange), url: linkUri(target.rel, target.fragment ?? ''), tooltip: t('markdown.link.follow') });
			}
			return { links };
		}
	});
	monaco.editor.registerLinkOpener({ open: (uri) => (uri.scheme === LINK_SCHEME ? (void followLink(uri), true) : false) });

	L.registerDefinitionProvider(LANGUAGE, {
		provideDefinition: async (model, position) => {
			const rel = relOf(model);
			if (rel === null) return null;
			const doc = modelDocument(model);
			const link = linkAt(doc, toPos(position));
			if (!link) return null;
			if (link.kind === 'reference') {
				const def = doc.definitions.get(link.ref!)?.[0];
				return def ? { uri: model.uri, range: toRange(def.range) } : null;
			}
			const href = linkHref(doc, link);
			const target = href === null ? null : resolveHref(href, rel, await fileIndex());
			if (!target || target.kind === 'external') return null;
			const targetRel = target.kind === 'fragment' ? rel : target.rel;
			if (target.kind === 'file' && (!target.exists || target.dir)) return null;
			const fragment = target.fragment;
			const targetDoc = targetRel === rel ? doc : isMarkdownFile(targetRel) ? await documentOf(targetRel) : null;
			const header = fragment ? targetDoc?.headers.find((h) => h.slug.toLowerCase() === fragment.toLowerCase()) : undefined;
			if (targetRel !== rel) await lsp.ensurePreviewModels([targetRel]);
			const at = header ? toRange(header.range) : new api.Range(1, 1, 1, 1);
			return { uri: modelUri(targetRel), range: at };
		}
	});

	L.registerReferenceProvider(LANGUAGE, {
		provideReferences: async (model, position, context) => {
			const rel = relOf(model);
			if (rel === null) return [];
			const locations = findReferences(await docsWith(model, rel), await fileIndex(), rel, toPos(position), context.includeDeclaration);
			await lsp.ensurePreviewModels([...new Set(locations.map((l) => l.rel))], { dropOthers: true });
			return locations.map((l) => ({ uri: modelUri(l.rel), range: toRange(l.range) }));
		}
	});

	L.registerRenameProvider(LANGUAGE, {
		resolveRenameLocation: async (model, position) => {
			const rel = relOf(model);
			const found = rel === null ? null : renameRange(await docsWith(model, rel), await fileIndex(), rel, toPos(position));
			if (!found) return { range: new api.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: '', rejectReason: t('markdown.rename.cantRename') };
			return { range: toRange(found.range), text: found.text };
		},
		provideRenameEdits: async (model, position, newName) => {
			const preview = takeRenamePreview();
			const rel = relOf(model);
			const edits = rel === null ? null : renameEdits(await docsWith(model, rel), await fileIndex(), rel, toPos(position), newName);
			if (!edits) return { edits: [], rejectReason: t('markdown.rename.cantRename') };
			// Applied here (like the language servers' renames) so files with no tab change on disk too.
			const r = await lsp.applyWorkspaceEdit(toWorkspaceEdit(edits), { refactoring: true, preview, label: t('markdown.rename.label', { name: newName }) });
			if (r.cancelled) return { edits: [] };
			if (!r.applied) return { edits: [], rejectReason: r.failureReason ?? '' };
			invalidate();
			status.flash(t('markdown.rename.done', { name: newName, edits: r.edits, files: r.uris.length }));
			return { edits: [] };
		}
	});

	lsp.addWorkspaceSymbolSource(async (query) => {
		const q = query.replace(/^#+\s*/, '');
		const out = [];
		for (const [rel, doc] of await allDocuments())
			for (const h of doc.headers) {
				const name = `${'#'.repeat(h.level)} ${h.text}`;
				if (q && !fuzzyMatch(q, h.text)) continue;
				out.push({ name, kind: 15 /* String */, container: rel, rel, line: h.line + 1, column: 1 });
			}
		return out;
	});

	// Link validation of open Markdown models (markdown.validate.*).
	const timers = new WeakMap<Model, ReturnType<typeof setTimeout>>();
	const watched = new Set<Model>();
	const schedule = (model: Model) => {
		clearTimeout(timers.get(model));
		timers.set(
			model,
			setTimeout(() => void validate(model), VALIDATE_DELAY_MS)
		);
	};
	const watch = (model: Model) => {
		if (watched.has(model)) return;
		watched.add(model);
		model.onDidChangeContent(() => model.getLanguageId() === LANGUAGE && schedule(model));
		model.onDidChangeLanguage(() => schedule(model));
		model.onWillDispose(() => {
			watched.delete(model);
			clearTimeout(timers.get(model));
			const rel = relOf(model);
			if (rel !== null && reported.has(model)) lsp.setOwnedDiagnostics(DIAGNOSTIC_OWNER, absPath(rel), []);
		});
		schedule(model);
	};
	for (const m of monaco.editor.getModels()) watch(m);
	monaco.editor.onDidCreateModel(watch);
	// Any markdown.validate.* change re-validates every open document.
	$effect.root(() => {
		$effect(() => {
			validateOptions();
			for (const m of watched) schedule(m);
		});
	});

	onDidMoveFiles((moves) => void updateLinksAfterMove(moves));
}

// --- Follow Link -----------------------------------------------------------------------------------

const linkUri = (rel: string, fragment: string) => api.Uri.from({ scheme: LINK_SCHEME, path: '/' + rel, fragment });

async function followLink(uri: Monaco.Uri) {
	const rel = uri.path.replace(/^\//, '');
	let line = 1;
	const lineMatch = /^L(\d+)$/i.exec(uri.fragment);
	if (lineMatch) line = Number(lineMatch[1]);
	else if (uri.fragment && isMarkdownFile(rel)) {
		const doc = await documentOf(rel);
		const header = doc?.headers.find((h) => h.slug.toLowerCase() === uri.fragment.toLowerCase());
		if (header) line = header.line + 1;
	}
	if (settings.get<string>('markdown.links.openLocation') === 'beside' && editors.active !== rel) editors.openToSide(rel, { line, column: 1, focus: true });
	else editors.openFromCodeNavigation(rel, line, 1);
}

// --- Completions -----------------------------------------------------------------------------------

async function provideCompletions(model: Model, position: Monaco.Position): Promise<Monaco.languages.CompletionList> {
	const none = { suggestions: [] };
	const rel = relOf(model);
	if (rel === null || !settings.get<boolean>('markdown.suggest.paths.enabled')) return none;
	const prefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
	const doc = modelDocument(model);
	if (doc.codeLines.has(position.lineNumber - 1)) return none;
	const ctx = completionContext(prefix, settings.get<HeaderMode>('markdown.suggest.paths.includeWorkspaceHeaderCompletions'));
	if (!ctx) return none;
	const K = api.languages.CompletionItemKind;
	const range = new api.Range(position.lineNumber, ctx.from + 1, position.lineNumber, position.column);
	const style = settings.get<'auto' | 'includeExtension' | 'removeExtension'>('markdown.preferredMdPathExtensionStyle');
	const suggestions: Monaco.languages.CompletionItem[] = [];
	const workspaceHeaders = async () => {
		for (const [other, d] of await allDocuments()) {
			if (other === rel) continue;
			const path = linkPath(withExtensionStyle(relativePath(dirOf(rel), other), style));
			for (const h of d.headers)
				suggestions.push({ label: `#${h.slug}`, detail: t('markdown.completion.workspaceHeader', { path: other }), kind: K.Reference, insertText: `${path}#${h.slug}`, filterText: `##${h.text}`, range: ctx.kind === 'workspaceHeader' ? range : new api.Range(position.lineNumber, ctx.from, position.lineNumber, position.column), sortText: `z${other}` });
		}
	};
	switch (ctx.kind) {
		case 'header':
			for (const h of doc.headers) suggestions.push({ label: `#${h.slug}`, detail: t('markdown.completion.header'), documentation: h.text, kind: K.Reference, insertText: h.slug, filterText: h.slug, range });
			if (ctx.workspace) await workspaceHeaders();
			break;
		case 'workspaceHeader':
			await workspaceHeaders();
			break;
		case 'fileHeader': {
			const target = contextFile(ctx, rel, await fileIndex());
			const d = target && isMarkdownFile(target) ? await documentOf(target) : null;
			for (const h of d?.headers ?? []) suggestions.push({ label: `#${h.slug}`, documentation: h.text, kind: K.Reference, insertText: h.slug, range });
			break;
		}
		case 'reference':
			for (const [label, defs] of doc.definitions) suggestions.push({ label: defs[0].text || label, detail: t('markdown.completion.definition', { href: defs[0].href }), kind: K.Reference, insertText: defs[0].text || label, range });
			break;
		case 'path': {
			const folder = contextFolder(ctx, rel);
			if (folder === null) break;
			const index = await fileIndex();
			for (const e of folderEntries(index, folder)) {
				if (e.name.startsWith('.') && !ctx.typed.startsWith('.')) continue;
				const name = linkPath(e.name);
				suggestions.push(
					e.dir
						? { label: e.name + '/', kind: K.Folder, insertText: name + '/', range, command: { id: 'editor.action.triggerSuggest', title: '' } }
						: { label: e.name, kind: K.File, insertText: withExtensionStyle(name, style), range }
				);
			}
			break;
		}
	}
	return { suggestions };
}

// --- Validation ------------------------------------------------------------------------------------

function level(id: string): Level {
	return settings.get<Level>(id) ?? 'ignore';
}

function validateOptions() {
	const fragmentLinks = level('markdown.validate.fragmentLinks.enabled');
	const md = settings.get<Level | 'inherit'>('markdown.validate.fileLinks.markdownFragmentLinks');
	return {
		enabled: settings.get<boolean>('markdown.validate.enabled'),
		opts: {
			referenceLinks: level('markdown.validate.referenceLinks.enabled'),
			fragmentLinks,
			fileLinks: level('markdown.validate.fileLinks.enabled'),
			markdownFragmentLinks: md === 'inherit' ? fragmentLinks : md,
			unusedLinkDefinitions: level('markdown.validate.unusedLinkDefinitions.enabled'),
			duplicateLinkDefinitions: level('markdown.validate.duplicateLinkDefinitions.enabled'),
			ignoredLinks: settings.get<string[]>('markdown.validate.ignoredLinks') ?? []
		}
	};
}

/** Models whose problems are in the Problems view. */
const reported = new WeakSet<Model>();

async function validate(model: Model) {
	if (model.isDisposed()) return;
	const rel = relOf(model);
	if (rel === null || !workspace.root) return;
	const { enabled, opts } = validateOptions();
	const markdown = model.getLanguageId() === LANGUAGE;
	// Other languages' models only need clearing once, after a switch away from Markdown.
	if (!markdown && !reported.has(model)) return;
	let items: Diagnostic[] = [];
	if (enabled && markdown) {
		const version = model.getVersionId();
		const found = await validateDocument(modelDocument(model), rel, await fileIndex(), opts, documentOf);
		if (model.isDisposed() || model.getVersionId() !== version) return;
		items = found.map((d) => ({
			range: { start: d.range.start, end: d.range.end },
			severity: SEVERITY[d.level],
			code: d.code,
			source: 'markdown',
			message: t(`markdown.validate.${d.message}`, d.params as never),
			tags: d.message === 'unusedDefinition' ? [1] : undefined
		}));
	}
	if (items.length) reported.add(model);
	else if (!reported.delete(model)) return;
	lsp.setRoot(workspace.root);
	lsp.setOwnedDiagnostics(DIAGNOSTIC_OWNER, absPath(rel), items);
}

// --- Edits -----------------------------------------------------------------------------------------

function toWorkspaceEdit(edits: FileEdits): WorkspaceEdit {
	const changes: Record<string, LspTextEdit[]> = {};
	for (const [rel, list] of edits) changes[pathToUri(absPath(rel))] = list.map((e) => ({ range: e.range, newText: e.newText }));
	return { changes };
}

// --- Link updates on file move ---------------------------------------------------------------------

async function updateLinksAfterMove(moves: Move[]) {
	invalidate();
	const mode = settings.get<'prompt' | 'always' | 'never'>('markdown.updateLinksOnFileMove.enabled');
	if (mode === 'never' || !workspace.root) return;
	const after = await fileIndex();
	const include = settings.get<string[]>('markdown.updateLinksOnFileMove.include') ?? [];
	const relevant = moves.filter((m) => (after.dirs.has(m.to) && !after.files.has(m.to) ? settings.get<boolean>('markdown.updateLinksOnFileMove.enableForDirectories') : include.some((g) => globMatches(g, m.to) || globMatches(g, '/' + m.to))));
	if (!relevant.length) return;
	// The documents and files as they were before the move.
	const back = (rel: string) => {
		for (const m of relevant) {
			if (rel === m.to) return m.from;
			if (rel.startsWith(m.to + '/')) return m.from + rel.slice(m.to.length);
		}
		return rel;
	};
	const before = new FileIndex([...after.files].map(back));
	const docs = new Map([...(await allDocuments())].map(([rel, doc]) => [back(rel), doc]));
	const edits = linkEditsForMoves(docs, before, relevant);
	const count = [...edits.values()].reduce((n, l) => n + l.length, 0);
	if (!count) return;
	const name = baseOf(relevant[0].to);
	if (mode === 'prompt') {
		const update = t('markdown.updateLinks.update');
		const always = t('markdown.updateLinks.always');
		const answer = await choose(`${t('markdown.updateLinks.question', { name })}\n\n${t('markdown.updateLinks.detail', { count, files: edits.size })}`, {
			buttons: [update, always, t('markdown.updateLinks.skip')],
			cancelId: 2
		});
		if (answer === always) await settings.set('markdown.updateLinksOnFileMove.enabled', 'always', 'user');
		else if (answer !== update) return;
	}
	const r = await lsp.applyWorkspaceEdit(toWorkspaceEdit(edits), { refactoring: true, label: t('markdown.updateLinks.label', { name }) });
	if (r.cancelled) return;
	if (!r.applied) return status.error(t('markdown.updateLinks.failed', { reason: r.failureReason ?? '' }));
	invalidate();
	status.flash(t('markdown.updateLinks.done', { count: r.edits }));
}

// --- Drop and paste --------------------------------------------------------------------------------

const DRAG_MIME = 'application/x-kingu-explorer';

function attachDropAndPaste(editor: Monaco.editor.IStandaloneCodeEditor) {
	const node = editor.getContainerDomNode();
	const markdownModel = () => {
		const model = editor.getModel();
		return model && model.getLanguageId() === LANGUAGE && relOf(model) !== null ? model : null;
	};
	const insertAt = (position: Monaco.IPosition | null, text: string) => {
		const sel = position ? new api.Range(position.lineNumber, position.column, position.lineNumber, position.column) : editor.getSelection();
		if (!sel) return;
		editor.pushUndoStop();
		editor.executeEdits('markdown.insertLinks', [{ range: sel, text, forceMoveMarkers: true }]);
		editor.pushUndoStop();
		editor.focus();
	};
	const smart = (model: Model, position: Monaco.IPosition, setting: string) => {
		const code = inCode(modelDocument(model), position.lineNumber - 1, model.getLineContent(position.lineNumber).slice(0, position.column - 1));
		return createsLinks(settings.get<SmartMode>(setting), code);
	};

	// Explorer files dragged in with Shift held (VS Code: Shift to drop into the editor).
	node.addEventListener(
		'dragover',
		(e) => {
			if (e.shiftKey && markdownModel() && e.dataTransfer?.types.includes(DRAG_MIME)) {
				e.preventDefault();
				e.stopPropagation();
			}
		},
		true
	);
	node.addEventListener(
		'drop',
		(e) => {
			const model = markdownModel();
			const raw = e.dataTransfer?.getData(DRAG_MIME);
			if (!model || !raw || !e.shiftKey) return;
			const target = editor.getTargetAtClientPoint(e.clientX, e.clientY)?.position ?? editor.getPosition();
			if (!target || !smart(model, target, 'markdown.editor.drop.enabled')) return;
			e.preventDefault();
			e.stopPropagation();
			const paths = (JSON.parse(raw) as string[]).filter((p) => !p.startsWith('/'));
			if (paths.length) insertAt(target, markdownForFiles(paths.map((rel) => ({ rel })), relOf(model)!));
		},
		true
	);

	// Files from Finder arrive as Tauri drag-drop events: media files are copied next to the document
	// (markdown.editor.drop.copyIntoWorkspace), then linked.
	let stop: (() => void) | undefined;
	let disposed = false;
	void import('@tauri-apps/api/webview')
		.then(({ getCurrentWebview }) =>
			getCurrentWebview().onDragDropEvent((ev) => {
				const p = ev.payload;
				if (p.type !== 'drop' || !p.paths.length) return;
				const model = markdownModel();
				if (!model) return;
				const pos = p.position.toLogical(window.devicePixelRatio || 1);
				const r = node.getBoundingClientRect();
				if (pos.x < r.left || pos.x > r.right || pos.y < r.top || pos.y > r.bottom) return;
				const target = editor.getTargetAtClientPoint(pos.x, pos.y)?.position ?? editor.getPosition();
				if (!target || !smart(model, target, 'markdown.editor.drop.enabled')) return;
				void dropExternal(model, p.paths, settings.get<string>('markdown.editor.drop.copyIntoWorkspace')).then((text) => text && insertAt(target, text));
			})
		)
		.then((u) => (disposed ? u() : (stop = u)))
		.catch(() => {});
	editor.onDidDispose(() => {
		disposed = true;
		stop?.();
	});

	// Paste: a URL over a selection becomes a link; absolute paths of workspace files become links.
	node.addEventListener(
		'paste',
		(e) => {
			const model = markdownModel();
			const sel = editor.getSelection();
			const text = e.clipboardData?.getData('text/plain') ?? '';
			if (!model || !sel || !text || !editor.hasTextFocus()) return;
			const position = sel.getStartPosition();
			const code = inCode(modelDocument(model), position.lineNumber - 1, model.getLineContent(position.lineNumber).slice(0, position.column - 1));
			let out = urlPaste(text, model.getValueInRange(sel), settings.get('markdown.editor.pasteUrlAsFormattedLink.enabled'), code);
			if (out === null && createsLinks(settings.get<SmartMode>('markdown.editor.filePaste.enabled'), code)) {
				const root = (workspace.root ?? '').replace(/\/$/, '') + '/';
				const lines = text.split(/\r?\n/).map((l) => l.trim().replace(/^file:\/\//, '')).filter(Boolean);
				if (workspace.root && lines.length && lines.every((l) => l.startsWith(root))) out = markdownForFiles(lines.map((l) => ({ rel: decodeURIComponent(l.slice(root.length)) })), relOf(model)!);
			}
			if (out === null) return;
			e.preventDefault();
			e.stopPropagation();
			editor.pushUndoStop();
			editor.executeEdits('markdown.paste', [{ range: sel, text: out, forceMoveMarkers: true }]);
			editor.pushUndoStop();
		},
		true
	);
}

/** Links for files dropped from outside: workspace files as they are, media copied in (or linked by file URL). */
async function dropExternal(model: Model, paths: string[], copy: string | undefined): Promise<string | null> {
	const rel = relOf(model);
	const root = workspace.root ? workspace.root.replace(/\/$/, '') + '/' : null;
	if (rel === null) return null;
	const files: ({ rel: string } | { abs: string })[] = [];
	for (const path of paths) {
		if (root && path.startsWith(root)) {
			files.push({ rel: path.slice(root.length) });
			continue;
		}
		if (copy === 'mediaFiles' && isMedia(path)) {
			try {
				const [created] = await invoke<string[]>('fs_import', { paths: [path], toDir: dirOf(rel), naming: 'simple' });
				if (created) {
					files.push({ rel: created });
					invalidate();
					continue;
				}
			} catch (e) {
				status.error(t('markdown.drop.copyFailed', { name: baseOf(path), error: String(e) }));
			}
		}
		files.push({ abs: path });
	}
	return markdownForFiles(files, rel);
}
