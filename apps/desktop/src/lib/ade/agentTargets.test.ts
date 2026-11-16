import { describe, expect, test } from 'bun:test';
import { targetChoices } from './agentTargets';

describe('send-to choices (Orca review-note delivery)', () => {
	test("a task with only its own agent sends there without asking", () => {
		expect(targetChoices({ task: { agent: 'claude', running: true }, panes: [] }).map((c) => c.id)).toEqual(['task']);
	});
	test('other pane agents add a menu with draft, new task and copy', () => {
		const ids = targetChoices({ task: { agent: 'claude', running: true }, panes: [{ id: 'ade:x:t2', agent: 'codex', state: 'idle' }] }).map((c) => c.id);
		expect(ids).toEqual(['task', 'taskDraft', 'pane:ade:x:t2', 'newTask', 'copy']);
		expect(targetChoices({ task: { agent: 'claude', running: false }, panes: [{ id: 'p', agent: null, state: 'idle' }] }).map((c) => c.id)).toEqual(['task', 'pane:p', 'newTask', 'copy']);
	});
	test('the folder (no task) can start a new task or copy', () => {
		expect(targetChoices({ task: null, panes: [] }).map((c) => c.id)).toEqual(['newTask', 'copy']);
	});
});
