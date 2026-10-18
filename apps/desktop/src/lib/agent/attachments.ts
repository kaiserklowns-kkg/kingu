// Attachments for agents, the Orca way. Pure, so `bun test` covers it.
// - Composer (timeline): images become image blocks (Rust/agent host read them), other files go
//   into the text as `@path` references (Orca's formatNativeChatFileReference).
// - CLI terminal: a pasted image is saved by Rust and its path pasted (bracketed); dropped files
//   are typed as paths: images as a bracketed paste with Claude/codex-safe backslash escapes,
//   other files shell-quoted with a trailing space (Orca's terminal-drop-path-writer).

/** Image types a timeline message can carry (Claude's). */
export const COMPOSER_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;
/** Image files Orca pastes into a terminal as images (`shared/image-file-extensions.ts`). */
const TERMINAL_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'];
/** Orca's drop limits: at most 256 paths, 256 KiB of path bytes. */
export const MAX_DROP_PATHS = 256;
const MAX_DROP_BYTES = 256 * 1024;

export type Attachment = { path: string; name: string; image: boolean };

const extOf = (path: string) => (path.split('/').pop()?.split('.').pop() ?? '').toLowerCase();
export const baseName = (path: string) => path.split('/').pop() || path;

export function attachmentOf(path: string): Attachment {
	return { path, name: baseName(path), image: (COMPOSER_IMAGE_EXTS as readonly string[]).includes(extOf(path)) };
}

/** Adds dropped/picked paths once each, absolute ones only. */
export function addAttachments(list: readonly Attachment[], paths: readonly string[]): Attachment[] {
	const have = new Set(list.map((a) => a.path));
	const out = [...list];
	for (const p of paths.slice(0, MAX_DROP_PATHS)) {
		if (!p.startsWith('/') || have.has(p)) continue;
		have.add(p);
		out.push(attachmentOf(p));
	}
	return out;
}

/** Orca's `@path` file reference: bare, `@"…"` with a space or `@`, `@'…'` with a `"`, escaped with both. */
export function fileReference(path: string): string {
	if (!/[\s@"']/.test(path)) return `@${path}`;
	if (!path.includes('"')) return `@"${path}"`;
	if (!path.includes("'")) return `@'${path}'`;
	return `@"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** What a message sends: the text with non-image files referenced, and the image paths. */
export function composeMessage(text: string, attachments: readonly Attachment[]): { text: string; images: string[] } {
	const files = attachments.filter((a) => !a.image).map((a) => fileReference(a.path));
	return { text: files.length ? `${text}\n\n${files.join(' ')}` : text, images: attachments.filter((a) => a.image).map((a) => a.path) };
}

/** A terminal-mode prompt: the CLI gets every attachment as a path reference in the text. */
export function promptWithAttachments(text: string, attachments: readonly Attachment[]): string {
	return attachments.length ? `${text}\n\n${attachments.map((a) => fileReference(a.path)).join(' ')}` : text;
}

// ---- terminal --------------------------------------------------------------------------------

const bracketed = (s: string) => `\x1b[200~${s.replace(/\x1b/g, '␛')}\x1b[201~`;

/** A pasted image's saved path, as Orca pastes it: raw, bracketed. */
export const pastedImageText = (path: string) => bracketed(path);

/** Orca's shellEscapePath (POSIX): plain paths stay, others go in single quotes. */
export function shellEscapePath(path: string): string {
	return /^[a-zA-Z0-9_./@:-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Orca's drop image path: raw unless it has shell-special characters, then backslash-escaped
 *  (Claude strips one outer quote pair only, codex splits an unquoted path with spaces). */
export function dropImagePath(path: string): string {
	return /[ "'`$;&|<>(){}[\]*?!#\\]/.test(path) ? path.replace(/[^a-zA-Z0-9_./@:\-\u0080-￿]/g, '\\$&') : path;
}

/** What a drop of `paths` types into a terminal; null when there is nothing to type. */
export function terminalDropText(paths: readonly string[]): string | null {
	const list = paths.filter((p) => p && !/[\x00-\x1f\x7f]/.test(p)).slice(0, MAX_DROP_PATHS);
	if (!list.length || list.join('').length > MAX_DROP_BYTES) return null;
	let out = '';
	let prevImage: boolean | null = null;
	for (const p of list) {
		const image = TERMINAL_IMAGE_EXTS.includes(extOf(p));
		// Items are space-separated, except two image pastes in a row (a file brings its own space).
		if (image) out += bracketed(dropImagePath(p));
		else {
			if (prevImage === true) out += ' ';
			out += `${shellEscapePath(p)} `;
		}
		prevImage = image;
	}
	return out;
}
