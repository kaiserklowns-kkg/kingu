/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import { validate } from '../settings/registry';
import {
	expandCommand,
	expandEnv,
	filterSnaps,
	installSummary,
	isActive,
	isUpdatable,
	lockNote,
	enforcementLabel,
	mcpServersOf,
	originLabel,
	pendingTrustCount,
	permissionDiff,
	runnableTasks,
	sandboxPlan,
	sandboxTask,
	skillSnapIds,
	snapSettingSchemas,
	snapStatus,
	taskArgv,
	touchesRepoSnaps,
	trustSummary,
	updateSummary,
	type SandboxInfo,
	type SnapInfo
} from './snapModel';

// These tests check the Thai wording.
beforeAll(() => setLocale('th'));
afterAll(() => setLocale('en'));

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
		skills: [],
		scripts: [],
		origin: null,
		lock: null,
		approvedPermissions: null,
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
	test('an empty program empties the argv instead of promoting the next argument', () => {
		const s = snap({ tasks: [{ id: 't', title: 'T', command: ['${setting:testFlags}', 'rm', '-rf'] }] });
		expect(taskArgv(s, s.tasks[0], () => '')).toEqual([]);
		expect(taskArgv(s, s.tasks[0], () => 'echo')).toEqual(['echo', 'rm', '-rf']);
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

describe('MCP settings', () => {
	const go = snap({
		mcp: [{ name: 'gopls', command: ['gopls', '${setting:testFlags}', '--count=${setting:count}'], env: { FLAGS: '${setting:testFlags}', MODE: 'v=${setting:verbose}', PLAIN: 'x' } }]
	});

	test('env follows the command rules: whole value or dropped when empty, else text replace, one pass', () => {
		expect(expandEnv({ A: '${setting:a}', B: 'p=${setting:a}', C: '${setting:none}', D: '' }, { a: '-race -v' })).toEqual({ A: '-race -v', B: 'p=-race -v', D: '' });
		expect(expandEnv({ A: '${setting:a}' }, { a: '${setting:b}', b: 'no' })).toEqual({ A: '${setting:b}' });
	});

	test('servers get the settings through the settings service, defaults otherwise', () => {
		expect(mcpServersOf([go])).toEqual({ 'go-gopls': { command: 'gopls', args: ['-race', '--count=3'], env: { FLAGS: '-race', MODE: 'v=false', PLAIN: 'x' } } });
		const values: Record<string, unknown> = { 'snap.go.testFlags': '', 'snap.go.verbose': true };
		expect(mcpServersOf([go], (id) => values[id])).toEqual({ 'go-gopls': { command: 'gopls', args: ['--count=3'], env: { MODE: 'v=true', PLAIN: 'x' } } });
	});

	test('a server whose program expands to nothing is left out', () => {
		const s = snap({ mcp: [{ name: 'x', command: ['${setting:testFlags}', 'serve'], env: {} }] });
		expect(mcpServersOf([s], () => '')).toEqual({});
		expect(mcpServersOf([s], () => 'my-server')).toEqual({ 'go-x': { command: 'my-server', args: ['serve'], env: {} } });
	});
});

describe('skills and reloads', () => {
	const skill = { name: 'go-style', path: 'skills/go-style', description: '' };

	test('only active snaps with skills hand them to agents', () => {
		const list = [
			snap({ skills: [skill] }),
			snap({ id: 'plain' }),
			snap({ id: 'lint', source: 'repo', trusted: false, skills: [skill] }),
			snap({ id: 'old', overridden: true, skills: [skill] }),
			snap({ id: 'bad', error: 'x', skills: [skill] })
		];
		expect(skillSnapIds(list)).toEqual(['go']);
	});

	test('reloads for changes under .kingu/snaps or a rescan, not worktrees or other .kingu files', () => {
		expect(touchesRepoSnaps(['.kingu/snaps/go/snap.toml'])).toBe(true);
		expect(touchesRepoSnaps(['src/a.ts', '.kingu/snaps/go/skills/go-style/SKILL.md'])).toBe(true);
		expect(touchesRepoSnaps(['.kingu/snaps'])).toBe(true);
		expect(touchesRepoSnaps(['.kingu'])).toBe(true);
		expect(touchesRepoSnaps([''])).toBe(true);
		expect(touchesRepoSnaps(['.kingu/worktrees/fix/.kingu/snaps/go/snap.toml', '.kingu/settings.json', '.kingu/snapshots', 'src/.kingu/snaps/x'])).toBe(false);
	});
});

describe('Snaps view', () => {
	test('row status: error, overridden, untrusted, active', () => {
		expect(snapStatus(snap({ error: 'bad' })).label).toBe('error');
		expect(snapStatus(snap({ overridden: true })).key).toBe('overridden');
		expect(snapStatus(snap({ source: 'repo', trusted: false })).label).toBe('ต้อง trust');
		expect(snapStatus(snap()).key).toBe('active');
	});
	test('lock notes and the pending trust badge', () => {
		expect(lockNote(snap({ source: 'repo', lock: 'changed' }))).toBe('ไม่ตรงกับ snaps.lock — ต้องอนุมัติใหม่');
		expect(lockNote(snap({ source: 'repo', lock: 'unlocked' }))).toBe('ไม่อยู่ใน lock');
		expect(lockNote(snap({ source: 'repo', lock: 'locked' }))).toBeNull();
		const list = [snap({ source: 'repo', trusted: false }), snap({ source: 'repo', trusted: false, error: 'x' }), snap({ source: 'repo' }), snap({ trusted: true })];
		expect(pendingTrustCount(list)).toBe(1);
	});
	test('search matches every word in name, id, description or task titles', () => {
		const list = [snap(), snap({ id: 'pg', name: 'Postgres', description: 'query the DB', tasks: [] })];
		expect(filterSnaps(list, '').length).toBe(2);
		expect(filterSnaps(list, 'POST').map((s) => s.id)).toEqual(['pg']);
		expect(filterSnaps(list, 'run tests').map((s) => s.id)).toEqual(['go']);
		expect(filterSnaps(list, 'go db')).toEqual([]);
	});
	test('origin label and updatable', () => {
		const origin = { url: 'https://x/go.git', ref: 'v1', commit: '0123456789abcdef', path: null, installed_at: 1 };
		expect(originLabel(origin)).toBe('https://x/go.git#v1 @ 0123456');
		expect(originLabel({ ...origin, url: null, path: '/src/go' })).toBe('/src/go');
		expect(isUpdatable(snap({ origin }))).toBe(true);
		expect(isUpdatable(snap({ origin: { ...origin, url: null, path: '/p' } }))).toBe(false);
		expect(isUpdatable(snap({ source: 'repo', origin }))).toBe(false);
	});
	test('permission diff calls out what an update adds', () => {
		const before = { network: false, fs: 'worktree' as const, secrets: ['A'] };
		const after = { network: true, fs: 'home' as const, secrets: ['B'] };
		expect(permissionDiff(before, after)).toEqual({ added: ['ใช้เครือข่าย (network)', 'เข้าถึงทั้งโฮมโฟลเดอร์ (fs = home)', 'secret B'], removed: ['secret A'] });
		expect(permissionDiff(after, after)).toEqual({ added: [], removed: [] });
		const origin = { url: 'https://x/go.git', ref: null, commit: null, path: null, installed_at: 0 };
		const text = updateSummary(snap({ version: '1', permissions: before }), snap({ version: '2', permissions: after }), origin);
		expect(text).toContain('v1 → v2');
		expect(text).toContain('⚠ สิทธิ์ใหม่ที่ขอเพิ่ม:\n• ใช้เครือข่าย (network)');
		expect(text).toContain('สิทธิ์ที่เลิกใช้:\n• secret A');
		expect(updateSummary(snap(), snap(), origin)).toContain('สิทธิ์ไม่เปลี่ยน');
	});
	test('install summary shows source, permissions and contributions', () => {
		const text = installSummary(snap(), { url: 'https://x/go.git', ref: null, commit: 'abcdef0123', path: null, installed_at: 0 });
		expect(text).toContain('จาก: https://x/go.git @ abcdef0');
		expect(text).toContain('• เครือข่าย (network): ไม่ใช้');
		expect(text).toContain('• งาน 1: Run tests');
		expect(text).toContain('• MCP server 1: gopls');
	});
	test('trust summary lists the exact commands', () => {
		const text = trustSummary(snap({ source: 'repo', trusted: false }));
		expect(text).toContain('• งาน Run tests: go test ${setting:testFlags} ./...');
		expect(text).toContain('• MCP gopls: gopls mcp');
	});
	test('the lock file change reloads repo snaps', () => {
		expect(touchesRepoSnaps(['.kingu/snaps.lock'])).toBe(true);
	});
});

describe('sandbox', () => {
	const info: SandboxInfo = { enforcer: 'sandbox-exec', launcher: '/App/kingu-ptyd', protect: ['/cfg'], problem: null };
	const enforce = sandboxPlan(info, 'enforce');

	test('the plan: enforce by default, off only when the user says so, refuse without an enforcer', () => {
		expect(enforce).toEqual({ kind: 'enforce', launcher: '/App/kingu-ptyd', enforcer: 'sandbox-exec', protect: ['/cfg'] });
		expect(sandboxPlan(info, undefined).kind).toBe('enforce');
		expect(sandboxPlan(info, 'off')).toEqual({ kind: 'off' });
		expect(sandboxPlan(null, 'off')).toEqual({ kind: 'off' });
		expect(sandboxPlan({ enforcer: null, launcher: '/k', protect: [], problem: 'ไม่พบ bwrap' }, 'enforce')).toEqual({ kind: 'refuse', reason: 'ไม่พบ bwrap' });
		expect(sandboxPlan(null, 'enforce').kind).toBe('refuse');
	});

	test('a task runs through the launcher with its permissions; the argv stays separate arguments', () => {
		const p = { network: false, fs: 'worktree' as const, secrets: ['GITHUB_TOKEN'] };
		expect(sandboxTask(enforce, p, '/w/my repo', ['go', 'test', '-run', 'A B'])).toEqual({
			run: ['/App/kingu-ptyd', 'snap-exec', '--network', 'off', '--fs', 'worktree', '--root', '/w/my repo', '--secret', 'GITHUB_TOKEN', '--protect', '/cfg', '--', 'go', 'test', '-run', 'A B']
		});
		expect(sandboxTask({ kind: 'off' }, p, '/w', ['make'])).toEqual({ run: ['make'] });
		const refused = sandboxTask({ kind: 'refuse', reason: 'ไม่พบ bwrap' }, p, '/w', ['make']);
		expect('error' in refused && refused.error).toContain('ไม่พบ bwrap');
		expect('error' in refused && refused.error).toContain('kingu.snaps.sandbox');
	});

	test('MCP servers: the launcher becomes the command, the server argv its arguments, env names kept', () => {
		const s = snap({ permissions: { network: true, fs: 'home', secrets: [] } });
		expect(mcpServersOf([s], undefined, { plan: enforce, root: '/w/.kingu/worktrees/t1' })).toEqual({
			'go-gopls': {
				command: '/App/kingu-ptyd',
				args: ['snap-exec', '--network', 'on', '--fs', 'home', '--root', '/w/.kingu/worktrees/t1', '--keep', 'GOFLAGS', '--protect', '/cfg', '--', 'gopls', 'mcp'],
				env: { GOFLAGS: '-mod=mod' }
			}
		});
		// Refused, or no folder to confine to: the servers are left out, never run unconfined.
		expect(mcpServersOf([s], undefined, { plan: { kind: 'refuse', reason: 'x' }, root: '/w' })).toEqual({});
		expect(mcpServersOf([s], undefined, { plan: enforce, root: null })).toEqual({});
		expect(mcpServersOf([s], undefined, { plan: { kind: 'off' }, root: null })).toEqual({ 'go-gopls': { command: 'gopls', args: ['mcp'], env: { GOFLAGS: '-mod=mod' } } });
	});

	test('the details label and the confirm note say whether permissions are enforced', () => {
		const origin = { url: null, ref: null, commit: null, path: '/src', installed_at: 0 };
		expect(enforcementLabel(enforce)).toEqual({ text: 'บังคับใช้: sandbox-exec', tone: 'ok' });
		expect(enforcementLabel({ kind: 'off' }).text).toContain('ไม่ได้บังคับ');
		expect(enforcementLabel({ kind: 'refuse', reason: 'ไม่พบ bwrap' })).toEqual({ text: 'ไม่ได้บังคับ (ไม่พบ bwrap) — งานและ MCP server ของ snap จะไม่รัน', tone: 'error' });
		expect(trustSummary(snap({ source: 'repo', trusted: false }), enforce)).toContain('Kingu บังคับใช้สิทธิ์เหล่านี้ด้วย sandbox-exec');
		expect(installSummary(snap(), origin, { kind: 'off' })).toContain('⚠ ไม่ได้บังคับใช้สิทธิ์');
		expect(updateSummary(snap(), snap(), origin, enforce)).toContain('บังคับใช้สิทธิ์');
	});
});
