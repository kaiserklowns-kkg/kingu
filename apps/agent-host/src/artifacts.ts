// Artifacts: pages an agent publishes for the user (old Kingu's / Orca's artifacts). A Claude run
// gets Kingu's own in-process MCP server `kingu` with one tool, `artifact_publish`: the page (HTML
// or Markdown, inline or a file in the run's folder) and its assets go to the app over the
// `kingu` command's socket (`artifact.publish`, crates/kingu-cli), which stores them under the
// project's `.kingu/artifacts/<id>/` and answers with the id and version. The run then gets an
// `artifact` event, which the chat shows as a card that opens the page.
//
// Inline content is staged in a private temp folder (0700, files 0600) for the app to copy and
// removed right after. Asset files must be inside the run's folder (symlinks resolved), so a page
// never carries a file from elsewhere on the machine.

import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ARTIFACT_TOOL, type AgentEvent } from './protocol.ts';

export { ARTIFACT_TOOL };
/** The MCP server's name (tools are `mcp__kingu__<tool>`). */
export const ARTIFACT_SERVER = 'kingu';

export const METHOD_PUBLISH = 'artifact.publish';
/** The app's limits (src-tauri artifacts.rs): an entry page and each asset. */
export const MAX_ENTRY_BYTES = 5 * 1024 * 1024;
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;
export const MAX_INLINE_FILES = 50;
export const MAX_ASSETS = 100;
const MAX_NAME = 200;
const MAX_SEGMENTS = 8;
const ID = /^[0-9a-f]{16}$/;
const ENTRY_EXT = /\.(html?|md|markdown)$/i;
/** How long the app may take to store an artifact. */
export const CALL_TIMEOUT_MS = 30_000;

/** Calls the app: a method and its params → the answer's `result` (throws its error). */
export type CallApp = (method: string, params: unknown) => Promise<unknown>;

export type PublishInput = {
	title: string;
	html?: string;
	markdown?: string;
	path?: string;
	description?: string;
	id?: string;
	assets?: { path: string; name?: string }[];
	files?: { name: string; content: string; encoding?: 'utf8' | 'base64' }[];
};

export type Published = { id: string; version: number; title: string; format: 'html' | 'markdown'; root: string; path: string };

/** Why `name` is not a safe relative path inside an artifact, or null when it is. */
export function nameError(name: string): string | null {
	if (typeof name !== 'string' || !name) return 'a file name is empty';
	if (name.length > MAX_NAME) return `${name.slice(0, 40)}…: a file name is longer than ${MAX_NAME} characters`;
	if (name.includes('\0') || name.includes('\\')) return `${name}: a file name must not contain NUL or backslashes`;
	if (name.startsWith('/') || isAbsolute(name)) return `${name}: a file name must be relative`;
	const parts = name.split('/');
	if (parts.length > MAX_SEGMENTS) return `${name}: at most ${MAX_SEGMENTS} folders deep`;
	if (parts.some((p) => p === '' || p === '.' || p === '..')) return `${name}: no empty, . or .. parts`;
	return null;
}

