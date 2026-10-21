import { describe, expect, test } from 'bun:test';
import {
	applyKeep,
	applyRestore,
	applyUndo,
	chatEditKey,
	cwdRelative,
	dirtyOf,
	parseChatEditKey,
	requestsOfItems,
	restoreTargets,
	summary,
	undoTargets,
	workspacePath,
	type EditsView,
	type WorkingFile
} from './chatEdits.ts';
import type { AgentEvent } from './events';
import { fileOf, isDiffKey, tabLabel } from '#lib/workbench/scm.ts';

const file = (path: string, over: Partial<WorkingFile> = {}): WorkingFile => ({
	path,
	request: 0,
	source: 'tool',
	restorable: true,
	reason: null,
	created: false,
	deleted: false,
	from_head: false,
	added: 1,
	removed: 1,
	...over
});

function view(): EditsView {
	return {
		prefix: '.kingu/worktrees/fix',
		running: false,
		files: [
			file('a.ts', { added: 3, removed: 1 }),
			file('new.ts', { request: 1, created: true, added: 10, removed: 0 }),
			file('build.log', { request: 1, source: 'shell', restorable: false, reason: 'untracked', added: null, removed: null }),
			file('src/b.ts', { request: 2 })
		],
		requests: [
			{ index: 0, at: 1, reverted: false, head_moved: false, paths: ['a.ts'] },
			{ index: 1, at: 2, reverted: false, head_moved: false, paths: ['new.ts', 'build.log', 'kept.ts'] },
			{ index: 2, at: 3, reverted: false, head_moved: false, paths: ['src/b.ts', 'a.ts'] }
		]
	};
}

describe('working set reducer', () => {
	test('summary sums lines and counts what Undo can restore', () => {
		expect(summary(view())).toEqual({ files: 4, added: 14, removed: 2, restorable: 3 });
		expect(summary({ files: [] })).toEqual({ files: 0, added: 0, removed: 0, restorable: 0 });
	});

	test('keep drops the named files, or all of them', () => {
		expect(applyKeep(view(), ['a.ts']).files.map((f) => f.path)).toEqual(['new.ts', 'build.log', 'src/b.ts']);
		expect(applyKeep(view(), null).files).toEqual([]);
		const v = view();
		applyKeep(v, null);
		expect(v.files.length).toBe(4);
	});

	test('undo drops what was restored or deleted and keeps what was skipped', () => {
		const next = applyUndo(view(), { restored: ['a.ts'], deleted: ['new.ts'], skipped: [['build.log', 'untracked']] });
		expect(next.files.map((f) => f.path)).toEqual(['build.log', 'src/b.ts']);
	});

	test('restore checkpoint reverts that request and later ones', () => {
		const next = applyRestore(view(), 1);
		expect(next.files.map((f) => f.path)).toEqual(['a.ts']);
		expect(next.requests.map((r) => r.reverted)).toEqual([false, true, true]);
	});

	test('targets are editor paths under the chat cwd', () => {
		expect(undoTargets(view(), null)).toEqual(['.kingu/worktrees/fix/a.ts', '.kingu/worktrees/fix/new.ts', '.kingu/worktrees/fix/src/b.ts']);
		expect(undoTargets(view(), ['build.log'])).toEqual([]);
		expect(restoreTargets(view(), 1).sort()).toEqual(['a.ts', 'build.log', 'kept.ts', 'new.ts', 'src/b.ts'].map((p) => `.kingu/worktrees/fix/${p}`).sort());
		const reverted = { ...view(), requests: view().requests.map((r) => ({ ...r, reverted: r.index === 2 })) };
		expect(restoreTargets(reverted, 2)).toEqual([]);
		const dirty = new Set(['.kingu/worktrees/fix/a.ts', 'elsewhere.ts']);
		expect(dirtyOf(undoTargets(view(), null), (p) => dirty.has(p))).toEqual(['.kingu/worktrees/fix/a.ts']);
	});

	test('paths between the workspace and the chat cwd', () => {
		expect(workspacePath('', 'a.ts')).toBe('a.ts');
		expect(workspacePath('.kingu/worktrees/x/', 'a.ts')).toBe('.kingu/worktrees/x/a.ts');
		expect(cwdRelative('.kingu/worktrees/x', '.kingu/worktrees/x/src/a.ts')).toBe('src/a.ts');
		expect(cwdRelative('.kingu/worktrees/x', 'src/a.ts')).toBeNull();
		expect(cwdRelative('', 'src/a.ts')).toBe('src/a.ts');
	});

	test('timeline items map to the request of the checkpoint before them', () => {
		const items: AgentEvent[] = [
			{ kind: 'system', subtype: 'init', session_id: 's', model: null },
			{ kind: 'message', role: 'user', text: 'one' },
			{ kind: 'checkpoint', request: 0 },
			{ kind: 'message', role: 'assistant', text: 'ok' },
			{ kind: 'message', role: 'user', text: 'two' },
			{ kind: 'checkpoint', request: 1 },
			{ kind: 'tool_use', id: 't', name: 'Edit', input: {} }
		];
		expect(requestsOfItems(items)).toEqual([null, null, 0, 0, 0, 1, 1]);
	});

	test('diff tab keys', () => {
		const key = chatEditKey('c-1', '.kingu/worktrees/x/src/a.ts');
		expect(parseChatEditKey(key)).toEqual({ chatId: 'c-1', rel: '.kingu/worktrees/x/src/a.ts' });
		expect(parseChatEditKey('chatedit://c-1/')).toBeNull();
		expect(parseChatEditKey('diff:a')).toBeNull();
		expect(isDiffKey(key)).toBe(true);
		expect(fileOf(key)).toBe('.kingu/worktrees/x/src/a.ts');
		expect(tabLabel(key)).toBe('a.ts (agent changes)');
	});
});
