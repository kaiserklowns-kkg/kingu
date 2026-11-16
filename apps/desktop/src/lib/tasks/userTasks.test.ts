import { expect, test } from 'bun:test';
import { parseTasksJson } from './taskConfig.ts';
import { scopeUserTasks, taskArg, USER_TASKS_TEMPLATE } from './userTasks.ts';

test('Run Task args: a label, a task identifier, `{ task }`; nothing else', () => {
	expect(taskArg('build')).toBe('build');
	expect(taskArg('  ')).toBeUndefined();
	expect(taskArg({ task: 'lint' })).toBe('lint');
	expect(taskArg({ type: 'npm', script: 'test' })).toEqual({ type: 'npm', script: 'test' });
	expect(taskArg({})).toBeUndefined();
	expect(taskArg(['x'])).toBeUndefined();
	expect(taskArg(3)).toBeUndefined();
});

test('user tasks: the template parses, tasks get their own ids and the User source', () => {
	expect(parseTasksJson(USER_TASKS_TEMPLATE, 'osx').tasks).toEqual([]);
	const { tasks } = parseTasksJson('{"version":"2.0.0","tasks":[{"label":"hello","type":"shell","command":"echo hi"}]}', 'osx');
	const [u] = scopeUserTasks(tasks);
	expect(u.label).toBe('hello');
	expect(u.id).toBe(`user::${tasks[0].id}`);
	expect(u.source).toBe('User');
	expect(u.folder).toBeUndefined();
});
