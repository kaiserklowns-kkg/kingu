/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import { validate } from '../settings/registry';
import {
	expandCommand,
	expandEnv,
	agentReach,
	audiences,
	catalogEntries,
	filterSnaps,
	hookRunsOf,
	inSnapDir,
	missingRequirements,
	requiredPrograms,
	requirementStates,
	serviceChanges,
	snapAvatar,
	snapThemesOf,
	toggleDisabled,
	wantedServices,
	withDisabled,
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
		hooks: [],
		requires: [],
		services: [],
		readme: null,
		files: [],
		themes: [],
		origin: null,
		lock: null,
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

	test('active snaps with hooks get a plugin too', () => {
		const hook = { event: 'Stop', command: ['mem', 'stop'], env: {} };
		expect(skillSnapIds([snap({ id: 'mem', hooks: [hook] }), snap({ id: 'off', trusted: false, source: 'repo', hooks: [hook] })])).toEqual(['mem']);
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
		expect(snapStatus(snap({ error: 'bad' })).label).toBe('ใช้งานไม่ได้');
		expect(snapStatus(snap({ overridden: true })).key).toBe('overridden');
		expect(snapStatus(snap({ source: 'repo', trusted: false })).label).toBe('ต้อง trust');
		expect(snapStatus(snap()).key).toBe('active');
	});
	test('lock notes and the pending trust badge', () => {
		expect(lockNote(snap({ source: 'repo', lock: 'changed' }))).toBe('เปลี่ยนจาก lock');
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
		// With the snap named, the launcher also reads its keychain secrets (only when it declares some).
		expect(sandboxTask(enforce, p, '/w', ['x'], 'go')).toEqual({ run: ['/App/kingu-ptyd', 'snap-exec', '--network', 'off', '--fs', 'worktree', '--root', '/w', '--snap', 'go', '--secret', 'GITHUB_TOKEN', '--protect', '/cfg', '--', 'x'] });
		expect(sandboxTask(enforce, { ...p, secrets: [] }, '/w', ['x'], 'go')).toEqual({ run: ['/App/kingu-ptyd', 'snap-exec', '--network', 'off', '--fs', 'worktree', '--root', '/w', '--protect', '/cfg', '--', 'x'] });
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

	test('hooks: settings expanded, env through `env`, confined like MCP servers', () => {
		const s = snap({
			id: 'mem',
			permissions: { network: true, fs: 'home', secrets: [] },
			settings: [{ key: 'bin', type: 'string', default: 'ai-memory', description: '' }],
			hooks: [
				{ event: 'SessionStart', command: ['${setting:bin}', 'hook', '--event', 'session-start'], env: { ORIGIN: 'kingu' } },
				{ event: 'Stop', command: ['${setting:bin}', 'hook', '--event', 'stop'], env: {} }
			]
		});
		expect(hookRunsOf([s], () => undefined, { plan: enforce, root: '/w/t1' })).toEqual({
			mem: [
				{ event: 'SessionStart', argv: ['env', 'ORIGIN=kingu', '/App/kingu-ptyd', 'snap-exec', '--network', 'on', '--fs', 'home', '--root', '/w/t1', '--keep', 'ORIGIN', '--protect', '/cfg', '--', 'ai-memory', 'hook', '--event', 'session-start'] },
				{ event: 'Stop', argv: ['/App/kingu-ptyd', 'snap-exec', '--network', 'on', '--fs', 'home', '--root', '/w/t1', '--protect', '/cfg', '--', 'ai-memory', 'hook', '--event', 'stop'] }
			]
		});
		expect(hookRunsOf([s], () => '/opt/am', { plan: { kind: 'off' }, root: null }).mem[1]).toEqual({ event: 'Stop', argv: ['/opt/am', 'hook', '--event', 'stop'] });
		// Refused, no folder, an empty program, or an inactive snap: no hooks, never unconfined.
		expect(hookRunsOf([s], () => undefined, { plan: { kind: 'refuse', reason: 'x' }, root: '/w' })).toEqual({});
		expect(hookRunsOf([s], () => undefined, { plan: enforce, root: null })).toEqual({});
		expect(hookRunsOf([s], () => '', { plan: { kind: 'off' }, root: null })).toEqual({});
		expect(hookRunsOf([{ ...s, trusted: false, source: 'repo' }], () => undefined, { plan: { kind: 'off' }, root: null })).toEqual({});
		expect(trustSummary({ ...s, source: 'repo', trusted: false })).toContain('hook SessionStart: ${setting:bin} hook --event session-start');
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

describe('enable / disable', () => {
	test('disabled snaps are listed but inactive; toggling keeps other ids', () => {
		const list = withDisabled([snap(), snap({ id: 'mem' })], ['mem', 42]);
		expect(list.map((s) => [s.id, !!s.disabled, isActive(s)])).toEqual([
			['go', false, true],
			['mem', true, false]
		]);
		expect(snapStatus(list[1]).key).toBe('disabled');
		expect(toggleDisabled(['a', 'mem'], 'mem', true)).toEqual(['a']);
		expect(toggleDisabled(['b'], 'a', false)).toEqual(['a', 'b']);
		expect(toggleDisabled(undefined, 'a', false)).toEqual(['a']);
		// An unchanged snap stays the same object (no needless re-renders).
		const once = withDisabled([snap()], []);
		expect(withDisabled(once, [])[0]).toBe(once[0]);
	});
});

describe('requirements and services', () => {
	const info: SandboxInfo = { enforcer: 'sandbox-exec', launcher: '/App/kingu-ptyd', protect: [], problem: null };
	const enforce = sandboxPlan(info, 'enforce');
	const mem = snap({
		id: 'mem',
		permissions: { network: true, fs: 'home', secrets: [] },
		settings: [
			{ key: 'bin', type: 'string', default: 'ai-memory', description: '' },
			{ key: 'run', type: 'boolean', default: true, description: '' }
		],
		requires: [{ program: 'ai-memory', setting: 'bin', url: 'https://x', install_task: 'install', description: '' }],
		services: [{ id: 'server', title: 'Server', command: ['${setting:bin}', 'serve'], env: { ORIGIN: 'k' }, autostart: true, when: 'run' }]
	});
	const found = { 'ai-memory': { path: '/u/.local/bin/ai-memory', onPath: true } };

	test('the program comes from its setting when set; missing only once looked up', () => {
		expect(requiredPrograms([mem], () => undefined)).toEqual(['ai-memory']);
		expect(requiredPrograms([mem], (id) => (id === 'snap.mem.bin' ? '/opt/am' : undefined))).toEqual(['/opt/am']);
		expect(missingRequirements(requirementStates(mem, () => undefined, {}))).toEqual([]);
		expect(missingRequirements(requirementStates(mem, () => undefined, { 'ai-memory': { path: null, onPath: false } })).map((r) => r.program)).toEqual(['ai-memory']);
	});

	test('wanted services: active, setting on, requirements installed, confined', () => {
		expect(wantedServices([mem], () => undefined, enforce, '/Users/me', found)).toEqual([
			{ snap: 'mem', service: 'server', title: 'Server', argv: ['/App/kingu-ptyd', 'snap-exec', '--network', 'on', '--fs', 'home', '--root', '/Users/me', '--keep', 'ORIGIN', '--', 'ai-memory', 'serve'], env: [['ORIGIN', 'k']] }
		]);
		expect(wantedServices([mem], (id) => (id === 'snap.mem.run' ? false : undefined), enforce, '/Users/me', found)).toEqual([]);
		expect(wantedServices([{ ...mem, disabled: true }], () => undefined, enforce, '/Users/me', found)).toEqual([]);
		expect(wantedServices([mem], () => undefined, enforce, '/Users/me', { 'ai-memory': { path: null, onPath: false } })).toEqual([]);
		expect(wantedServices([mem], () => undefined, { kind: 'refuse', reason: 'x' }, '/Users/me', found)).toEqual([]);
		expect(wantedServices([mem], () => undefined, { kind: 'off' }, null, found)[0].argv).toEqual(['ai-memory', 'serve']);
	});

	test('start what is wanted and not running; stop what runs and is not wanted', () => {
		const w = wantedServices([mem], () => undefined, { kind: 'off' }, null, found);
		const st = (snapId: string, running: boolean) => ({ snapId, serviceId: 'server', running, pid: 1, startedAt: 0, endedAt: null, exitCode: null, stopped: false, log: '' });
		expect(serviceChanges(w, []).start.length).toBe(1);
		expect(serviceChanges(w, [st('mem', true)])).toEqual({ start: [], stop: [] });
		expect(serviceChanges([], [st('mem', true), st('old', false)]).stop.map((x) => x.snapId)).toEqual(['mem']);
	});
});

describe('catalog and audiences', () => {
	test('shipped snaps: available, installed, or an update when the version moved on', () => {
		const shipped = [snap({ id: 'mem', version: '0.3.0', hash: 'b' }), snap({ id: 'go', hash: 'h' }), snap({ id: 'bad', error: 'x' })];
		const list = [snap({ id: 'go', hash: 'h' }), snap({ id: 'mem', version: '0.2.0', hash: 'a' })];
		expect(catalogEntries(shipped, list).map((e) => [e.snap.id, e.state])).toEqual([
			['mem', 'update'],
			['go', 'installed']
		]);
		expect(catalogEntries(shipped, []).map((e) => e.state)).toEqual(['available', 'available']);
		// A repo snap with the same id is not an install of the shipped one.
		expect(catalogEntries([snap({ id: 'go' })], [snap({ id: 'go', source: 'repo' })])[0].state).toBe('available');
	});

	test('for you vs for agents, and which agents get what', () => {
		const s = snap({ skills: [{ name: 'style', path: 'skills/style', description: '' }], hooks: [{ event: 'Stop', command: ['x'], env: {} }] });
		const a = audiences(s);
		expect(a.you.length).toBe(2);
		expect(a.agents.length).toBe(3);
		expect(agentReach(s)[0]).toEqual({ agent: 'Claude Code', gets: ['MCP', 'skills', 'hooks'] });
		expect(agentReach(s).find((r) => r.agent === 'Codex')).toEqual({ agent: 'Codex', gets: ['MCP'] });
		expect(agentReach(snap({ mcp: [] }))).toEqual([]);
	});

	test('avatars are stable per id and use initials', () => {
		expect(snapAvatar({ id: 'ai-memory', name: 'ai-memory' })).toEqual(snapAvatar({ id: 'ai-memory', name: 'ai-memory' }));
		expect(snapAvatar({ id: 'ai-memory', name: 'ai-memory' }).letters).toBe('AM');
		expect(snapAvatar({ id: 'go', name: 'Go' }).letters).toBe('GO');
		expect(snapAvatar({ id: 'pg', name: 'Postgres Tools' }).letters).toBe('PT');
	});
});

describe('files a snap runs', () => {
	test('${snap:dir}/… points at the snap folder, before settings; trust lists the covered files', () => {
		const s = snap({ dir: '/u/snaps/go', settings: [{ key: 'x', type: 'string', default: '${snap:dir}/evil', description: '' }], tasks: [{ id: 't', title: 'T', command: ['${snap:dir}/bin/tool', '${setting:x}', '--a=${snap:dir}/b'] }] });
		expect(inSnapDir(s, ['${snap:dir}/bin/tool', '${snap:dir}x', 'a'])).toEqual(['/u/snaps/go/bin/tool', '${snap:dir}x', 'a']);
		expect(taskArgv(s, s.tasks[0], () => undefined)).toEqual(['/u/snaps/go/bin/tool', '${snap:dir}/evil', '--a=${snap:dir}/b']);
		expect(trustSummary({ ...s, source: 'repo', trusted: false, files: ['./scripts/test.sh'] })).toContain('./scripts/test.sh');
	});
});

describe('themes of snaps', () => {
	test('active snaps only, typed from uiTheme and labelled with the snap', () => {
		const th = { id: 'Ocean Dark', label: 'Ocean Dark', uiTheme: 'vs', file: 'go/t.json', files: { 'go/t.json': '{}' } };
		expect(snapThemesOf([snap({ themes: [th] }), snap({ id: 'off', disabled: true, themes: [{ ...th, id: 'Other' }] })])).toEqual([{ id: 'Ocean Dark', label: 'Ocean Dark', file: 'go/t.json', type: 'light', snap: 'Go', files: { 'go/t.json': '{}' } }]);
		expect(audiences(snap({ themes: [th] })).you.some((l) => l.includes('Ocean Dark'))).toBe(true);
	});
});
