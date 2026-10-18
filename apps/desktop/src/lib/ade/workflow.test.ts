import { describe, expect, test } from 'bun:test';
import { autoWorkflow, DEFAULT_WORKFLOW, defaultWorkflowId, workflowColumns, workflowId, workflowOf, workflowStatuses } from './workflow';

const ids = (s: { id: string }[]) => s.map((x) => x.id);

describe('workflow statuses (Orca workspace statuses)', () => {
	test('the defaults: Todo, In progress, In review, Done; a task with none sits in In progress', () => {
		const s = workflowStatuses(undefined);
		expect(ids(s)).toEqual([...DEFAULT_WORKFLOW]);
		expect(workflowStatuses([])).toEqual(s);
		expect(workflowOf({}, s)).toBe('in-progress');
		expect(workflowOf({ workflow_status: 'in-review' }, s)).toBe('in-review');
		expect(workflowOf({ workflow_status: 'gone' }, s)).toBe('in-progress');
	});

	test('your own columns: titles become ids, duplicates and junk go, at most 12', () => {
		const s = workflowStatuses(['todo', 'Waiting on QA', 'waiting-on-qa', 42, '  ', '!!!', 'completed']);
		expect(ids(s)).toEqual(['todo', 'waiting-on-qa', 'completed']);
		expect(s[1].label).toBe('Waiting on QA');
		expect(workflowStatuses(Array.from({ length: 20 }, (_, i) => `c${i}`)).length).toBe(12);
		// No in-progress column: the first one is the default.
		expect(defaultWorkflowId(s)).toBe('todo');
		expect(workflowId('  Ship It!! ')).toBe('ship-it');
	});

	test('columns hold every task exactly once, in column order', () => {
		const s = workflowStatuses(undefined);
		const v = (slug: string, workflow_status?: string) => ({ meta: { slug, workflow_status } });
		const cols = workflowColumns([v('a'), v('b', 'completed'), v('c', 'todo'), v('d', 'nope')], s);
		expect(cols.map((c) => [c.status.id, c.tasks.map((t) => t.meta.slug)])).toEqual([
			['todo', ['c']],
			['in-progress', ['a', 'd']],
			['in-review', []],
			['completed', ['b']]
		]);
	});

	test('a pull request moves the card forward only', () => {
		const s = workflowStatuses(undefined);
		expect(autoWorkflow('in-progress', { state: 'OPEN', merged: false }, s)).toBe('in-review');
		expect(autoWorkflow('todo', { state: 'MERGED', merged: false }, s)).toBe('completed');
		expect(autoWorkflow('in-review', { state: null, merged: true }, s)).toBe('completed');
		expect(autoWorkflow('completed', { state: 'OPEN', merged: false }, s)).toBeNull();
		expect(autoWorkflow('in-review', { state: 'OPEN', merged: false }, s)).toBeNull();
		expect(autoWorkflow('in-progress', { state: 'CLOSED', merged: false }, s)).toBeNull();
		expect(autoWorkflow('in-progress', { state: null, merged: false }, s)).toBeNull();
		// Columns without In review: an open PR moves nothing.
		expect(autoWorkflow('todo', { state: 'OPEN', merged: false }, workflowStatuses(['todo', 'completed']))).toBeNull();
	});
});
