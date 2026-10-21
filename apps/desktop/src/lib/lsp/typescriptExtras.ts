// Extras of VS Code's TypeScript extension on top of typescript-language-server:
// - Update imports on file move / rename (`js/ts.updateImportsOnFileMove.enabled`): the server's
//   `workspace/willRenameFiles` (tsserver getEditsForFileRename) asked before the move, the edit
//   applied after it (VS Code's updatePathsOnRename.ts asks "Update imports?" the same way).
// - Go to Source Definition and Find File References: the server's `_typescript.goToSourceDefinition`
//   command and a `typescript.tsserverRequest` for tsserver's `fileReferences`.
// - Select TypeScript Version: the workspace's TypeScript (`node_modules/typescript/lib`, or
//   `js/ts.tsdk.path`) handed to the server as `initializationOptions.tsserver.path`.
// Pure, so bun tests cover it; lsp.svelte.ts talks to the server.

import type { Location, TextDocumentEdit, TextEdit, WorkspaceEdit } from './protocol';
import { readUnified, type Keys, type Lang, type SettingsReader } from './serverSettings';

export type UpdateImportsMode = 'prompt' | 'always' | 'never';
/** A rename or move as LSP's FileRename. */
export type FileRenameUris = { oldUri: string; newUri: string };

export const UPDATE_IMPORTS_KEYS: Keys = ['js/ts.updateImportsOnFileMove.enabled', 'typescript.updateImportsOnFileMove.enabled', 'javascript.updateImportsOnFileMove.enabled'];
export const TSDK_KEYS: Keys = ['js/ts.tsdk.path', 'typescript.tsdk', null];

/** typescript-language-server's commands (its src/commands.ts). */
export const SOURCE_DEFINITION_COMMAND = '_typescript.goToSourceDefinition';
export const TSSERVER_REQUEST_COMMAND = 'typescript.tsserverRequest';

const TS_JS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const JS = /\.(js|jsx|mjs|cjs)$/i;

/** Files whose imports tsserver tracks; a folder may hold some. */
export const mayHaveImports = (rel: string, isDir: boolean) => isDir || TS_JS.test(rel);

/** `js/ts.updateImportsOnFileMove.enabled` for a renamed path (its language's own key when the unified one is unset). */
export function updateImportsMode(r: SettingsReader, rel: string): UpdateImportsMode {
	const lang: Lang = JS.test(rel) ? 'javascript' : 'typescript';
	const v = readUnified<unknown>(r, UPDATE_IMPORTS_KEYS, lang);
	return v === 'always' || v === 'never' ? v : 'prompt';
}

const isTextDocumentEdit = (c: unknown): c is TextDocumentEdit => !!c && typeof c === 'object' && 'textDocument' in c && 'edits' in c;

/** An edit that changes nothing. */
export function isEmptyEdit(edit: WorkspaceEdit | null | undefined): boolean {
	if (!edit) return true;
	const changes = Object.values(edit.changes ?? {}).some((list) => list.length > 0);
	const documents = (edit.documentChanges ?? []).some((c) => !isTextDocumentEdit(c) || c.edits.length > 0);
	return !changes && !documents;
}

/** `uri` after the renames: a renamed file, or a file under a renamed folder, at its new place. */
export function renamedUri(uri: string, files: readonly FileRenameUris[]): string {
	for (const f of files) {
		if (uri === f.oldUri) return f.newUri;
		const dir = f.oldUri.replace(/\/$/, '') + '/';
		if (uri.startsWith(dir)) return f.newUri.replace(/\/$/, '') + '/' + uri.slice(dir.length);
	}
	return uri;
}

/**
 * Points an edit the server computed before the move at the files' new places (the moved file's
 * own imports change too). Versions of moved documents no longer hold, so they are dropped.
 */
