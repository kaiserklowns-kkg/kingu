// Skills over MCP (SEP-2640, src/arkai/mcpSkills.ts): entries checked, listed only from servers
// that declare the extension, loaded with ReadSkill after the user allowed the server, every file
// checked against its digest; and MCP Apps tools that are only for their app left out. No real
// server, no real model.

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHost } from '../src/host.ts';
import { clientCapabilities, McpHub, modelVisible, type McpConnection } from '../src/arkai/mcp.ts';
import { frontmatterOf, mcpSkillIndex, McpSkillRegistry, sameJson, skillArgumentHint, skillEntry, skillLabels, SKILLS_EXTENSION, type McpSkill } from '../src/arkai/mcpSkills.ts';
import type { AgentEvent } from '../src/protocol.ts';
import { FakeLlm } from './fixtures/fake-llm.ts';

const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

const digest = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const file = (uri: string, text: string) => ({ uri, digest: digest(text), size: new TextEncoder().encode(text).byteLength });

const SKILL_MD = '---\nname: review\ndescription: Review a change the team way\nmetadata:\n  version: "2"\n---\n# Review\nRead checklist.md first.\n';
const CHECKLIST = '- tests pass\n- no secrets\n';
const TEMPLATE = 'Summary:\n';
const FILES: Record<string, string> = {
	'skill://review/SKILL.md': SKILL_MD,
	'skill://review/checklist.md': CHECKLIST,
	'skill://review/templates/summary.md': TEMPLATE,
	'skill://review/secret.md': 'not listed'
};
const ENTRY = {
	uri: 'skill://review/SKILL.md',
	frontmatter: { name: 'review', description: 'Review a change the team way', metadata: { version: '2' } },
	resources: [file('skill://review/SKILL.md', SKILL_MD), file('skill://review/checklist.md', CHECKLIST), file('skill://review/templates/summary.md', TEMPLATE)]
};
const HIDDEN = {
	uri: 'skill://acme/hidden/SKILL.md',
	frontmatter: { name: 'hidden', description: 'Only by URI' },
	resources: [file('skill://acme/hidden/SKILL.md', '---\nname: hidden\ndescription: Only by URI\n---\nbody\n')]
};

