// Arkai's WebFetch: Claude Code's tool name and input (`url`, `prompt`), so the chat's rows and
// cards, and Rust's `chat.tools.urls.autoApprove` rules (agent/tool_rules), treat it like
// Claude's. The page comes back as text (HTML reduced to its readable text; the model reads it
// with the `prompt` in mind — no second model call as in Claude Code). Capped in time and size; a
// redirect to another host is not followed but reported, so that URL is approved on its own.

import { cap, type ToolResult } from './tools.ts';

/** How long one fetch may take, and how much of a response is read. */
export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const fail = (content: string): ToolResult => ({ content, isError: true });

/** `url` when it is an http(s) URL Arkai may fetch, else why not. */
export function fetchableUrl(raw: unknown): URL | string {
	if (typeof raw !== 'string' || !raw.trim()) return 'Invalid arguments: missing required string `url`';
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		return `Not a URL: ${raw}`;
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return `Only http and https URLs can be fetched (not ${u.protocol})`;
	if (u.username || u.password) return 'URLs with a user name or password are not fetched';
	return u;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»' };

function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === '#') {
			const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
		}
		return ENTITIES[e.toLowerCase()] ?? m;
	});
}

/** An HTML page's readable text: no scripts, styles or tags; blocks on their own lines, list items as `- `, links with their URL. */
export function htmlToText(html: string): string {
	let s = html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<(script|style|noscript|template|svg|head|iframe)\b[\s\S]*?<\/\1\s*>/gi, '')
		.replace(/<a\b[^>]*?\bhref\s*=\s*(["'])([^"']*)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, _q, href: string, text: string) => {
			const inner = text.replace(/<[^>]+>/g, '').trim();
			return inner && href && !href.startsWith('#') && !href.startsWith('javascript:') && inner !== href ? `${inner} (${href})` : inner;
		})
		.replace(/<li\b[^>]*>/gi, '\n- ')
		.replace(/<(br|hr)\b[^>]*>/gi, '\n')
		.replace(/<\/?(p|div|section|article|header|footer|nav|main|aside|h[1-6]|ul|ol|table|tr|blockquote|pre|dl|dt|dd|figure|figcaption|form)\b[^>]*>/gi, '\n')
		.replace(/<\/(td|th)\s*>/gi, '\t')
		.replace(/<[^>]+>/g, '');
	s = decodeEntities(s);
	return s
		.split('\n')
		.map((l) => l.replace(/[ \t ]+/g, ' ').trim())
		.filter((l, i, all) => l || (i > 0 && all[i - 1]))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** The body as text, read up to `max` bytes (the rest is not downloaded). */
async function readCapped(res: Response, max: number): Promise<{ text: string; cut: boolean }> {
	if (!res.body) return { text: '', cut: false };
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let cut = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (size + value.length > max) {
			chunks.push(value.subarray(0, max - size));
			size = max;
			cut = true;
			await reader.cancel().catch(() => {});
			break;
		}
		chunks.push(value);
		size += value.length;
	}
	const all = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) {
		all.set(c, at);
		at += c.length;
	}
	return { text: new TextDecoder().decode(all), cut };
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|javascript|ld\+json|x-ndjson)|[^;]*\+json|[^;]*\+xml)/i;

/** Runs WebFetch (never throws). `fetchFn`: the network (tests pass a fake). */
export async function webFetch(input: Record<string, unknown>, signal: AbortSignal, fetchFn: typeof fetch = fetch): Promise<ToolResult> {
	const first = fetchableUrl(input.url);
	if (typeof first === 'string') return fail(first);
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const both = AbortSignal.any([signal, timeout]);
	let url = first;
	try {
		for (let hop = 0; ; hop++) {
			const res = await fetchFn(url.href, { redirect: 'manual', signal: both, headers: { accept: 'text/html, text/plain, application/json, */*;q=0.5', 'user-agent': 'Kingu-Arkai/1 (WebFetch)' } });
			if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
				const next = new URL(res.headers.get('location')!, url);
				await res.body?.cancel().catch(() => {});
				if (next.host !== url.host || (next.protocol !== 'https:' && next.protocol !== 'http:')) {
					return { content: `${url.href} redirects to another host: ${next.href}\nFetch that URL to follow it (it is approved on its own).`, isError: false };
				}
				if (hop >= MAX_REDIRECTS) return fail(`Too many redirects (last: ${next.href})`);
				url = next;
				continue;
			}
			const type = res.headers.get('content-type') ?? '';
			if (!res.ok) {
				const { text } = await readCapped(res, 4096);
				return fail(`HTTP ${res.status} ${res.statusText} from ${url.href}${text.trim() ? `\n${cap(/html/i.test(type) ? htmlToText(text) : text, 2000)}` : ''}`);
			}
			if (type && !TEXT_TYPES.test(type)) {
				await res.body?.cancel().catch(() => {});
				return fail(`${url.href} is not a text page (${type.split(';')[0]})`);
			}
			const { text, cut } = await readCapped(res, MAX_FETCH_BYTES);
			const body = /html/i.test(type) || (!type && /^\s*<(!doctype|html)/i.test(text)) ? htmlToText(text) : text;
			const head = `${url.href}${url.href !== first.href ? ` (redirected from ${first.href})` : ''}`;
			const note = cut ? `\n… (only the first ${MAX_FETCH_BYTES} bytes were read)` : '';
			return { content: cap(`${head}\n\n${body || '(empty page)'}${note}`), isError: false };
		}
	} catch (e) {
		if (signal.aborted) return fail('Interrupted');
		if (timeout.aborted) return fail(`Timed out after ${FETCH_TIMEOUT_MS / 1000} s: ${url.href}`);
		return fail(`Could not fetch ${url.href}: ${e instanceof Error ? e.message : String(e)}`);
	}
}
