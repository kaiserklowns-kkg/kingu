import { describe, expect, test } from 'bun:test';
import { aroundOpen, noticeKey, noticeRoot, pendingDue, projectBadge, projectName, projectSidebarTask, projectView, rootPanes, sidebarProjects, strayRuns } from './projects';
import { newTask, type TaskMeta, type TaskRuntime, type TaskView } from './model';
import type { AgentRow } from './agentPresence';
import { cliKey, rootTag } from '#lib/terminal/sessions.ts';

const meta = (slug: string, extra: Partial<TaskMeta> = {}): TaskMeta => ({ ...newTask({ slug, title: `Task ${slug}`, prompt: 'p', base: 'main' }, 1000), ...extra });
const rt = (extra: Partial<TaskRuntime> = {}): TaskRuntime => ({ slug: 'a', status: 'running', runStatus: 'running', live: true, working: true, pendingPermissions: 0, sessionId: null, ...extra });
const row = (state: AgentRow['state'], at = 5): AgentRow => ({ id: 'ade:x:a:t1', agent: 'gemini', state, at });

describe('sidebarProjects', () => {
	const list = [
		{ path: '/r/a', added_at: 1 },
		{ path: '/r/b', added_at: 2 },
		{ path: '/r/c', added_at: 3 }
	];

	test('keeps the added order whichever folder is open', () => {
		expect(sidebarProjects(list, '/r/b').map((p) => [p.name, p.open])).toEqual([
			['a', false],
			['b', true],
			['c', false]
		]);
		expect(sidebarProjects(list, '/r/c').map((p) => p.path)).toEqual(['/r/a', '/r/b', '/r/c']);
	});

	test('an open folder that was never added comes first; no folder open shows only the added ones', () => {
		expect(sidebarProjects(list, '/x/new').map((p) => [p.path, p.open])[0]).toEqual(['/x/new', true]);
		expect(sidebarProjects(list, '/x/new')).toHaveLength(4);
		expect(sidebarProjects(list, null).every((p) => !p.open)).toBe(true);
	});

	test('recent orders by latest activity, ties keep the added order; manual keeps the list order', () => {
		const activity: Record<string, number> = { '/r/a': 5, '/r/b': 9, '/r/c': 5 };
		const lastActive = (path: string) => activity[path] ?? 0;
		expect(sidebarProjects(list, '/r/b', { orderBy: 'recent', lastActive }).map((p) => p.name)).toEqual(['b', 'a', 'c']);
		expect(sidebarProjects(list, '/r/b', { orderBy: 'manual', lastActive }).map((p) => p.name)).toEqual(['a', 'b', 'c']);
		// A folder that was never added takes its activity rank too.
		expect(sidebarProjects(list, '/x/new', { orderBy: 'recent', lastActive: (p) => (p === '/x/new' ? 10 : 1) }).map((p) => p.path)).toEqual([
			'/x/new',
			'/r/a',
			'/r/b',
			'/r/c'
		]);
	});

	test('aroundOpen splits the others before and after the open folder', () => {
		const { before, after } = aroundOpen(sidebarProjects(list, '/r/b'));
		expect([before.map((p) => p.name), after.map((p) => p.name)]).toEqual([['a'], ['c']]);
		expect(aroundOpen(sidebarProjects(list, null)).after).toHaveLength(3);
	});

	test('projectName is the folder name', () => {
		expect(projectName('/Users/me/code/kingu/')).toBe('kingu');
		expect(projectName('/')).toBe('/');
	});
});

describe('rootPanes', () => {
	test("finds the root's task panes by PTY key, not the folder's own, not other roots', not CLIs", () => {
		const tag = rootTag('/r/a');
		const other = rootTag('/r/b');
		const keys = [`ade:${tag}:fix-login:t1`, `ade:${tag}:fix-login:t4`, `ade:${tag}::t2`, `ade:${other}:fix-login:t1`, cliKey(tag, 'fix-login', 5), `panel:${tag}:1`, `ade:${tag}:x:notatab`];
		expect([...rootPanes(keys, tag)]).toEqual([
			[`ade:${tag}:fix-login:t1`, 'fix-login'],
			[`ade:${tag}:fix-login:t4`, 'fix-login']
		]);
	});
});

describe('projectView', () => {
	test("another project's task: its agent-host run first, else its CLI, raised by its panes", () => {
		const m = meta('a', { status: 'review' });
		expect(projectView(m, undefined, undefined)).toMatchObject({ status: 'review', runtime: undefined });
		const cli = rt({ status: 'review', runStatus: 'idle', working: false });
		expect(projectView(m, undefined, { cli, rows: [] }).runtime).toBe(cli);
		// A hand-typed agent in another pane asks for permission: the task waits on you.
		expect(projectView(m, undefined, { cli, rows: [row('permission')] }).status).toBe('waiting');
		const run = rt({ status: 'running' });
		expect(projectView(m, run, { cli, rows: [] })).toMatchObject({ status: 'running', runtime: run });
		// Panes alone make the runtime.
		expect(projectView(m, undefined, { rows: [row('working')] }).status).toBe('running');
	});

	test('a task that ran when Kingu quit and shows no agent now is up for review', () => {
		expect(projectView(meta('a', { status: 'running' }), undefined, undefined).status).toBe('review');
	});

	test('the side bar entry has no PR state and is live only with an agent', () => {
		const v = projectView(meta('a', { updated_at: 10 }), rt({ updatedAt: 50 }), undefined);
		expect(projectSidebarTask(v, true)).toMatchObject({ slug: 'a', status: 'running', updatedAt: 50, live: true, detached: true, prState: null });
		expect(projectSidebarTask(projectView(meta('a'), undefined, undefined), false).live).toBe(false);
	});
});

describe('counting and notices', () => {
	const v = (status: TaskView['status'], pending = 0): TaskView => ({ meta: meta('a'), status, runtime: rt({ status, pendingPermissions: pending }) });

	test('projectBadge counts reviews and CLI prompts, not agent-host prompts (the store counts those)', () => {
		expect(projectBadge([{ view: v('review'), hostRun: false }, { view: v('failed'), hostRun: true }, { view: v('running'), hostRun: false }])).toBe(2);
		expect(projectBadge([{ view: v('waiting', 1), hostRun: false }, { view: v('waiting', 2), hostRun: true }])).toBe(1);
		// A question has no permission count but still needs you.
		expect(projectBadge([{ view: v('waiting', 0), hostRun: false }])).toBe(1);
	});

	test('strayRuns leaves out the open folder and the added projects', () => {
		const runs = [{ root: '/r/a' }, { root: '/r/b' }, { root: '/x' }];
		expect(strayRuns(runs, '/r/a', new Set(['/r/a', '/r/b']))).toEqual([{ root: '/x' }]);
		expect(strayRuns(runs, null, new Set())).toHaveLength(3);
	});

	test('notice keys tell two projects with the same task apart and give back the project', () => {
		expect(noticeKey('/r/a', 'fix')).not.toBe(noticeKey('/r/b', 'fix'));
		expect(noticeRoot(noticeKey('/r/a', 'fix'))).toBe('/r/a');
		expect(noticeRoot('no-separator')).toBe('');
	});

	test('a pending task opens once its folder has loaded', () => {
		expect(pendingDue(null, '/r/a')).toBe(false);
		expect(pendingDue({ root: '/r/a' }, null)).toBe(false);
		expect(pendingDue({ root: '/r/a' }, '/r/b')).toBe(false);
		expect(pendingDue({ root: '/r/a' }, '/r/a')).toBe(true);
	});
});