/** A skills server's answers by method. */
function answer(method: string, params: any, o: { declares?: boolean; files?: Record<string, string> } = {}): unknown {
	const files = o.files ?? FILES;
	switch (method) {
		case 'initialize':
			return { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {}, ...(o.declares === false ? {} : { extensions: { [SKILLS_EXTENSION]: {} } }) }, serverInfo: { name: 's', version: '1' } };
		case 'tools/list':
			return {
				tools: [
					{ name: 'show', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://s/show.html' } } },
					{ name: 'app-only', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://s/a.html', visibility: ['app'] } } }
				]
			};
		case 'skills/list':
			return { resultType: 'complete', skills: [ENTRY, { uri: 'skill://bad/SKILL.md', frontmatter: { name: 'other', description: 'x' }, resources: [] }] };
		case 'skills/get':
			if (params.uri === HIDDEN.uri) return { resultType: 'complete', skill: HIDDEN };
			throw new Error('not a skill');
		case 'resources/read': {
			const text = params.uri === HIDDEN.uri ? '---\nname: hidden\ndescription: Only by URI\n---\nbody\n' : files[params.uri];
			if (text === undefined) throw new Error('unknown resource');
			return { contents: [{ uri: params.uri, mimeType: 'text/markdown', text }] };
		}
	}
	throw new Error(`method not found: ${method}`);
}

function fakeConnection(o: { declares?: boolean; files?: Record<string, string> } = {}) {
	const asked: { method: string; params: any }[] = [];
	const conn: McpConnection = {
		request: async (method, params) => {
			asked.push({ method, params });
			return answer(method, params, o);
		},
		notify: () => {},
		close: () => {}
	};
	return { conn, asked };
}

describe('skill entries', () => {
	test('a good entry, and what SEP-2640 refuses', () => {
		const s = skillEntry('srv', ENTRY) as McpSkill;
		expect(s).toMatchObject({ server: 'srv', uri: 'skill://review/SKILL.md', name: 'review', description: 'Review a change the team way' });
		expect(skillEntry('srv', { ...ENTRY, resources: 'dynamic' })).toMatchObject({ resources: 'dynamic' });
		// The last path segment must be the name; resources are required, complete, inside the skill.
		expect(typeof skillEntry('srv', { ...ENTRY, frontmatter: { name: 'other', description: 'x' } })).toBe('string');
		expect(typeof skillEntry('srv', { ...ENTRY, resources: undefined })).toBe('string');
		expect(typeof skillEntry('srv', { ...ENTRY, resources: [file('skill://review/checklist.md', 'x')] })).toBe('string');
		expect(typeof skillEntry('srv', { ...ENTRY, resources: [...ENTRY.resources, file('skill://other/x.md', 'x')] })).toBe('string');
		expect(typeof skillEntry('srv', { ...ENTRY, resources: [...ENTRY.resources, ENTRY.resources[1]] })).toBe('string');
		expect(typeof skillEntry('srv', { ...ENTRY, resources: [{ ...ENTRY.resources[0], digest: 'md5:00' }] })).toBe('string');
	});

	test('front matter is compared field by field', () => {
		expect(sameJson(frontmatterOf(SKILL_MD), ENTRY.frontmatter)).toBe(true);
		expect(sameJson(frontmatterOf(SKILL_MD.replace('"2"', '"3"')), ENTRY.frontmatter)).toBe(false);
		expect(frontmatterOf('# no front matter')).toBeNull();
	});

	test('names are server-prefixed; a clash within a server keeps both by path', () => {
		const a = skillEntry('my srv', ENTRY) as McpSkill;
		const b = skillEntry('my srv', { ...ENTRY, uri: 'skill://acme/review/SKILL.md', resources: [file('skill://acme/review/SKILL.md', 'x')] }) as McpSkill;
		const labels = skillLabels([a, b]);
		expect([labels.get(a), labels.get(b)]).toEqual(['my-srv:review', 'my-srv:acme-review']);
		const index = mcpSkillIndex([a]);
		expect(index).toContain('# Skills from MCP servers');
		expect(index).toContain('server: my srv, uri: skill://review/SKILL.md');
		expect(mcpSkillIndex([])).toBe('');
	});

	test("a skill's argument-hint becomes its slash command's hint (VS Code 06fe31b9170)", () => {
		const hinted = skillEntry('srv', { ...ENTRY, frontmatter: { ...ENTRY.frontmatter, 'argument-hint': ' <pr-number> ' } }) as McpSkill;
		expect(skillArgumentHint(hinted)).toBe('<pr-number>');
		expect(skillArgumentHint(skillEntry('srv', ENTRY) as McpSkill)).toBe('');
		expect(skillArgumentHint(skillEntry('srv', { ...ENTRY, frontmatter: { ...ENTRY.frontmatter, 'argument-hint': 3 } }) as McpSkill)).toBe('');
	});
});

describe('McpHub and skills', () => {
	const hub = (o: { declares?: boolean; skills?: boolean } = {}) => {
		const f = fakeConnection(o);
		const logs: string[] = [];
		const h = new McpHub({ srv: { command: 'unused' } }, { cwd: '/w', env: {}, log: (l) => logs.push(l), onChange: () => {}, skills: o.skills ?? true, connect: () => f.conn });
		cleanups.push(() => h.close());
		return { h, f, logs };
	};

	test('a declaring server: skills listed (bad entries refused), app-only tools left out', async () => {
		const { h, f, logs } = hub();
		await h.ready;
		expect(f.asked.find((a) => a.method === 'initialize')!.params.capabilities.extensions).toEqual({ [SKILLS_EXTENSION]: {} });
		expect(h.skills.all().map((s) => s.name)).toEqual(['review']);
		expect(logs).toContain('mcp srv: 1 skills, 1 refused');
		// Listing fetches no file (SEP-2640: lazily, only when loaded).
		expect(f.asked.some((a) => a.method === 'resources/read')).toBe(false);
		expect(h.defs().map((d) => d.name)).toEqual(['mcp__srv__show']);
	});

	test('no declaration, or the setting off: skills/list is never asked', async () => {
		for (const o of [{ declares: false }, { skills: false }]) {
			const { h, f } = hub(o);
			await h.ready;
			expect(f.asked.some((a) => a.method === 'skills/list')).toBe(false);
			expect(h.skills.all()).toEqual([]);
		}
		expect(clientCapabilities({}, false).extensions).toBeUndefined();
	});

	test('MCP Apps visibility', () => {
		expect(modelVisible({ name: 'x' })).toBe(true);
		expect(modelVisible({ name: 'x', _meta: { ui: { visibility: ['model', 'app'] } } })).toBe(true);
		expect(modelVisible({ name: 'x', _meta: { ui: { visibility: ['app'] } } })).toBe(false);
		expect(modelVisible({ name: 'x', _meta: { 'ui/visibility': ['app'] } })).toBe(false);
	});
});

describe('ReadSkill', () => {
	const client = (files?: Record<string, string>) => ({ name: 'srv', request: (m: string, p: any) => Promise.resolve(answer(m, p, { files })) });
	const registry = () => {
		const r = new McpSkillRegistry();
		r.set('srv', [skillEntry('srv', ENTRY) as McpSkill]);
		return r;
	};

	test('loads a checked SKILL.md, then reads only its listed files', async () => {
		const r = registry();
		const c = client();
		expect((await r.read(c, 'skill://review/checklist.md')).isError).toBe(true);
		const loaded = await r.read(c, 'skill://review/SKILL.md');
		expect(loaded.isError).toBe(false);
		expect(loaded.content).toContain('Skill "review" from MCP server "srv"');
		expect(loaded.content).toContain('Files: checklist.md, templates/summary.md');
		expect(loaded.content).toContain('# Review');
		expect(await r.read(c, 'skill://review/checklist.md')).toEqual({ content: CHECKLIST, isError: false });
		// A folder is answered from the skill's own list.
		expect(await r.read(c, 'skill://review/templates')).toEqual({ content: 'summary.md', isError: false });
		expect(await r.read(c, 'skill://review')).toEqual({ content: 'SKILL.md\nchecklist.md\ntemplates/', isError: false });
		// A file the server has but the entry does not list is refused.
		expect((await r.read(c, 'skill://review/secret.md')).isError).toBe(true);
		// Another server's client cannot read this server's loaded skill.
		expect((await r.read({ ...c, name: 'other' }, 'skill://review/checklist.md')).isError).toBe(true);
	});

	test('content that does not match its digest or front matter is not used', async () => {
		const tampered = await registry().read(client({ ...FILES, 'skill://review/SKILL.md': SKILL_MD.replace('first', 'never') }), 'skill://review/SKILL.md');
		expect(tampered).toMatchObject({ isError: true });
		expect(tampered.content).toContain('does not match');
		const r = registry();
		await r.read(client(), 'skill://review/SKILL.md');
		expect((await r.read(client({ ...FILES, 'skill://review/checklist.md': 'changed' }), 'skill://review/checklist.md')).isError).toBe(true);
	});

	test('a skill no listing named is fetched with skills/get', async () => {
		const r = registry();
		const loaded = await r.read(client(), HIDDEN.uri);
		expect(loaded.isError).toBe(false);
		expect(loaded.content).toContain('body');
		expect((await r.read(client(), 'skill://nope/SKILL.md')).isError).toBe(true);
	});
});

describe('An Arkai run with a skills server', () => {
	test('indexed in the instructions, offered as a command, loaded after the user allows the server', async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'kingu-arkai-skills-')));
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
		// Streamable HTTP answering with JSON bodies.
		const server = Bun.serve({
			port: 0,
			fetch: async (req) => {
				if (req.method !== 'POST') return new Response(null, { status: 405 });
				const m: any = await req.json();
				if (m.id === undefined) return new Response(null, { status: 202 });
				try {
					return Response.json({ jsonrpc: '2.0', id: m.id, result: answer(m.method, m.params ?? {}) });
				} catch (e) {
					return Response.json({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: (e as Error).message } });
				}
			}
		});
		cleanups.push(() => server.stop(true));
		const llm = new FakeLlm();
		cleanups.push(() => llm.stop());
		const out: any[] = [];
		let n = 0;
		const host = new AgentHost({
			query: () => {
				throw new Error('the Claude SDK must not run');
			},
			write: (m) => void out.push(JSON.parse(JSON.stringify(m))),
			newId: () => `req-${++n}`,
			log: () => {}
		});
		cleanups.push(() => host.dispatch('shutdown', null));
		const events = () => out.filter((o) => o.method === 'event').map((o) => o.params.event as AgentEvent);
		const until = async (pred: () => boolean) => {
			for (let i = 0; i < 400 && !pred(); i++) await Bun.sleep(10);
			expect(pred()).toBe(true);
		};
		llm.reply({ calls: [{ id: 's1', name: 'ReadSkill', args: JSON.stringify({ server: 'docs', uri: 'skill://review/SKILL.md' }) }] }, { text: ['Reviewed.'] });
		await host.handleLine(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'start',
				params: {
					runId: 1,
					cwd,
					prompt: '/docs:review the last commit',
					mcpServers: { docs: { type: 'http', url: `http://127.0.0.1:${server.port}/mcp` } },
					runtime: { kind: 'arkai', provider: { id: 'local', name: 'Local', api: 'openai', baseUrl: `${llm.url}/v1`, models: [{ id: 'coder', contextWindow: 64_000 }] }, model: 'coder' }
				}
			})
		);
		await until(() => events().some((e) => e.kind === 'permission_request'));
		const commands = events().find((e) => e.kind === 'commands') as Extract<AgentEvent, { kind: 'commands' }>;
		expect(commands.commands.map((c) => c.name)).toEqual(['docs:review']);
		const first = llm.requests[0]!.body;
		expect(first.tools.map((t: any) => t.function.name)).toContain('ReadSkill');
		expect(first.messages[0].content).toContain('docs:review: Review a change the team way');
		// `/docs:review …` told the model which skill to load.
		expect(first.messages.at(-1).content).toContain('load it with ReadSkill (server "docs", uri "skill://review/SKILL.md")');
		const ask = events().find((e) => e.kind === 'permission_request') as any;
		expect(ask).toMatchObject({ tool: 'ReadSkill', title: 'Allow skills from docs?', rules: ['ReadSkill(server:docs)'] });
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'answer', params: { runId: 1, requestId: ask.request_id, decision: 'allow' } }));
		await until(() => events().some((e) => e.kind === 'result'));
		const result = events().find((e) => e.kind === 'tool_result') as Extract<AgentEvent, { kind: 'tool_result' }>;
		expect(result.is_error).toBe(false);
		expect(result.content).toContain('# Review');
	});
});
