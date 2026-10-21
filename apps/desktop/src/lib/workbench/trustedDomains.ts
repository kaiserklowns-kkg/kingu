// Outgoing link protection (VS Code's trustedDomains, docs editing/editingevolved.md): pure rules
// for trustedDomains.svelte.ts. A web link opens without asking when its domain is trusted:
//
// - `*` trusts every link (protection off);
// - `https://example.com` trusts that scheme and host (any path), not its subdomains or another port;
// - `https://*.example.com` trusts example.com and every subdomain of it;
// - `example.com` (no scheme) trusts the host over http and https;
// - `https://example.com:*` any port, `https://example.com/docs` that path and below,
//   `https://example.com/api/*` anything under /api/ (not /api itself);
// - localhost, 127.0.0.1 and [::1] are always trusted; a link with a user name or password
//   (`https://github.com@evil.example`) never is.
//
// URLs are compared after the WHATWG URL parser resolved them (lowercase and punycode hosts,
// `..` segments, backslashes), so `https://example.com/docs/../admin` is not under `/docs`.

const LOCALHOST = /^(.+\.)?localhost$|^127\.0\.0\.1$|^\[::1\]$/i;

type Pattern = { scheme: string | null; host: string; wildcard: boolean; port: string | null; path: string };

/** A web link (http or https): the only links the protection asks about. */
export const isWebLink = (url: string): boolean => /^https?:\/\//i.test(url.trim());

function parsePattern(raw: string): Pattern | null {
	let rest = raw.trim().replace(/\\/g, '/');
	if (!rest) return null;
	let scheme: string | null = null;
	const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
	if (m) {
		scheme = m[1].toLowerCase();
		rest = rest.slice(m[0].length);
	}
	const slash = rest.indexOf('/');
	let authority = slash < 0 ? rest : rest.slice(0, slash);
	let path = slash < 0 ? '' : rest.slice(slash);
	if (!authority || authority.includes('@')) return null;
	let port: string | null = null;
	const p = /:(\d+|\*)$/.exec(authority);
	if (p) {
		port = p[1];
		authority = authority.slice(0, -p[0].length);
	}
	const wildcard = authority.startsWith('*.');
	let host = wildcard ? authority.slice(2) : authority;
	if (host !== '*') {
		try {
			host = new URL(`https://${host}`).hostname;
		} catch {
			return null;
		}
	}
	if (path && !path.includes('*')) {
		try {
			path = new URL(`https://x${path}`).pathname;
		} catch {
			return null;
		}
	}
	return { scheme, host, wildcard, port: port === null || port === '*' ? port : String(Number(port)), path: path.replace(/\/+$/, '') };
}

function pathMatches(pattern: string, path: string): boolean {
	if (!pattern) return true;
	if (!pattern.includes('*')) return path === pattern || path.startsWith(pattern + '/');
	const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
	return re.test(path);
}

/** Whether `url` may open without asking, with `trusted` the user's trusted domains. */
export function isUrlTrusted(url: string, trusted: readonly string[]): boolean {
	if (trusted.includes('*')) return true;
	let u: URL;
	try {
		u = new URL(url.trim());
	} catch {
		return false;
	}
	if (u.username || u.password) return false;
	if (LOCALHOST.test(u.hostname)) return true;
	const scheme = u.protocol.replace(/:$/, '');
	for (const raw of trusted) {
		const p = parsePattern(raw);
		if (!p) continue;
		if (p.scheme !== null && p.scheme !== scheme) continue;
		if (p.host !== '*' && !(u.hostname === p.host || (p.wildcard && u.hostname.endsWith('.' + p.host)))) continue;
		if (p.port !== '*' && (p.port ?? '') !== u.port) continue;
		if (pathMatches(p.path, u.pathname)) return true;
	}
	return false;
}

/** What "Configure Trusted Domains" offers for `url`: the exact link (without query), the domain with its subdomains. */
export function trustOptions(url: string): { exact: string; domain: string } | null {
	let u: URL;
	try {
		u = new URL(url.trim());
	} catch {
		return null;
	}
	const labels = u.hostname.split('.');
	// www.example.com → *.example.com; example.com → *.example.com; an IP address stays as it is.
	const base = /^[\d.]+$|^\[/.test(u.hostname) ? u.hostname : labels.length > 2 ? labels.slice(1).join('.') : u.hostname;
	const origin = `${u.protocol}//${u.host}`;
	return { exact: origin + (u.pathname === '/' ? '' : u.pathname), domain: /^[\d.]+$|^\[/.test(base) ? origin : `${u.protocol}//*.${base}` };
}

/** The link as the prompt shows it: scheme, host and path in full, the query and fragment shortened (VS Code keeps 60 characters). */
export function displayLink(url: string): string {
	let u: URL;
	try {
		u = new URL(url.trim());
	} catch {
		return url;
	}
	let shown = `${u.protocol}//${u.host}${u.pathname}`;
	const tail = `${u.search}${u.hash}`;
	const keep = Math.min(Math.max(5, 60 - shown.length), tail.length);
	shown += keep === tail.length ? tail : tail.charAt(0) + '...' + tail.slice(tail.length - keep + 1);
	return shown;
}

/**
 * Whether a link asks first: web links whose domain is not trusted. A link from the workspace's
 * own content (editor links, the Markdown preview) in a trusted window opens without asking
 * unless `workbench.trustedDomains.promptInTrustedWorkspace` (VS Code's `fromWorkspace`).
 */
export function linkNeedsPrompt(url: string, o: { trusted: readonly string[]; fromWorkspace: boolean; workspaceTrusted: boolean; promptInTrustedWorkspace: boolean }): boolean {
	if (!isWebLink(url)) return false;
	if (o.fromWorkspace && o.workspaceTrusted && !o.promptInTrustedWorkspace) return false;
	return !isUrlTrusted(url, o.trusted);
}

/** The Trusted Domains file a new install starts with (JSON with comments, an array of domains). */
export const TRUSTED_DOMAINS_TEMPLATE = `// Trusted Domains: links to these open in the browser without asking.
// Save this file to apply it. Each entry is one of:
//   "https://example.com"        that host (any path), over https
//   "https://*.example.com"      example.com and all its subdomains
//   "example.com"                that host over http and https
//   "https://example.com:*"      any port
//   "https://example.com/docs"   that path and everything under it
//   "*"                          every domain (turns link protection off)
// localhost, 127.0.0.1 and [::1] are always trusted.
[
]
`;
