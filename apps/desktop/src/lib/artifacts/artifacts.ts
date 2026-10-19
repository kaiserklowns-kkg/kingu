// Artifacts (src-tauri/src/artifacts): pages agents publish into a project, shown in a sandboxed
// preview. The types mirror Rust's `Meta` / `TeamArtifact`; the rest is pure (editor keys, the
// Markdown page, the preview frame's attributes, the preview's link messages), so `bun test`
// covers it.

import { Marked } from 'marked';

export type ArtifactFormat = 'html' | 'markdown';

export type ArtifactVersion = {
	version: number;
	created_at: number;
	format: ArtifactFormat;
	/** `index.html` or `index.md`. */
	entry: string;
	files: { path: string; size: number }[];
	/** `agent` or `cli`. */
	source: string;
};

export type ArtifactMeta = {
	id: string;
	title: string;
	description: string | null;
	created_at: number;
	updated_at: number;
	/** Oldest first; never empty. */
	versions: ArtifactVersion[];
	shared?: { server: string; version: number; shared_at: number } | null;
};

/** A teammate's shared artifact (team server `GET /v1/artifacts`; `html` only when fetched one by one). */
export type TeamArtifact = {
	artifact_id: string;
	title: string;
	description: string | null;
	format: ArtifactFormat;
	version: number;
	size_bytes: number;
	sha256: string;
	shared_by: string;
	shared_at: string;
	updated_at: string;
	html?: string;
};

/** The `artifact` agent event: the agent published version `version` of artifact `id` in project `root`. */
export type ArtifactEvent = { kind: 'artifact'; id: string; title: string; version: number; format: ArtifactFormat; root: string };

export const latest = (m: ArtifactMeta): ArtifactVersion => m.versions[m.versions.length - 1];

export const isArtifactId = (id: string) => /^[0-9a-f]{16}$/.test(id);

// ---------------------------------------------------------------------------------------------
// Editor keys

/** A project's artifact: `artifact:<id>:<root>`; a teammate's shared one: `artifact:team:<id>`. */
export const ARTIFACT_PREFIX = 'artifact:';
export type ArtifactRef = { team: false; id: string; root: string } | { team: true; id: string };

export const artifactKey = (root: string, id: string) => `${ARTIFACT_PREFIX}${id}:${root}`;
export const teamArtifactKey = (id: string) => `${ARTIFACT_PREFIX}team:${id}`;
export const isArtifactKey = (key: string) => parseArtifactKey(key) !== null;

export function parseArtifactKey(key: string): ArtifactRef | null {
	if (!key.startsWith(ARTIFACT_PREFIX)) return null;
	const rest = key.slice(ARTIFACT_PREFIX.length);
	const team = /^team:([0-9a-f]{16})$/.exec(rest);
	if (team) return { team: true, id: team[1] };
	const m = /^([0-9a-f]{16}):(\/.*)$/.exec(rest);
	return m ? { team: false, id: m[1], root: m[2] } : null;
}

// ---------------------------------------------------------------------------------------------
// The preview frame

/**
 * The iframe's `sandbox`: scripts only. Never `allow-same-origin` (the page would share an origin
 * it could script), `allow-top-navigation*`, `allow-popups*`, `allow-forms`, `allow-modals` or
 * `allow-downloads`. Rust adds the same sandbox as a CSP directive and its own network rules.
 */
export const PREVIEW_SANDBOX = 'allow-scripts';
/** No camera, microphone, location, clipboard, … for the page. */
export const PREVIEW_ALLOW = "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'; usb 'none'; serial 'none'; hid 'none'; bluetooth 'none'; payment 'none'";

/**
 * A web link the preview asks to open (Rust's injected click guard posts `{kinguArtifact: 'open',
 * href}`): the URL when it is http(s), else null. The caller must also check the message came from
 * its own frame (`event.source`).
 */
export function linkToOpen(data: unknown): string | null {
	if (!data || typeof data !== 'object') return null;
	const d = data as Record<string, unknown>;
	if (d.kinguArtifact !== 'open' || typeof d.href !== 'string' || d.href.length > 2048) return null;
	try {
		const url = new URL(d.href);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------------------------
// Markdown artifacts

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Unlike the editor's Markdown preview (workbench/markdown.ts) raw HTML and images stay: the page
// is shown only in the sandboxed artifact frame, under the artifact CSP.
const marked = new Marked({ gfm: true });

/** A Markdown artifact as the HTML page the preview, Export and Share show. `dark`: the app's theme. */
export function markdownPage(source: string, title: string, dark: boolean): string {
	const body = marked.parse(source, { async: false }) as string;
	const [fg, bg, muted, border, code] = dark ? ['#d4d4d4', '#1e1e1e', '#9d9d9d', '#3c3c3c', '#2a2a2a'] : ['#1f2328', '#ffffff', '#59636e', '#d1d9e0', '#f6f8fa'];
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
body{margin:0 auto;max-width:860px;padding:32px 24px;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Thai",sans-serif;color:${fg};background:${bg}}
a{color:#3b82f6}img{max-width:100%}hr{border:0;border-top:1px solid ${border}}
pre,code{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:${code};border-radius:6px}
code{padding:.15em .35em}pre{padding:12px 16px;overflow:auto}pre code{padding:0;background:none}
table{border-collapse:collapse}th,td{border:1px solid ${border};padding:6px 12px}
blockquote{margin:0;padding:0 1em;color:${muted};border-left:3px solid ${border}}
</style></head>
<body>
${body}
</body></html>
`;
}

// ---------------------------------------------------------------------------------------------
// Display

/** `12 KB`, `1.4 MB`. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const versionSize = (v: ArtifactVersion) => v.files.reduce((n, f) => n + f.size, 0);

/** Artifacts whose title or description has every word typed, most recently updated first. */
export function filterArtifacts(list: readonly ArtifactMeta[], query: string): ArtifactMeta[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return list
		.filter((m) => {
			const text = `${m.title} ${m.description ?? ''} ${m.id}`.toLowerCase();
			return words.every((w) => text.includes(w));
		})
		.sort((a, b) => b.updated_at - a.updated_at);
}
