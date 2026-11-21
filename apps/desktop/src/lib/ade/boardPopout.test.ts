import { expect, test } from 'bun:test';
import { cssVariables, popoutLanes, type PopoutEntry } from './boardPopout.ts';
import { effectiveStatus, newTask, type TaskMeta } from './model.ts';

const COLS = [
	{ id: 'attention' as const, label: 'Needs you', hint: '' },
	{ id: 'active' as const, label: 'Working', hint: '' },
	{ id: 'done' as const, label: 'Done', hint: '' }
];
const IDLE = { label: 'Idle', hint: '' };

const entry = (root: string, slug: string, extra: Partial<TaskMeta> = {}): PopoutEntry => {
	const meta = { ...newTask({ slug, title: `Task ${slug}`, prompt: 'first line\nmore', base: 'main' }, 1000), ...extra };
	return { root, view: { meta, status: effectiveStatus(meta, undefined) } };
};

test('the pop-out lays out every project in the agent columns, done split into Done and Idle', () => {
	const entries = [entry('/a', 'one', { status: 'done' }), entry('/b', 'one', { status: 'done' }), entry('/b', 'two', { status: 'done' })];
	const unread = new Set(['/b\u0000one']);
	const lanes = popoutLanes(entries, unread, true, COLS, IDLE);
	expect(lanes.map((l) => l.id)).toEqual(['attention', 'active', 'done', 'idle']);
	expect(lanes[2].cards.map((c) => c.key)).toEqual(['/b\u0000one']);
	expect(lanes[3].cards.map((c) => c.key).sort()).toEqual(['/a\u0000one', '/b\u0000two']);
	const card = lanes[2].cards[0];
	expect(card).toMatchObject({ root: '/b', slug: 'one', title: 'Task one', summary: 'first line', project: 'b', depth: 0 });
	// Without kingu.board.showIdle there is no Idle column.
	expect(popoutLanes(entries, unread, false, COLS, IDLE).map((l) => l.id)).toEqual(['attention', 'active', 'done']);
});

test('a stacked task nests under its parent only within its own project', () => {
	const entries = [entry('/a', 'base', { status: 'done' }), entry('/a', 'next', { status: 'done', parent: 'base' }), entry('/b', 'next', { status: 'done', parent: 'base' })];
	const done = popoutLanes(entries, new Set(entries.map((e) => `${e.root}\u0000${e.view.meta.slug}`)), false, COLS, IDLE)[2].cards;
	expect(Object.fromEntries(done.map((c) => [c.key, c.depth]))).toEqual({ '/a\u0000base': 0, '/a\u0000next': 1, '/b\u0000next': 0 });
});

test('only custom properties are copied from the theme', () => {
	const style = Object.assign(['--vscode-foreground', 'color', '--kg-x'], { getPropertyValue: (n: string) => `v${n}` });
	expect(cssVariables(style)).toEqual({ '--vscode-foreground': 'v--vscode-foreground', '--kg-x': 'v--kg-x' });
});
