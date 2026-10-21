// Non-text editors for workspace files (Orca's ImageViewer / MarkdownPreview, VS Code's image
// preview and Markdown: Open Preview): which editor keys they own. The renderer is markdown.ts.

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);

/** A workspace image opens in the image viewer instead of Monaco. */
export function isImagePath(key: string): boolean {
	const dot = key.lastIndexOf('.');
	return !key.includes(':') && dot > key.lastIndexOf('/') && IMAGE_EXTS.has(key.slice(dot + 1).toLowerCase());
}

export const isMarkdownPath = (key: string) => !key.includes(':') && /\.(md|markdown|mdx)$/i.test(key);
export const isCsvPath = (key: string) => !key.includes(':') && /\.(csv|tsv)$/i.test(key);
/** Files with a rendered preview next to their text (Open Preview / ⌘K V). */
export const hasPreview = (key: string) => isMarkdownPath(key) || isCsvPath(key);

/** Editor key of a Markdown preview: `preview:<rel>`. */
export const PREVIEW_PREFIX = 'preview:';
export const previewKey = (rel: string) => PREVIEW_PREFIX + rel;
export const isPreviewKey = (key: string) => key.startsWith(PREVIEW_PREFIX);
export const previewTarget = (key: string) => key.slice(PREVIEW_PREFIX.length);

/** Editor key of the combined diff of every change: `changes:` (the folder) or `changes:<task slug>`. */
export const CHANGES_PREFIX = 'changes:';
export const changesKey = (slug = '') => CHANGES_PREFIX + slug;
export const isChangesKey = (key: string) => key.startsWith(CHANGES_PREFIX);
/** The task of a `changes:` key ('' for the folder's, and for a commit's or a stash's: scm/rangeChanges.ts). */
export const changesSlug = (key: string) => (key.startsWith(`${CHANGES_PREFIX}@`) ? '' : key.slice(CHANGES_PREFIX.length));