/** `p` (relative to `cwd`, or absolute) as a real path inside the real `cwd`; throws otherwise. */
export function insideCwd(cwd: string, p: string): string {
	const root = realpathSync(cwd);
	let real: string;
	try {
		real = realpathSync(resolve(cwd, p));
	} catch {
		throw new Error(`${p}: no such file`);
	}
	const rel = relative(root, real);
	if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${p}: must be a file inside the project folder`);
	if (!lstatSync(real).isFile()) throw new Error(`${p}: not a regular file`);
	return real;
}

/** An asset's default name: its path below the entry's folder, else its file name. */
export function defaultName(entryDir: string, real: string): string {
	const rel = relative(entryDir, real);
	if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
	return real.split(sep).pop() ?? real;
}

function bytesOf(f: { name: string; content: string; encoding?: 'utf8' | 'base64' }): Buffer {
	return f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : Buffer.from(f.content, 'utf8');
}

/** The publish request for the app; inline content is written under `stage()` (made on first use). */
export function prepare(input: PublishInput, cwd: string, stage: () => string): { file: string; assets: { path: string; name: string }[] } {
	const given = [input.html, input.markdown, input.path].filter((v) => v !== undefined);
	if (given.length !== 1) throw new Error('give exactly one of html, markdown or path');
	if (input.id !== undefined && !ID.test(input.id)) throw new Error('id must be an artifact id (16 hex digits)');
	if ((input.files?.length ?? 0) > MAX_INLINE_FILES) throw new Error(`at most ${MAX_INLINE_FILES} inline files`);
	if ((input.assets?.length ?? 0) + (input.files?.length ?? 0) > MAX_ASSETS) throw new Error(`at most ${MAX_ASSETS} assets`);
	const write = (name: string, bytes: Buffer) => {
		const target = join(stage(), name);
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		writeFileSync(target, bytes, { mode: 0o600 });
		return target;
	};
	let file: string;
	if (input.path !== undefined) {
		file = insideCwd(cwd, input.path);
		if (!ENTRY_EXT.test(file)) throw new Error(`${input.path}: the page must be an .html, .htm, .md or .markdown file`);
	} else {
		const text = (input.html ?? input.markdown)!;
		if (Buffer.byteLength(text) > MAX_ENTRY_BYTES) throw new Error(`the page is larger than ${MAX_ENTRY_BYTES / 1024 / 1024} MB`);
		file = write(input.html !== undefined ? 'index.html' : 'index.md', Buffer.from(text, 'utf8'));
	}
	const entryName = file.split(sep).pop()!;
	const assets: { path: string; name: string }[] = [];
	const seen = new Set([entryName]);
	const add = (path: string, name: string) => {
		const err = nameError(name);
		if (err) throw new Error(err);
		if (seen.has(name)) throw new Error(`${name}: two files with the same name (or the page's own name)`);
		seen.add(name);
		assets.push({ path, name });
	};
	for (const a of input.assets ?? []) {
		const real = insideCwd(cwd, a.path);
		if (lstatSync(real).size > MAX_ASSET_BYTES) throw new Error(`${a.path}: an asset must be at most ${MAX_ASSET_BYTES / 1024 / 1024} MB`);
		add(real, a.name ?? defaultName(dirname(file), real));
	}
	for (const f of input.files ?? []) {
		const err = nameError(f.name);
		if (err) throw new Error(err);
		const bytes = bytesOf(f);
		if (bytes.length > MAX_ASSET_BYTES) throw new Error(`${f.name}: an asset must be at most ${MAX_ASSET_BYTES / 1024 / 1024} MB`);
		add(write(f.name, bytes), f.name);
	}
	return { file, assets };
}

function published(v: unknown): Published {
	const r = (v ?? {}) as Record<string, unknown>;
	const ok =
		typeof r.id === 'string' &&
		ID.test(r.id) &&
		typeof r.version === 'number' &&
		Number.isInteger(r.version) &&
		r.version > 0 &&
		typeof r.title === 'string' &&
		(r.format === 'html' || r.format === 'markdown') &&
		typeof r.root === 'string' &&
		typeof r.path === 'string';
	if (!ok) throw new Error('Kingu gave an unexpected answer');
	return r as Published;
}

export type PublishDeps = {
	cwd: string;
	call: CallApp;
	emit: (ev: AgentEvent) => void;
	/** Where staging folders go (tests). */
	tmp?: string;
};

