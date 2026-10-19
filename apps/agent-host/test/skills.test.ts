// The skill index other runtimes get (src/skills.ts): reading the plugin folders, the front
// matter, the index text, and how Codex and ACP agents receive it (fake agents, no model).

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHost } from '../src/host.ts';
import { frontMatter, MAX_DESCRIPTION, MAX_SKILLS, readSkills, skillIndex, type SkillFs } from '../src/skills.ts';

const dirs: string[] = [];
const hosts: AgentHost[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.dispatch('shutdown', null)));
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
	const d = realpathSync(mkdtempSync(join(tmpdir(), 'kingu-skills-')));
	dirs.push(d);
	return d;
};

/** A plugin folder holding these skills (folder -> SKILL.md text). */
function plugin(skills: Record<string, string>): string {
	const dir = tmp();
	for (const [folder, text] of Object.entries(skills)) {
		mkdirSync(join(dir, 'skills', folder), { recursive: true });
		writeFileSync(join(dir, 'skills', folder, 'SKILL.md'), text);
	}
	return dir;
}

describe('front matter', () => {
	test('plain, quoted and block values', () => {
		expect(frontMatter('---\nname: pdf\ndescription: Read and fill PDF forms\n---\n# PDF')).toEqual({ name: 'pdf', description: 'Read and fill PDF forms' });
		expect(frontMatter('---\nname: "a-b"\ndescription: \'It\'\'s: quoted\'\n---')).toEqual({ name: 'a-b', description: "It's: quoted" });
		expect(frontMatter('---\nname: x\ndescription: >\n  Folded over\n  two lines.\nlicense: MIT\n---')).toEqual({ name: 'x', description: 'Folded over two lines.' });
		expect(frontMatter('---\nname: x\ndescription: starts here\n  and goes on\nallowed-tools: Bash\n---')).toEqual({ name: 'x', description: 'starts here and goes on' });
		expect(frontMatter('﻿---\r\nname: crlf\r\n---\r\n')).toEqual({ name: 'crlf' });
	});

	test('no front matter', () => {
		expect(frontMatter('# Just a heading\nname: not front matter')).toEqual({});
		expect(frontMatter('')).toEqual({});
	});
});

describe('readSkills', () => {
	test('skills of each plugin in order; a repeated name, hidden folders and folders without SKILL.md are skipped', () => {
		const a = plugin({ pdf: '---\nname: pdf\ndescription: PDFs\n---', 'no-front': 'Just text', '.hidden': '---\nname: hidden\n---' });
		mkdirSync(join(a, 'skills', 'empty'));
		const b = plugin({ other: '---\nname: pdf\ndescription: a second pdf\n---', go: '---\nname: go\ndescription: "Go\n  code"\n---' });
		const list = readSkills([a, join(a, 'missing'), b]);
		expect(list).toEqual([
			{ name: 'no-front', description: '', path: join(a, 'skills', 'no-front', 'SKILL.md') },
			{ name: 'pdf', description: 'PDFs', path: join(a, 'skills', 'pdf', 'SKILL.md') },
			{ name: 'go', description: 'Go code', path: join(b, 'skills', 'go', 'SKILL.md') }
		]);
	});

	test('bounds: the number of skills and the description length', () => {
		const files = new Map<string, string>();
		for (let i = 0; i < MAX_SKILLS + 5; i++) files.set(`/p/skills/s${String(i).padStart(3, '0')}/SKILL.md`, `---\ndescription: ${'d'.repeat(MAX_DESCRIPTION + 50)}\n---`);
		const fs: SkillFs = {
			list: (dir) => [...new Set([...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1).split('/')[0]!))],
			isFile: (path) => files.has(path),
			head: (path) => files.get(path)!
		};
		const list = readSkills(['/p'], fs);
		expect(list.length).toBe(MAX_SKILLS);
		expect(list[0]!.description.length).toBe(MAX_DESCRIPTION);
		expect(list[0]!.description.endsWith('…')).toBe(true);
	});
});

