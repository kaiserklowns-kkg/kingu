import { describe, expect, test } from 'bun:test';
import { checkOf, isOff, setTools, splitSessionTools, toolGroups, toolSetContext, toolSetRefs, validToolName, type ToolSet } from './chatTools.ts';

const set = (name: string, resolved: string[], description = ''): ToolSet => ({ name, description, icon: null, tools: resolved, resolved, unknown: [], path: `/w/.vscode/${name}.toolsets.jsonc`, rel: '', user: false });
const SETS = [set('reader', ['Glob', 'Grep', 'Read'], 'Tools for reading'), set('my.web', ['WebFetch']), set('gh', ['mcp__github'])];
const SERVERS = [{ name: 'github', tools: ['search', 'create_issue'] }];

describe('chat tools', () => {
	test('off follows the SDK rules', () => {
		expect(isOff('Bash', ['Bash'])).toBe(true);
		expect(isOff('mcp__github__search', ['mcp__github'])).toBe(true);
		expect(isOff('mcp__github__search', ['mcp__github__*'])).toBe(true);
		expect(isOff('mcp__github__search', ['mcp__*'])).toBe(true);
		expect(isOff('mcp__githubx__search', ['mcp__github'])).toBe(false);
		expect(isOff('Read', ['mcp__*'])).toBe(false);
		expect([checkOf(['Read', 'Grep'], []), checkOf(['Read', 'Grep'], ['Read']), checkOf(['Read', 'Grep'], ['Grep', 'Read']), checkOf([], ['Read'])]).toEqual(['on', 'mixed', 'off', 'on']);
		expect([validToolName('mcp__a-b__c.d'), validToolName('Bash; rm'), validToolName('')]).toEqual([true, false, false]);
	});

	test('turns tools on and off, a server tool out of a server that is off', () => {
		expect(setTools([], ['Bash', 'Bash', 'bad name'], false)).toEqual(['Bash']);
		expect(setTools(['Bash'], ['mcp__github'], false)).toEqual(['Bash', 'mcp__github']);
		expect(setTools(['mcp__github'], ['mcp__github__search'], false), 'already off through its server').toEqual(['mcp__github']);
		expect(setTools(['Bash', 'Read'], ['Read'], true)).toEqual(['Bash']);
		expect(setTools(['mcp__github'], ['mcp__github__search'], true, SERVERS)).toEqual(['mcp__github__create_issue']);
		expect(setTools(['mcp__github'], ['mcp__github'], true, SERVERS)).toEqual([]);
		expect(setTools(['mcp__*'], ['mcp__github__search'], true, SERVERS), 'all MCP off stays').toEqual(['mcp__*']);
	});

	test('lists tool sets, built-in tools and each MCP server', () => {
		const groups = toolGroups({ sets: [...SETS, set('empty', [])], builtins: ['Read', 'Bash', 'Read', 'mcp__x__y'], servers: [...SERVERS, { name: 'idle', tools: [] }] }, { sets: 'Tool sets', builtin: 'Built-in' });
		expect(groups.map((g) => [g.id, g.tools, g.rows.map((r) => r.label)])).toEqual([
			['sets', ['Glob', 'Grep', 'Read', 'WebFetch', 'mcp__github'], ['#reader', '#my.web', '#gh']],
			['builtin', ['Read', 'Bash'], ['Read', 'Bash']],
			['mcp:github', ['mcp__github'], ['search', 'create_issue']],
			['mcp:idle', ['mcp__idle'], []]
		]);
		expect(groups[0].rows[0]).toEqual({ id: 'set:reader', label: '#reader', description: 'Tools for reading', tools: ['Glob', 'Grep', 'Read'] });
		expect(groups[2].rows[1].tools).toEqual(['mcp__github__create_issue']);
		expect(splitSessionTools(['Bash', 'mcp__github__search', 'mcp__my_srv__do_it'])).toEqual({ builtins: ['Bash'], servers: [{ name: 'github', tools: ['search'] }, { name: 'my_srv', tools: ['do_it'] }] });
	});

	test('#set references in a prompt', () => {
		expect(toolSetRefs('Check it #reader, then #my.web. And #reader again', SETS).map((s) => s.name)).toEqual(['reader', 'my.web']);
		expect(toolSetRefs('#READER first', SETS).map((s) => s.name)).toEqual(['reader']);
		expect(toolSetRefs('no#reader here, #unknown, #file:src/a.ts', SETS)).toEqual([]);
		expect(toolSetContext(toolSetRefs('#reader #gh', SETS))).toBe('#reader: Glob, Grep, Read (Tools for reading)\n#gh: mcp__github');
	});
});
