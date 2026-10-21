// What the chat reads from an MCP server itself (the `mcp_query` request): Add Context's
// resources (VS Code's "MCP Resources…": `resources/list`, `resources/templates/list`, then
// `resources/read`) and the `/mcp.<server>.<prompt>` commands (`prompts/list`, `prompts/get`).
// A live Arkai run's connection to the server is used when there is one; otherwise one is opened
// for the request (the run folder as its root, the same command or URL runs get) and closed after.
// Results are made small for the webview here: texts cut, binary content named, not sent.
//
// Never log what a resource or prompt holds.

import { defaultConnection, McpClient, type McpConnection } from './arkai/mcp.ts';
import type { McpQueryParams, McpServerParams } from './protocol.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** A resource's text past this is cut (the chat cuts what it attaches further). */
export const MAX_TEXT = 512 * 1024;
const MAX_DESCRIPTION = 500;
const MAX_ARGS = 50;
const MAX_ARG = 64 * 1024;
/** A query's connection may take this long to start (a stdio server spawned for it). */
export const QUERY_CONNECT_MS = 20_000;

export type ResourceInfo = { uri: string; name: string; description: string; mimeType: string | null; size: number | null };
export type TemplateInfo = { uriTemplate: string; name: string; description: string; mimeType: string | null };
export type PromptArg = { name: string; description: string; required: boolean };
export type PromptInfo = { name: string; title: string | null; description: string; arguments: PromptArg[] };
export type ListResult = { resources: ResourceInfo[]; templates: TemplateInfo[]; prompts: PromptInfo[] };
/** A resource's content: text (cut at MAX_TEXT), or binary named by its type and size. */
export type ResourceContent = { uri: string; mimeType: string | null; text: string | null; bytes: number; truncated: boolean };
export type PromptResult = { description: string; messages: { role: string; text: string }[]; resources: ResourceContent[]; images: number };

const short = (v: unknown) => (str(v) ?? '').slice(0, MAX_DESCRIPTION);

/** One content entry (`resources/read`, or a prompt's embedded `resource`). */
export function contentOf(c: Obj): ResourceContent {
	const uri = str(c.uri) ?? '';
	const mimeType = str(c.mimeType);
	if (typeof c.text === 'string') {
		const truncated = c.text.length > MAX_TEXT;
		return { uri, mimeType, text: truncated ? c.text.slice(0, MAX_TEXT) : c.text, bytes: Buffer.byteLength(c.text), truncated };
	}
	const blob = str(c.blob) ?? '';
	return { uri, mimeType, text: null, bytes: Math.floor((blob.length * 3) / 4), truncated: false };
}

export async function listAll(client: McpClient): Promise<ListResult> {
	// One list failing leaves the others.
	const safe = (p: Promise<Obj[]>) => p.catch(() => [] as Obj[]);
	const [resources, templates, prompts] = await Promise.all([
		safe(client.list('resources/list', 'resources', 'resources')),
		safe(client.list('resources/templates/list', 'resourceTemplates', 'resources')),
		safe(client.list('prompts/list', 'prompts', 'prompts'))
	]);
	return {
		resources: resources
			.filter((r) => str(r.uri))
			.map((r) => ({ uri: r.uri as string, name: str(r.title) ?? str(r.name) ?? (r.uri as string), description: short(r.description), mimeType: str(r.mimeType), size: typeof r.size === 'number' ? r.size : null })),
		templates: templates
			.filter((r) => str(r.uriTemplate))
			.map((r) => ({ uriTemplate: r.uriTemplate as string, name: str(r.title) ?? str(r.name) ?? (r.uriTemplate as string), description: short(r.description), mimeType: str(r.mimeType) })),
		prompts: prompts
			.filter((p) => str(p.name))
			.map((p) => ({
				name: p.name as string,
				title: str(p.title),
				description: short(p.description),
				arguments: (Array.isArray(p.arguments) ? p.arguments.filter(isObj) : [])
					.filter((a) => str(a.name))
					.slice(0, MAX_ARGS)
					.map((a) => ({ name: a.name as string, description: short(a.description), required: a.required === true }))
			}))
	};
}

export async function readResource(client: McpClient, uri: string): Promise<ResourceContent[]> {
	const r = await client.request('resources/read', { uri });
	return (isObj(r) && Array.isArray(r.contents) ? r.contents.filter(isObj) : []).map(contentOf);
}

export async function getPrompt(client: McpClient, name: string, args: Record<string, string>): Promise<PromptResult> {
	const r = await client.request('prompts/get', { name, arguments: args });
	const out: PromptResult = { description: isObj(r) ? short(r.description) : '', messages: [], resources: [], images: 0 };
	for (const m of isObj(r) && Array.isArray(r.messages) ? r.messages.filter(isObj) : []) {
		const role = m.role === 'assistant' ? 'assistant' : 'user';
		const c = isObj(m.content) ? m.content : {};
		if (c.type === 'text' && typeof c.text === 'string') out.messages.push({ role, text: c.text.slice(0, MAX_TEXT) });
		else if (c.type === 'resource' && isObj(c.resource)) out.resources.push(contentOf(c.resource));
		else if (c.type === 'resource_link' && str(c.uri)) out.messages.push({ role, text: `[${str(c.name) ?? 'resource'}](${c.uri as string})` });
		else if (c.type === 'image' || c.type === 'audio') out.images++;
	}
	return out;
}

/** Checks a query's params; throws with why not. */
export function checkQuery(p: McpQueryParams) {
	if (typeof p.cwd !== 'string' || !p.cwd.startsWith('/')) throw new Error('cwd must be an absolute path');
	if (typeof p.name !== 'string' || !p.name) throw new Error('name is empty');
	if (!isObj(p.server)) throw new Error('server must be an object');
	if (p.op === 'read' && (typeof p.uri !== 'string' || !p.uri || p.uri.length > 8192)) throw new Error('uri is empty');
	if (p.op === 'prompt') {
		if (typeof p.prompt !== 'string' || !p.prompt) throw new Error('prompt is empty');
		const args = p.arguments ?? {};
		if (!isObj(args) || Object.keys(args).length > MAX_ARGS || !Object.values(args).every((v) => typeof v === 'string' && v.length <= MAX_ARG)) throw new Error('arguments must map names to strings');
	}
	if (p.op !== 'list' && p.op !== 'read' && p.op !== 'prompt') throw new Error(`unknown op ${String(p.op)}`);
}

export type QueryDeps = {
	env: Record<string, string | undefined>;
	/** A live run's client for the server, if one is connected. */
	live?: McpClient | null;
	/** How a server is reached (tests pass their own). */
	connect?: (s: McpServerParams, cwd: string) => McpConnection;
};

/** Runs one query (params checked by `checkQuery`). */
export async function runQuery(p: McpQueryParams, deps: QueryDeps): Promise<unknown> {
	let client = deps.live ?? null;
	let own: McpClient | null = null;
	if (!client) {
		const conn = (deps.connect ?? ((s, cwd) => defaultConnection(s, cwd, deps.env)))(p.server, p.cwd);
		own = client = new McpClient(p.name, conn);
		try {
			await own.connect(QUERY_CONNECT_MS, false);
		} catch (e) {
			own.close();
			throw e;
		}
	}
	try {
		if (p.op === 'list') return await listAll(client);
		if (p.op === 'read') return await readResource(client, p.uri!);
		return await getPrompt(client, p.prompt!, p.arguments ?? {});
	} finally {
		own?.close();
	}
}