describe('skillIndex', () => {
	test('empty without skills; otherwise names, descriptions and paths', () => {
		expect(skillIndex([])).toBe('');
		const text = skillIndex([
			{ name: 'pdf', description: 'PDFs', path: '/c/skills/pdf/SKILL.md' },
			{ name: 'bare', description: '', path: '/c/skills/bare/SKILL.md' }
		]);
		expect(text.startsWith('# Skills\n')).toBe(true);
		expect(text).toContain('read its SKILL.md');
		expect(text).toContain('- pdf: PDFs\n  /c/skills/pdf/SKILL.md');
		expect(text).toContain('- bare\n  /c/skills/bare/SKILL.md');
	});
});

describe('runtimes get the index', () => {
	function setup() {
		const cwd = tmp();
		const out: any[] = [];
		const waiters: { pred: (o: any) => boolean; resolve: (o: any) => void }[] = [];
		const host = new AgentHost({
			query: () => {
				throw new Error('the Claude SDK must not run');
			},
			write: (m) => {
				const o = JSON.parse(JSON.stringify(m));
				out.push(o);
				for (const w of [...waiters]) if (w.pred(o)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(o));
			},
			newId: () => 'req'
		});
		hosts.push(host);
		const next = (pred: (o: any) => boolean) =>
			new Promise<any>((resolve, reject) => {
				const hit = out.find(pred);
				if (hit) return resolve(hit);
				waiters.push({ pred, resolve });
				setTimeout(() => reject(new Error('timed out waiting for host output')), 8000);
			});
		const isEvent = (o: any, kind: string) => o.method === 'event' && o.params.event.kind === kind;
		const stderrLines = () => out.filter((o) => isEvent(o, 'stderr')).map((o) => o.params.event.line as string);
		const results = (n: number) => next(() => out.filter((o) => isEvent(o, 'result')).length >= n).then(() => out.filter((o) => isEvent(o, 'result')).map((o) => o.params.event));
		const call = async (id: number, method: string, params: unknown) => {
			await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
			return out.findLast((o) => o.id === id);
		};
		return { cwd, call, results, stderrLines };
	}
	const skillsPlugin = () => plugin({ pdf: '---\nname: pdf\ndescription: PDFs\n---' });

	test('Codex: as developer instructions of the thread', async () => {
		const { cwd, call, results, stderrLines } = setup();
		const runtime = { kind: 'codex', command: process.execPath, args: [join(import.meta.dir, 'fixtures/fake-codex.ts')] };
		await call(1, 'start', { runId: 1, cwd, prompt: 'hi', runtime, plugins: [skillsPlugin()] });
		expect((await results(1))[0]).toMatchObject({ is_error: false, result: 'echo: hi' });
		expect(stderrLines()).toContain('got thread/start untrusted workspace-write +skills');
	});

	test('ACP: before the first message of the run only', async () => {
		const { cwd, call, results, stderrLines } = setup();
		const runtime = { kind: 'acp', command: process.execPath, args: [join(import.meta.dir, 'fixtures/fake-acp.ts')] };
		await call(1, 'start', { runId: 1, cwd, prompt: 'hi', runtime, plugins: [skillsPlugin()] });
		expect((await results(1))[0]).toMatchObject({ is_error: false, result: 'echo: hi' });
		await call(2, 'send', { runId: 1, text: 'again' });
		expect((await results(2))[1]).toMatchObject({ result: 'echo: again' });
		expect(stderrLines().filter((l) => l === 'got skills').length).toBe(1);
	});

	test('no plugins: nothing added', async () => {
		const { cwd, call, results, stderrLines } = setup();
		const runtime = { kind: 'codex', command: process.execPath, args: [join(import.meta.dir, 'fixtures/fake-codex.ts')] };
		await call(1, 'start', { runId: 1, cwd, prompt: 'hi', runtime });
		await results(1);
		expect(stderrLines()).toContain('got thread/start untrusted workspace-write');
	});
});
