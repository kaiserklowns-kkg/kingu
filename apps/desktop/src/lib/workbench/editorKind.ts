// What an editor tab key is, for the views and status bar items that follow the active editor
// (VS Code: whether the active editor is a text editor with a model, and which providers it has).
// Pure.

import { isOutputKey } from '#lib/output/output.ts';
import { isDiffKey, isMergeKey } from './scm.ts';
import { isSearchEditorKey } from './searchEditor.ts';
import { isExternalKey } from './externalFiles.ts';
import { isUntitled } from './untitled.ts';

/** A key with no scheme: a workspace file. */
const isPlainFile = (key: string) => !/^[a-zA-Z][\w+.-]*:/.test(key);

/**
 * `file`: a text document (workspace, untitled, outside-the-workspace file) or a diff of one;
 * `search`: the Search Editor's results model; `text`: another text model (an Output channel);
 * `other`: an editor without a text model at the front (Settings, previews, chats…).
 */
export type EditorKind = 'file' | 'search' | 'text' | 'other';

export function editorKind(key: string | null | undefined): EditorKind {
	if (!key) return 'other';
	if (isSearchEditorKey(key)) return 'search';
	if (isPlainFile(key) || isUntitled(key) || isExternalKey(key) || isDiffKey(key) || isMergeKey(key)) return 'file';
	if (isOutputKey(key)) return 'text';
	return 'other';
}

/** The status bar's editor items (Ln/Col, indentation, encoding, EOL, language) show for text models. */
export const showsEditorStatus = (key: string | null | undefined) => editorKind(key) !== 'other';

/** Outline: only documents with a symbol provider ("The active editor cannot provide outline information."). */
export const providesOutline = (key: string | null | undefined) => editorKind(key) === 'file';
