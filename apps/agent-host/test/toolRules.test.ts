// VS Code's tool approval rules on the host side: `chat.tools.edits.autoApprove` globs (an edit
// whose last matching glob is false asks, in every mode but Allow all), and Arkai's WebFetch
// (URL checks, HTML to text, size, time and redirect limits) against a fake network.

import { describe, expect, test } from 'bun:test';
import { askFor, editApproved, globRegex, parseEditRules } from '../src/guards/asks.ts';
import { Guards } from '../src/guards/index.ts';
import { fetchableUrl, htmlToText, MAX_FETCH_BYTES, webFetch } from '../src/arkai/webFetch.ts';
import { granted, ruleFor } from '../src/arkai/session.ts';
import { runTool } from '../src/arkai/tools.ts';

const same = (p: string) => p;

/** VS Code's default `chat.tools.edits.autoApprove` (the part these tests use), as Rust sends it. */
const DEFAULTS: [string, boolean][] = [
	['**/*', true],
	['**/.git/**', false],
	['**/{package.json,server.xml,build.rs,web.config,.gitattributes,.env,Cargo.toml}', false],
	['**/*.lock', false],
	['**/*-lock.{yaml,json}', false],
	['**/.vscode/*.json', false],
	['**/.claude/settings.json', false]
];

describe('edit rules (chat.tools.edits.autoApprove)', () => {
	test('VS Code globs', () => {
		const m = (glob: string, path: string) => globRegex(glob).test(path);
		expect(m('**/*', 'a.ts')).toBe(true);
		expect(m('**/*', 'src/deep/a.ts')).toBe(true);
		expect(m('**/.git/**', '.git/config')).toBe(true);
		expect(m('**/.git/**', 'sub/.git/hooks/pre-commit')).toBe(true);
		expect(m('**/.git/**', '.gitignore')).toBe(false);
		expect(m('**/{package.json,.env}', 'package.json')).toBe(true);
		expect(m('**/{package.json,.env}', 'web/.env')).toBe(true);
		expect(m('**/{package.json,.env}', 'web/.env.local')).toBe(false);
		expect(m('**/*.{csproj,gradle.kts}', 'app/build.gradle.kts')).toBe(true);
		expect(m('**/*-lock.{yaml,json}', 'pnpm-lock.yaml')).toBe(true);
		expect(m('**/*-lock.{yaml,json}', 'package-lock.json')).toBe(true);
		expect(m('**/.vscode/*.json', '.vscode/settings.json')).toBe(true);
		expect(m('**/.vscode/*.json', '.vscode/sub/x.json')).toBe(false);
		expect(m('src/*.ts', 'src/a.ts')).toBe(true);
		expect(m('src/*.ts', 'lib/src/a.ts')).toBe(false);
		expect(m('a?.[jt]s', 'ab.ts')).toBe(true);
		expect(m('a?.[!jt]s', 'ab.ts')).toBe(false);
		expect(m('a.b', 'axb')).toBe(false);
		expect(() => globRegex('**/{a,b')).toThrow();
	});

	test('the last matching rule decides; no match approves', () => {
		const rules = parseEditRules([...DEFAULTS, ['docs/**', false], ['docs/ok.md', true], ['**/{bad', false]]);
		expect(editApproved(rules, 'src/a.ts')).toBe(true);
		expect(editApproved(rules, 'package.json')).toBe(false);
		expect(editApproved(rules, 'apps/web/package.json')).toBe(false);
		expect(editApproved(rules, 'Cargo.lock')).toBe(false);
		expect(editApproved(rules, 'docs/a.md')).toBe(false);
		expect(editApproved(rules, 'docs/ok.md')).toBe(true);
		expect(editApproved(parseEditRules([['**/*.md', false]]), 'a.ts')).toBe(true);
		expect(editApproved([], 'package.json')).toBe(true);
	});

	test('an edit to a protected file asks, in every mode but Allow all', () => {
		const edits = { rules: parseEditRules(DEFAULTS), allowAll: false };
		expect(askFor('Edit', { file_path: 'package.json' }, '/w', {}, [], same, edits)).toEqual({ check: 'edit_rule', paths: ['package.json'] });
		expect(askFor('Write', { file_path: '/w/.vscode/settings.json' }, '/w', {}, [], same, edits)?.check).toBe('edit_rule');
		expect(askFor('MultiEdit', { file_path: '/w/src/a.ts' }, '/w', {}, [], same, edits)).toBeNull();
		// Reading one is not an edit.
		expect(askFor('Read', { file_path: 'package.json' }, '/w', {}, [], same, edits)).toBeNull();
		// Outside the folder the absolute path is matched (and the outside ask comes first).
		expect(askFor('Edit', { file_path: '/other/package.json' }, '/w', {}, [], same, edits)?.check).toBe('edit_rule');
		expect(askFor('Edit', { file_path: '/other/package.json' }, '/w', { outsideCwd: true }, [], same, edits)?.check).toBe('outside_cwd');
		expect(askFor('Edit', { file_path: 'package.json' }, '/w', {}, [], same, { ...edits, allowAll: true })).toBeNull();
	});

	test('Guards follow the run mode', () => {
		let mode = 'acceptEdits';
		const g = new Guards(false, { cwd: '/w', editRules: DEFAULTS }, () => mode);
		expect(g.askFor('Edit', { file_path: 'Cargo.toml' }, same)?.check).toBe('edit_rule');
		mode = 'bypassPermissions';
		expect(g.askFor('Edit', { file_path: 'Cargo.toml' }, same)).toBeNull();
		mode = 'default';
		expect(g.askFor('Edit', { file_path: 'src/main.rs' }, same)).toBeNull();
	});
});

