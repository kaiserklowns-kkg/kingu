/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { validate } from '../settings/registry';
import { expandCommand, isActive, mcpServersOf, runnableTasks, snapSettingSchemas, taskArgv, type SnapInfo } from './snapModel';

function snap(over: Partial<SnapInfo> = {}): SnapInfo {
	return {
		id: 'go',
		name: 'Go',
		version: '0.1.0',
		description: '',
		source: 'user',
		dir: '/x/snaps/go',
		trusted: true,
		error: null,
		overridden: false,
		hash: 'h',
		permissions: { network: false, fs: 'worktree', secrets: [] },
		tasks: [{ id: 'test', title: 'Run tests', command: ['go', 'test', '${setting:testFlags}', './...'] }],
		settings: [
			{ key: 'testFlags', type: 'string', default: '-race', description: 'flags for go test' },
			{ key: 'verbose', type: 'boolean', default: false, description: '' },
			{ key: 'count', type: 'number', default: 3, description: '' }
		],
		mcp: [{ name: 'gopls', command: ['gopls', 'mcp'], env: { GOFLAGS: '-mod=mod' } }],
		...over
	};
}

describe('expandCommand', () => {
	test('replaces a whole-argument placeholder with the whole value (not split)', () => {
		expect(expandCommand(['go', 'test', '${setting:testFlags}', './...'], { testFlags: '-race -v' })).toEqual(['go', 'test', '-race -v', './...']);
	});
	test('drops a whole-argument placeholder whose value is empty', () => {
		expect(expandCommand(['go', 'test', '${setting:testFlags}', './...'], { testFlags: '' })).toEqual(['go', 'test', './...']);
		expect(expandCommand(['x', '${setting:missing}'], {})).toEqual(['x']);
	});
	test('substitutes inside an argument and stringifies booleans and numbers', () => {
		expect(expandCommand(['--count=${setting:count}', '-v=${setting:verbose}', '--f=${setting:none}'], { count: 3, verbose: false })).toEqual(['--count=3', '-v=false', '--f=']);
		expect(expandCommand(['${setting:a}${setting:b}'], { a: 'x', b: 'y' })).toEqual(['xy']);
	});
	test('leaves other dollar syntax alone', () => {
		expect(expandCommand(['echo', '$HOME', '${env:X}'], {})).toEqual(['echo', '$HOME', '${env:X}']);
	});
	test('does not re-expand a value that looks like a placeholder', () => {
		expect(expandCommand(['${setting:a}', 'p=${setting:a}'], { a: '${setting:b}', b: 'no' })).toEqual(['${setting:b}', 'p=${setting:b}']);
	});
});

describe('taskArgv', () => {
	test('reads values through the settings service, falling back to the default', () => {
		const s = snap();
		expect(taskArgv(s, s.tasks[0], () => undefined)).toEqual(['go', 'test', '-race', './...']);
		expect(taskArgv(s, s.tasks[0], (id) => (id === 'snap.go.testFlags' ? '' : undefined))).toEqual(['go', 'test', './...']);
	});
});

describe('contributions', () => {
	const untrusted = snap({ id: 'lint', name: 'Lint', source: 'repo', trusted: false });
	const broken = snap({ id: 'bad', error: 'อ่าน snap.toml ไม่ได้' });
	const shadowed = snap({ overridden: true });
	const repoGo = snap({ source: 'repo', trusted: true, mcp: [] });

	test('only valid, trusted, unshadowed snaps run tasks and MCP servers', () => {
		expect(isActive(snap())).toBe(true);
		for (const s of [untrusted, broken, shadowed]) expect(isActive(s)).toBe(false);
		expect(runnableTasks([snap(), untrusted, broken]).map((r) => `${r.snap.id}.${r.task.id}`)).toEqual(['go.test']);
		expect(mcpServersOf([snap(), untrusted, broken, shadowed])).toEqual({ 'go-gopls': { command: 'gopls', args: ['mcp'], env: { GOFLAGS: '-mod=mod' } } });
		expect(mcpServersOf([shadowed, repoGo])).toEqual({});
	});

	test('settings schemas: one group per snap, user snaps user-only, untrusted shown, broken not', () => {
		const schemas = snapSettingSchemas([snap(), untrusted, broken, shadowed]);
		expect(schemas.map((s) => s.id)).toEqual(['snap.go.testFlags', 'snap.go.verbose', 'snap.go.count', 'snap.lint.testFlags', 'snap.lint.verbose', 'snap.lint.count']);
		expect(new Set(schemas.map((s) => s.group))).toEqual(new Set(['Snap: Go', 'Snap: Lint']));
		expect(schemas[0].scope).toBe('application');
		expect(schemas[3].scope).toBeUndefined();
		for (const s of schemas) expect(validate(s, s.default)).toEqual(s.default);
		expect(schemas[2]).toMatchObject({ type: 'number', default: 3 });
	});
});