export function remapEditUris(edit: WorkspaceEdit, files: readonly FileRenameUris[]): WorkspaceEdit {
	const out: WorkspaceEdit = { ...edit };
	if (edit.changes) {
		const changes: Record<string, TextEdit[]> = {};
		for (const [uri, edits] of Object.entries(edit.changes)) {
			const next = renamedUri(uri, files);
			changes[next] = [...(changes[next] ?? []), ...edits];
		}
		out.changes = changes;
	}
	if (edit.documentChanges)
		out.documentChanges = edit.documentChanges.map((c) => {
			if (!isTextDocumentEdit(c)) return c;
			const uri = renamedUri(c.textDocument.uri, files);
			return uri === c.textDocument.uri ? c : { ...c, textDocument: { uri, version: null } };
		});
	return out;
}

/** The files a path rename reports: the renamed paths' names, for the prompt. */
export function renameSubject(files: readonly FileRenameUris[]): string {
	const name = (uri: string) => decodeURIComponent(uri.replace(/\/$/, '').split('/').pop() ?? uri);
	return files.length === 1 ? name(files[0].oldUri) : String(files.length);
}

type TsLocation = { line: number; offset: number };
type FileReference = { file: string; start: TsLocation; end: TsLocation };

const isTsLocation = (v: unknown): v is TsLocation => !!v && typeof v === 'object' && Number.isInteger((v as TsLocation).line) && Number.isInteger((v as TsLocation).offset);

/** tsserver's `fileReferences` response (the body, or the whole response) as LSP locations, in order. */
export function fileReferenceLocations(response: unknown, toUri: (path: string) => string): Location[] {
	const body = response && typeof response === 'object' && 'body' in response ? (response as { body: unknown }).body : response;
	const refs = body && typeof body === 'object' ? (body as { refs?: unknown }).refs : undefined;
	if (!Array.isArray(refs)) return [];
	return refs
		.filter((r): r is FileReference => !!r && typeof r === 'object' && typeof r.file === 'string' && isTsLocation(r.start) && isTsLocation(r.end))
		.map((r) => ({
			uri: toUri(r.file),
			range: { start: { line: r.start.line - 1, character: r.start.offset - 1 }, end: { line: r.end.line - 1, character: r.end.offset - 1 } }
		}));
}

// --- Select TypeScript Version -------------------------------------------------------------------

export type TsVersionChoice = 'bundled' | 'workspace';

/** The workspace's TypeScript `lib` folder: `js/ts.tsdk.path` (or `typescript.tsdk`), else node_modules. */
export function workspaceTsdk(r: SettingsReader): string {
	const raw = readUnified<unknown>(r, TSDK_KEYS, 'typescript');
	const dir = typeof raw === 'string' ? raw.trim().replace(/\/tsserver\.js$/, '').replace(/\/+$/, '') : '';
	return dir || 'node_modules/typescript/lib';
}

/** The tsserver.js of a `lib` folder, absolute (a relative folder is under the first root folder). */
export function tsserverPath(root: string, lib: string): string {
	const dir = lib.startsWith('/') ? lib : `${root.replace(/\/+$/, '')}/${lib.replace(/^\.\//, '')}`;
	return `${dir}/tsserver.js`;
}

/**
 * The tsserver the server should run, or null for its own (bundled) one: the workspace version
 * when chosen, else a `js/ts.tsdk.path` from the user settings, which VS Code always uses.
 */
export function chosenTsserver(r: SettingsReader, choice: TsVersionChoice, root: string): string | null {
	if (choice === 'workspace') return root ? tsserverPath(root, workspaceTsdk(r)) : null;
	for (const key of [TSDK_KEYS[0], TSDK_KEYS[1]]) {
		const user = r.layer?.(key, 'user');
		if (typeof user === 'string' && user.trim().startsWith('/')) return tsserverPath(root, user.trim().replace(/\/tsserver\.js$/, '').replace(/\/+$/, ''));
	}
	return null;
}

/** The package.json next to a TypeScript `lib` folder. */
export const packageJsonOf = (lib: string) => `${lib.replace(/\/lib$/, '')}/package.json`;

/** The `version` of a TypeScript package.json, or null. */
export function packageVersion(json: string): string | null {
	try {
		const v = (JSON.parse(json) as { version?: unknown }).version;
		return typeof v === 'string' && v ? v : null;
	} catch {
		return null;
	}
}
