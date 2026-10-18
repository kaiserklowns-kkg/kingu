// What a chat request sends (VS Code's chat request with its variables): the typed text, then the
// attached files in one clearly delimited block (path, selected lines, and the content of small
// files), images as image blocks. And the reverse: a sent message split back into what the user
// typed and what was attached, so the request list shows the text with chips, not the block.
// Pure, so `bun test` covers it.

/** A file attached to a request: the active editor's (implicit), one picked with `#`, or a dropped one. */
export type ContextFile = {
	/** Workspace-relative, or absolute for a file outside the folder. */
	path: string;
	/** Selected lines (1-based, inclusive). */
	range?: { startLine: number; endLine: number };
	/** The file's (or the selection's) text, when it is small enough to send (`MAX_INLINE_BYTES`). */
	content?: string;
	/** VS Code's implicit context: the active editor, attached by default and removable. */
	implicit?: boolean;
};

/** Files up to this size go into the prompt; bigger ones are sent as a reference the agent can read. */
export const MAX_INLINE_BYTES = 32 * 1024;

export const CONTEXT_OPEN = '<attached-context>';
export const CONTEXT_CLOSE = '</attached-context>';

const byteLength = (s: string) => new TextEncoder().encode(s).length;
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const unattr = (s: string) => s.replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** `content` when it fits, else undefined (the file goes as a reference). */
export const inlineContent = (content: string | undefined): string | undefined => (content !== undefined && byteLength(content) <= MAX_INLINE_BYTES ? content : undefined);

/** Lines `startLine..endLine` of `text` (1-based, inclusive). */
export function linesOf(text: string, range: { startLine: number; endLine: number }): string {
	return text
		.split('\n')
		.slice(Math.max(0, range.startLine - 1), Math.max(range.startLine, range.endLine))
		.join('\n');
}

function fileBlock(f: ContextFile): string {
	const lines = f.range ? ` lines="${f.range.startLine}-${f.range.endLine}"` : '';
	const head = `<file path="${attr(f.path)}"${lines}`;
	const content = inlineContent(f.content);
	if (content === undefined) return `${head} />`;
	return `${head}>\n${content}${content.endsWith('\n') ? '' : '\n'}</file>`;
}

/** The prompt of a request: the text, then one `<attached-context>` block with every file (once each). */
export function assemblePrompt(text: string, files: readonly ContextFile[]): string {
	const seen = new Set<string>();
	const unique = files.filter((f) => {
		const key = `${f.path}:${f.range?.startLine ?? ''}-${f.range?.endLine ?? ''}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const body = text.trim();
	if (!unique.length) return body;
	const intro = 'Files the user attached (the selected lines when `lines` is set; read a file without content yourself):';
	return `${body}\n\n${CONTEXT_OPEN}\n${intro}\n${unique.map(fileBlock).join('\n')}\n${CONTEXT_CLOSE}`;
}

export type ParsedRequest = {
	/** What the user typed. */
	text: string;
	files: { path: string; range?: { startLine: number; endLine: number } }[];
	/** Names of the images sent with it. */
	images: string[];
};

// The agent host adds the image names to the message it echoes (host.ts `shownText`).
const IMAGES_LINE = /\n\n\[(?:แนบรูป|images?): ([^\]\n]*)\]$/;

/** A sent message → what the user typed, the attached files and images (for the request row). */
export function parseRequest(sent: string): ParsedRequest {
	let text = sent;
	let images: string[] = [];
	const img = IMAGES_LINE.exec(text);
	if (img) {
		images = img[1]
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		text = text.slice(0, img.index);
	}
	const files: ParsedRequest['files'] = [];
	const open = text.lastIndexOf(`\n\n${CONTEXT_OPEN}\n`);
	if (open >= 0 && text.trimEnd().endsWith(CONTEXT_CLOSE)) {
		const block = text.slice(open);
		for (const m of block.matchAll(/^<file path="([^"]*)"(?: lines="(\d+)-(\d+)")?/gm)) {
			files.push({ path: unattr(m[1]), ...(m[2] ? { range: { startLine: Number(m[2]), endLine: Number(m[3]) } } : {}) });
		}
		text = text.slice(0, open);
	}
	return { text: text.trim(), files, images };
}

/** The message without the image names the agent host appended: what Retry sends again. */
export const withoutImagesLine = (sent: string) => sent.replace(IMAGES_LINE, '');

/** A chip's label: the file name, plus `:12-20` for a selection. */
export function contextLabel(f: { path: string; range?: { startLine: number; endLine: number } }): string {
	const name = f.path.split('/').pop() || f.path;
	if (!f.range) return name;
	return f.range.startLine === f.range.endLine ? `${name}:${f.range.startLine}` : `${name}:${f.range.startLine}-${f.range.endLine}`;
}

/** A path for the prompt: relative to the workspace when the agent runs there, else absolute. */
export function promptPath(rel: string, root: string, agentRunsInRoot: boolean): string {
	if (rel.startsWith('/') || agentRunsInRoot) return rel;
	return `${root.replace(/\/+$/, '')}/${rel}`;
}

/** A dropped absolute path → workspace-relative when it is inside `root`. */
export function relativeTo(root: string | null, path: string): string {
	if (!root) return path;
	const base = root.replace(/\/+$/, '') + '/';
	return path.startsWith(base) ? path.slice(base.length) : path;
}

/** An editor key that is a workspace file (not a diff, preview, untitled, settings… editor). */
export const isFileKey = (key: string | null | undefined): key is string => !!key && !/^[a-zA-Z][\w+.-]*:/.test(key);

/**
 * The files of a request, ready for `assemblePrompt`: workspace files read through `read` (the
 * selected lines only when there is a selection), inlined when small, else sent as a reference;
 * files outside the folder (absolute paths) and unreadable ones are references.
 */
export async function resolveContext(
	files: readonly { path: string; range?: { startLine: number; endLine: number }; implicit?: boolean }[],
	read: (rel: string) => Promise<string>,
	toPromptPath: (rel: string) => string = (p) => p
): Promise<ContextFile[]> {
	return Promise.all(
		files.map(async (f): Promise<ContextFile> => {
			const base: ContextFile = { path: toPromptPath(f.path), ...(f.range ? { range: f.range } : {}), ...(f.implicit ? { implicit: true } : {}) };
			if (f.path.startsWith('/')) return base;
			try {
				const text = await read(f.path);
				const content = inlineContent(f.range ? linesOf(text, f.range) : text);
				return content === undefined ? base : { ...base, content };
			} catch {
				return base;
			}
		})
	);
}