/** A fake `fetch` answering from a table of URL → Response (a function for the fancy ones). */
function fakeFetch(routes: Record<string, () => Response>) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fn = (async (url: string | URL | Request, init?: RequestInit) => {
		const href = String(url);
		calls.push({ url: href, init });
		const route = routes[href];
		if (!route) throw new Error(`no route for ${href}`);
		return route();
	}) as unknown as typeof fetch;
	return { fn, calls };
}

const html = (body: string, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const signal = () => new AbortController().signal;

describe('Arkai WebFetch', () => {
	test('only http(s) URLs without credentials', () => {
		expect(fetchableUrl('https://example.com/a')).toBeInstanceOf(URL);
		expect(fetchableUrl('file:///etc/passwd')).toContain('Only http and https');
		expect(fetchableUrl('https://u:p@example.com')).toContain('user name');
		expect(fetchableUrl('nope')).toContain('Not a URL');
		expect(fetchableUrl(undefined)).toContain('missing required string `url`');
	});

	test('HTML becomes readable text', () => {
		const text = htmlToText(
			'<html><head><title>T</title><style>p{}</style></head><body><script>alert(1)</script><h1>Hello&nbsp;&amp; welcome</h1><p>One <b>two</b><br>three</p><ul><li>a</li><li>b &#x263A; &#9731;</li></ul><a href="https://x.dev/doc">Docs</a> <a href="#top">top</a><!-- hidden --></body></html>'
		);
		expect(text).toBe('Hello & welcome\n\nOne two\nthree\n\n- a\n- b ☺ ☃\nDocs (https://x.dev/doc) top');
	});

	test('a page as text, through runTool with the fake network', async () => {
		const net = fakeFetch({ 'https://docs.example/a': html('<p>Hi <i>there</i></p>') });
		const r = await runTool('WebFetch', { url: 'https://docs.example/a', prompt: 'x' }, { cwd: '/tmp', env: {}, signal: signal(), fetch: net.fn });
		expect(r).toEqual({ content: 'https://docs.example/a\n\nHi there', isError: false });
		expect(net.calls[0]!.init?.redirect).toBe('manual');
	});

	test('JSON and plain text pass through; binaries do not', async () => {
		const net = fakeFetch({
			'https://a.example/j': () => new Response('{"a":1}', { headers: { 'content-type': 'application/json' } }),
			'https://a.example/img': () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
		});
		expect((await webFetch({ url: 'https://a.example/j' }, signal(), net.fn)).content).toBe('https://a.example/j\n\n{"a":1}');
		const img = await webFetch({ url: 'https://a.example/img' }, signal(), net.fn);
		expect(img.isError).toBe(true);
		expect(img.content).toContain('not a text page (image/png)');
	});

	test('HTTP errors are errors', async () => {
		const net = fakeFetch({ 'https://a.example/x': html('<p>Not here</p>', 404) });
		const r = await webFetch({ url: 'https://a.example/x' }, signal(), net.fn);
		expect(r.isError).toBe(true);
		expect(r.content).toStartWith('HTTP 404');
		expect(r.content).toContain('Not here');
	});

	test('redirects: same host followed, another host reported', async () => {
		const net = fakeFetch({
			'https://a.example/old': () => new Response(null, { status: 301, headers: { location: '/new' } }),
			'https://a.example/new': html('<p>moved</p>'),
			'https://a.example/away': () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } })
		});
		const r = await webFetch({ url: 'https://a.example/old' }, signal(), net.fn);
		expect(r.content).toBe('https://a.example/new (redirected from https://a.example/old)\n\nmoved');
		const away = await webFetch({ url: 'https://a.example/away' }, signal(), net.fn);
		expect(away.isError).toBe(false);
		expect(away.content).toContain('redirects to another host: https://evil.example/x');
		expect(net.calls.map((c) => c.url)).not.toContain('https://evil.example/x');
	});

	test('a redirect loop stops', async () => {
		const net = fakeFetch({ 'https://a.example/loop': () => new Response(null, { status: 302, headers: { location: '/loop' } }) });
		const r = await webFetch({ url: 'https://a.example/loop' }, signal(), net.fn);
		expect(r.isError).toBe(true);
		expect(r.content).toContain('Too many redirects');
		expect(net.calls.length).toBe(6);
	});

	test('a huge page is read only up to the cap', async () => {
		let pulled = 0;
		const chunk = new Uint8Array(256 * 1024).fill(97);
		const body = new ReadableStream<Uint8Array>({
			pull(c) {
				pulled++;
				c.enqueue(chunk);
				if (pulled > 100) c.close();
			}
		});
		const net = fakeFetch({ 'https://big.example/': () => new Response(body, { headers: { 'content-type': 'text/plain' } }) });
		const r = await webFetch({ url: 'https://big.example/' }, signal(), net.fn);
		expect(r.content).toContain('more characters cut');
		expect(pulled).toBeLessThan(MAX_FETCH_BYTES / chunk.length + 3);
	});

	test('network failures and the user stopping', async () => {
		const net = fakeFetch({});
		const r = await webFetch({ url: 'https://down.example/' }, signal(), net.fn);
		expect(r).toEqual({ content: 'Could not fetch https://down.example/: no route for https://down.example/', isError: true });
		const ac = new AbortController();
		const hang = (async (_u: unknown, init?: RequestInit) =>
			new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
		const pending = webFetch({ url: 'https://slow.example/' }, ac.signal, hang);
		ac.abort();
		expect(await pending).toEqual({ content: 'Interrupted', isError: true });
	});

	test('"allow always" covers one site', () => {
		const view = (url: string) => ({ name: 'WebFetch', input: { url }, kind: 'fetch' as const, paths: [] });
		expect(ruleFor(view('https://Docs.rs/serde'))).toEqual({ text: 'WebFetch(domain:docs.rs)', key: 'WebFetch:docs.rs' });
		const grants = new Set(['WebFetch:docs.rs']);
		expect(granted(grants, view('https://docs.rs/tokio'))).toBe(true);
		expect(granted(grants, view('https://crates.io/'))).toBe(false);
		expect(granted(new Set(['WebFetch']), view('https://crates.io/'))).toBe(false);
	});
});
