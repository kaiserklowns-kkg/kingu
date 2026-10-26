// Untitled Markdown editors of the Agents layout (Orca's New Markdown): an in-memory buffer that
// Save As writes. Only the language hint lives here; the text is the IDE's shared model.

import { isMarkdownPath } from '#lib/workbench/viewers.ts';

const untitled = new Set<string>();

export const markUntitledMarkdown = (key: string) => void untitled.add(key);
export const forgetUntitledMarkdown = (key: string) => void untitled.delete(key);

/** A tab whose text is Markdown: a `.md` file or an untitled buffer made by New Markdown. */
export const isMarkdownEditor = (key: string) => isMarkdownPath(key) || untitled.has(key);