/** The tool's work: stage, ask the app, clean up, emit the card's event. A text result for the model. */
export async function publishArtifact(input: PublishInput, deps: PublishDeps): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
	let staged: string | null = null;
	const stage = () => (staged ??= mkdtempSync(join(deps.tmp ?? tmpdir(), 'kingu-artifact-')));
	try {
		const title = input.title?.trim();
		if (!title || title.length > 200) throw new Error('title must be 1 to 200 characters');
		if (input.description !== undefined && input.description.length > 1000) throw new Error('description must be at most 1000 characters');
		const { file, assets } = prepare(input, deps.cwd, stage);
		const res = published(
			await deps.call(METHOD_PUBLISH, { cwd: deps.cwd, file, title, description: input.description?.trim() || null, assets, id: input.id ?? null, source: 'agent' })
		);
		deps.emit({ kind: 'artifact', id: res.id, title: res.title, version: res.version, format: res.format, root: res.root });
		const text = `Published artifact ${res.title} (id ${res.id}, version ${res.version}). The user can open it from the chat; to publish a new version call this tool again with id ${res.id}.`;
		return { content: [{ type: 'text', text }] };
	} catch (e) {
		return { content: [{ type: 'text', text: `Artifact not published: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
	} finally {
		if (staged) rmSync(staged, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------------------------
// The app's socket (crates/kingu-cli protocol: one JSON line each way)

export type Runtime = { socket: string; token: string };

/** The runtime file the app wrote: a regular file of this user that nobody else can read. */
export function readRuntime(path: string): Runtime {
	let st;
	try {
		st = lstatSync(path);
	} catch {
		throw new Error('Kingu is not running (no runtime file)');
	}
	if (!st.isFile()) throw new Error(`${path} is not a regular file`);
	if ((st.mode & 0o077) !== 0) throw new Error(`${path} is readable or writable by other users; refusing it`);
	const uid = process.getuid?.();
	if (uid !== undefined && st.uid !== uid) throw new Error(`${path} belongs to another user; refusing it`);
	const rt = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
	if (rt.version !== 1 || typeof rt.socket !== 'string' || !rt.socket || typeof rt.token !== 'string' || !/^[0-9a-f]{64}$/.test(rt.token)) throw new Error(`${path}: incomplete runtime file`);
	return { socket: rt.socket, token: rt.token };
}

/** Calls the running app over its socket, the runtime file read on each call (the app may restart). */
export function socketCaller(runtimeFile: string, timeoutMs = CALL_TIMEOUT_MS): CallApp {
	return (method, params) =>
		new Promise((resolve, reject) => {
			let rt: Runtime;
			try {
				rt = readRuntime(runtimeFile);
			} catch (e) {
				return reject(e);
			}
			let buf = '';
			let settled = false;
			const done = (err: Error | null, value?: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				sock.destroy();
				if (err) reject(err);
				else resolve(value);
			};
			const sock = connect(rt.socket);
			const timer = setTimeout(() => done(new Error('Kingu did not answer in time')), timeoutMs);
			sock.setEncoding('utf8');
			sock.on('connect', () => sock.write(`${JSON.stringify({ id: 1, authToken: rt.token, method, params })}\n`));
			sock.on('data', (chunk: string) => {
				buf += chunk;
				const nl = buf.indexOf('\n');
				if (nl < 0) return;
				try {
					const res = JSON.parse(buf.slice(0, nl)) as { ok?: boolean; result?: unknown; error?: { message?: string } };
					if (res.ok) done(null, res.result);
					else done(new Error(res.error?.message || 'Kingu refused the request'));
				} catch {
					done(new Error('unreadable answer from Kingu'));
				}
			});
			sock.on('error', (e) => done(new Error(`Kingu is not reachable: ${e.message}`)));
			sock.on('close', () => done(new Error('Kingu closed the connection without answering')));
		});
}

// ---------------------------------------------------------------------------------------------
// The MCP server

const DESCRIPTION = `Publish an artifact: a self-contained page (HTML, or Markdown) that the user opens in Kingu from the chat and can export or share with their team. Use it for reports, dashboards, diagrams, prototypes and summaries worth keeping.
- Give exactly one of html (a full HTML document), markdown, or path (an .html/.md file inside the project folder).
- Other files the page uses (images, CSS, JS, data) go in assets (files inside the project folder) or files (inline content); the page references them by relative path, e.g. <img src="img/chart.png">.
- The page runs sandboxed: scripts work, but it has no network except these CDNs: cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, cdn.tailwindcss.com, code.jquery.com, and Google Fonts. No fetch/XHR/WebSocket, forms or popups; put the data in the page.
- Pass id (from an earlier publish) to publish a new version of the same artifact.`;

const shape = {
	title: z.string().min(1).max(200).describe('Short title shown on the artifact card and in the Artifacts list.'),
	html: z.string().optional().describe('The page as a complete HTML document.'),
	markdown: z.string().optional().describe('The page as Markdown (rendered by Kingu).'),
	path: z.string().optional().describe('An .html, .htm, .md or .markdown file inside the project folder (relative or absolute).'),
	description: z.string().max(1000).optional().describe('One or two sentences on what the page is.'),
	id: z
		.string()
		.regex(/^[0-9a-f]{16}$/)
		.optional()
		.describe('An existing artifact id: publishes a new version of it.'),
	assets: z
		.array(z.object({ path: z.string().describe('A file inside the project folder.'), name: z.string().optional().describe('Its relative path inside the artifact (default: its path below the page\'s folder, else its file name).') }))
		.max(MAX_ASSETS)
		.optional()
		.describe('Files the page references, copied into the artifact.'),
	files: z
		.array(z.object({ name: z.string().describe('Relative path inside the artifact, e.g. data/points.json.'), content: z.string(), encoding: z.enum(['utf8', 'base64']).optional().describe('base64 for binary files; default utf8.') }))
		.max(MAX_INLINE_FILES)
		.optional()
		.describe('Inline files the page references (at most 50, each up to 10 MB).')
};

/** Kingu's MCP server for one run in `cwd`. */
export function artifactServer(deps: PublishDeps): McpSdkServerConfigWithInstance {
	return createSdkMcpServer({
		name: ARTIFACT_SERVER,
		version: '1.0.0',
		alwaysLoad: true,
		tools: [tool(ARTIFACT_TOOL.slice(`mcp__${ARTIFACT_SERVER}__`.length), DESCRIPTION, shape, (args) => publishArtifact(args as PublishInput, deps))]
	});
}
