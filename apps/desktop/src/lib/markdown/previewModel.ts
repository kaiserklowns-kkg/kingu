// What the Markdown preview does with a link or an image, and which previews follow the active
// editor (VS Code: a preview is dynamic unless locked). Pure, so `bun test` covers it.

export type LinkTarget =
	| { kind: 'fragment'; fragment: string }
	/** A workspace file (`rel`), maybe with a header fragment. */
	| { kind: 'file'; rel: string; fragment: string }
	/** http(s) to this machine: opened in the browser. */
	| { kind: 'local'; url: string }
	/** http(s) and mailto elsewhere: opened by the system after Rust checks the scheme. */
	| { kind: 'external'; url: string }
	/** Any other scheme (javascript:, data:, file:…): never followed. */
	| { kind: 'blocked'; url: string };

const decode = (s: string) => {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
};

/** The folder part of a workspace key (`docs/a.md` → `docs/`, `/abs/a.md` → `/abs/`). */
const dirOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '');

/**
 * A relative or root-relative (`/x`) path against the Markdown file `docRel`; null when it climbs
 * out of its root. A key of another root folder is absolute: `/x` then needs that folder (`root`).
 */
export function resolvePath(docRel: string, path: string, root = ''): string | null {
	const absoluteDoc = docRel.startsWith('/');
	let base = dirOf(docRel);
	if (path.startsWith('/')) {
		if (absoluteDoc && !root) return null;
		base = absoluteDoc ? root : '';
	}
	const floor = absoluteDoc && root ? root.split('/').filter(Boolean).length : 0;
	const parts: string[] = [];
	for (const seg of [...base.split('/'), ...path.split('/')]) {
		if (seg === '..') {
			if (parts.length <= floor) return null;
			parts.pop();
		} else if (seg && seg !== '.') parts.push(seg);
	}
	if (!parts.length) return null;
	return (absoluteDoc ? '/' : '') + parts.join('/');
}

/** Classifies a link's `href` as written in the Markdown file `docRel`. */
export function linkTarget(docRel: string, href: string): LinkTarget {
	const h = href.trim();
	if (h.startsWith('#')) return { kind: 'fragment', fragment: decode(h.slice(1)) };
	if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$|\?|#)/i.test(h)) return { kind: 'local', url: h };
	if (/^(https?:\/\/|mailto:)/i.test(h)) return { kind: 'external', url: h };
	if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return { kind: 'blocked', url: h };
	const hash = h.indexOf('#');
	const pathPart = (hash >= 0 ? h.slice(0, hash) : h).split('?')[0];
	const fragment = hash >= 0 ? decode(h.slice(hash + 1)) : '';
	const rel = resolvePath(docRel, decode(pathPart));
	return rel === null ? { kind: 'blocked', url: h } : { kind: 'file', rel, fragment };
}

/** The workspace file an image's `src` names, or null for remote, data and other URLs (not loaded). */
export function imageRel(docRel: string, src: string): string | null {
	const s = src.trim();
	if (!s || /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//') || s.startsWith('#')) return null;
	return resolvePath(docRel, decode(s.split(/[?#]/)[0]));
}

/**
 * The previews that follow the newly active Markdown editor `active`: every unlocked preview of
 * another Markdown file shown in a group other than the active one (a preview in the active group
 * is hidden behind the editor). Returns old key → new key.
 */
export function followRemap(shown: { group: number; key: string }[], activeGroup: number, active: string, locked: ReadonlySet<string>, prefix: string, isMarkdown: (rel: string) => boolean): Map<string, string> {
	const out = new Map<string, string>();
	if (!isMarkdown(active)) return out;
	const next = prefix + active;
	for (const { group, key } of shown) {
		if (group === activeGroup || !key.startsWith(prefix) || locked.has(key) || key === next) continue;
		if (!isMarkdown(key.slice(prefix.length))) continue;
		out.set(key, next);
	}
	return out;
}
