import { describe, expect, test } from 'bun:test';
import { createGroupsModel, openEditor, pinEditor, splitEditor, stickEditor, type GroupsModel } from './editorGroups.ts';
import { fromOpenEditors, isRestorableKey, MAX_SAVED_VIEWS, parseLayout, serializeLayout, viewKey, withOpen } from './editorLayout.ts';

const keep = (key: string) => isRestorableKey(key, true);
/** Through JSON, the way it is stored. */
const roundTrip = (m: GroupsModel, views = {}) => parseLayout(JSON.parse(JSON.stringify(serializeLayout(m, keep, views))), keep);

describe('editor layout per workspace', () => {
	test('which editors come back', () => {
		expect(isRestorableKey('src/a.ts', false)).toBe(true);
		expect(isRestorableKey('/other/root/b.ts', false)).toBe(true);
		expect(isRestorableKey('external:/tmp/notes.txt', false)).toBe(true);
		expect(isRestorableKey('diff:src/a.ts', false)).toBe(true);
		// Untitled editors only while hot exit keeps their text.
		expect(isRestorableKey('untitled:Untitled-1', true)).toBe(true);
		expect(isRestorableKey('untitled:Untitled-1', false)).toBe(false);
		for (const k of ['settings://user', 'task://fix', 'commitdiff://x/abc/a.ts', 'diff:settings://x', ' ']) expect(isRestorableKey(k, true)).toBe(false);
	});

	test('groups, their grid and their editors survive a restart', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts', { preview: false });
		openEditor(m, 'b.ts', { preview: true });
		openEditor(m, 'settings://user', { preview: false });
		stickEditor(m, 1, 'a.ts');
		const right = splitEditor(m, 'right')!;
		openEditor(m, 'c.ts', { preview: false, group: right });
		const down = splitEditor(m, 'down')!;
		openEditor(m, 'untitled:Untitled-1', { preview: false, group: down });
		m.activeGroup = right;
		const back = roundTrip(m)!;
		expect(back).not.toBeNull();
		const { model } = back;
		expect(model.groups.map((g) => g.id)).toEqual(m.groups.map((g) => g.id));
		expect(model.root).toEqual(m.root);
		expect(model.activeGroup).toBe(right);
		const first = model.groups.find((g) => g.id === 1)!;
		// The Settings editor is not restored; pinned and preview state are.
		expect(first.tabs).toEqual([
			{ path: 'a.ts', preview: false, dirty: false, sticky: true },
			{ path: 'b.ts', preview: true, dirty: false }
		]);
		expect(first.active).toBe('b.ts');
		expect(first.mru[0]).toBe('b.ts');
		// A split starts with the active editor (VS Code), then the untitled one.
		expect(model.groups.find((g) => g.id === down)!.tabs.map((t) => t.path)).toEqual(['c.ts', 'untitled:Untitled-1']);
		expect(model.nextId).toBeGreaterThan(Math.max(...model.groups.map((g) => g.id)));
		expect(model.closed).toEqual([]);
	});

	test('view states: the open editors first, bounded, only of live groups', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts', { preview: false });
		pinEditor(m, 1, 'a.ts');
		const views: Record<string, unknown> = { [viewKey(1, 'a.ts')]: { cursorState: [] }, [viewKey(9, 'gone.ts')]: { x: 1 }, [viewKey(1, 'closed.ts')]: { y: 1 } };
		for (let i = 0; i < MAX_SAVED_VIEWS + 10; i++) views[viewKey(1, `old${i}.ts`)] = { i };
		const saved = serializeLayout(m, keep, views);
		const keys = Object.keys(saved.views!);
		expect(keys.length).toBe(MAX_SAVED_VIEWS);
		expect(keys[0]).toBe(viewKey(1, 'a.ts'));
		expect(keys).not.toContain(viewKey(9, 'gone.ts'));
		// The most recently closed ones are kept, the oldest go.
		expect(keys).toContain(viewKey(1, `old${MAX_SAVED_VIEWS + 9}.ts`));
		expect(keys).not.toContain(viewKey(1, 'old0.ts'));
		expect(parseLayout(saved, keep)!.views[viewKey(1, 'a.ts')]).toEqual({ cursorState: [] });
	});

	test('what does not make a layout reads as none', () => {
		const bad = [
			null,
			'x',
			{ groups: [] },
			{ groups: [{ id: 1, tabs: [] }], root: { type: 'group', id: 2 } },
			// A group missing from the grid, or in it twice.
			{ groups: [{ id: 1, tabs: [] }, { id: 2, tabs: [] }], root: { type: 'group', id: 1 } },
			{ groups: [{ id: 1, tabs: [] }], root: { type: 'split', id: 3, direction: 'row', children: [{ type: 'group', id: 1 }, { type: 'group', id: 1 }], sizes: [0.5, 0.5] } },
			{ groups: [{ id: 1, tabs: [] }, { id: 1, tabs: [] }], root: { type: 'group', id: 1 } }
		];
		for (const raw of bad) expect(parseLayout(raw, keep)).toBeNull();
		// Sizes that do not add up are evened; a second preview tab and an unknown active editor are fixed.
		const fixed = parseLayout(
			{
				groups: [
					{ id: 1, tabs: [{ path: 'a', preview: true }, { path: 'b', preview: true }, { path: 'a' }], active: 'zzz', mru: [] },
					{ id: 2, tabs: [], active: null, mru: [] }
				],
				root: { type: 'split', id: 3, direction: 'column', children: [{ type: 'group', id: 1 }, { type: 'group', id: 2 }], sizes: [3, -1] },
				activeGroup: 7
			},
			keep
		)!;
		expect(fixed.model.root).toEqual({ type: 'split', id: 3, direction: 'column', children: [{ type: 'group', id: 1 }, { type: 'group', id: 2 }], sizes: [0.5, 0.5] });
		expect(fixed.model.groups[0].tabs.map((t) => [t.path, t.preview])).toEqual([
			['a', true],
			['b', false]
		]);
		expect(fixed.model.groups[0].active).toBe('b');
		expect(fixed.model.activeGroup).toBe(1);
		expect(fixed.model.nextId).toBe(4);
	});

	test('an older build’s open files become one group', () => {
		const back = parseLayout(fromOpenEditors(['a.ts', 'b.ts'], 'a.ts'), keep)!;
		expect(back.model.groups[0].tabs.map((t) => t.path)).toEqual(['a.ts', 'b.ts']);
		expect(back.model.groups[0].active).toBe('a.ts');
	});

	test('editors opened before the restore (a launch file, a backup) stay open', () => {
		const restored = parseLayout(fromOpenEditors(['a.ts'], 'a.ts'), keep)!.model;
		const now = createGroupsModel();
		openEditor(now, 'launched.ts', { preview: true });
		openEditor(now, 'a.ts', { preview: false });
		openEditor(now, 'launched.ts', { preview: true });
		const merged = withOpen(restored, now);
		expect(merged.groups[0].tabs.map((t) => [t.path, t.preview])).toEqual([
			['a.ts', false],
			['launched.ts', false]
		]);
		expect(merged.groups[0].active).toBe('launched.ts');
	});
});
