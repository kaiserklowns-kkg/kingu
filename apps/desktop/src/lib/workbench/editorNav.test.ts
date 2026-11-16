import { describe, expect, test } from 'bun:test';
import { addGroup, createGroupsModel, getGroup, groupAtLocation, groupInDirection, groupOrder, moveActiveEditorToGroup, moveEditorInGroup, moveGroup, openEditor, stickEditor } from './editorGroups';
import { flattenResults, stepMatch, type FileMatches } from './searchResults';

const paths = (m: ReturnType<typeof createGroupsModel>, id: number) => getGroup(m, id)!.tabs.map((t) => t.path);

function three() {
	const m = createGroupsModel();
	for (const p of ['a', 'b', 'c']) openEditor(m, p, { preview: false });
	return m;
}

describe('Move Editor Left / Right in Group (⌘K ⇧⌘← / →)', () => {
	test('one place over, stopping at the ends', () => {
		const m = three();
		expect(moveEditorInGroup(m, 1, 'c', 'left')).toBe(true);
		expect(paths(m, 1)).toEqual(['a', 'c', 'b']);
		expect(moveEditorInGroup(m, 1, 'c', 'left')).toBe(true);
		expect(moveEditorInGroup(m, 1, 'c', 'left')).toBe(false);
		expect(paths(m, 1)).toEqual(['c', 'a', 'b']);
		expect(moveEditorInGroup(m, 1, 'c', 'last')).toBe(true);
		expect(paths(m, 1)).toEqual(['a', 'b', 'c']);
		expect(getGroup(m, 1)!.active).toBe('c');
	});

	test('a pinned tab stays among the pinned ones, an unpinned one after them', () => {
		const m = three();
		stickEditor(m, 1, 'a');
		expect(moveEditorInGroup(m, 1, 'b', 'first')).toBe(false);
		expect(moveEditorInGroup(m, 1, 'a', 'right')).toBe(false);
		expect(paths(m, 1)).toEqual(['a', 'b', 'c']);
	});
});

describe('Move Editor into Previous / Next / First / Last Group', () => {
	test('previous adds a group on the left when there is none', () => {
		const m = three();
		const to = moveActiveEditorToGroup(m, 'previous');
		expect(to).not.toBeNull();
		expect(groupOrder(m)).toEqual([to!, 1]);
		expect(paths(m, to!)).toEqual(['c']);
		expect(paths(m, 1)).toEqual(['a', 'b']);
		expect(m.activeGroup).toBe(to!);
	});

	test('down as the side direction adds the previous group above', () => {
		const m = three();
		const to = moveActiveEditorToGroup(m, 'previous', 'down')!;
		expect(m.root.type === 'split' && m.root.direction).toBe('column');
		expect(groupOrder(m)[0]).toBe(to);
	});

	test('first and last reuse existing groups and do nothing from there', () => {
		const m = three();
		const g2 = addGroup(m, 1, 'right')!;
		expect(moveActiveEditorToGroup(m, 'last')).toBe(g2);
		expect(paths(m, g2)).toEqual(['c']);
		expect(moveActiveEditorToGroup(m, 'last')).toBeNull();
		expect(moveActiveEditorToGroup(m, 'first')).toBe(1);
		expect(paths(m, 1)).toEqual(['a', 'b', 'c']);
	});

	test('the only editor of the only group stays put', () => {
		const m = createGroupsModel();
		openEditor(m, 'a', { preview: false });
		expect(moveActiveEditorToGroup(m, 'previous')).toBeNull();
		expect(moveActiveEditorToGroup(m, 'next')).toBeNull();
		expect(m.groups.length).toBe(1);
	});
});

describe('Focus Left / Right / Above / Below and Next / Previous Group', () => {
	test('the neighbour, wrapping round at the edge', () => {
		const m = createGroupsModel();
		const g2 = addGroup(m, 1, 'right')!;
		const g3 = addGroup(m, g2, 'right')!;
		expect(groupInDirection(m, 1, 'right')).toBe(g2);
		expect(groupInDirection(m, g3, 'right')).toBe(1);
		expect(groupInDirection(m, 1, 'left')).toBe(g3);
		expect(groupInDirection(m, 1, 'down')).toBeNull();
	});

	test('above and below in a column', () => {
		const m = createGroupsModel();
		const below = addGroup(m, 1, 'down')!;
		expect(groupInDirection(m, 1, 'down')).toBe(below);
		expect(groupInDirection(m, below, 'up')).toBe(1);
		expect(groupInDirection(m, below, 'down')).toBe(1);
	});

	test('grid order with wrap; last is the last one', () => {
		const m = createGroupsModel();
		expect(groupAtLocation(m, 1, 'next')).toBeNull();
		const g2 = addGroup(m, 1, 'right')!;
		expect(groupAtLocation(m, 1, 'next')).toBe(g2);
		expect(groupAtLocation(m, g2, 'next')).toBe(1);
		expect(groupAtLocation(m, 1, 'previous')).toBe(g2);
		expect(groupAtLocation(m, 1, 'last')).toBe(g2);
	});
});

describe('F4 / ⇧F4 through the search results', () => {
	const match = (line: number) => ({ line, column: 1, end_column: 2, preview: 'x', preview_start: 0, preview_end: 1, text: 'x' });
	const files: FileMatches[] = [
		{ path: 'a.ts', matches: [match(1), match(5)] },
		{ path: 'b.ts', matches: [match(2)] }
	];
	const rows = flattenResults(files, new Set());

	test('starts at the first (or last) match and wraps round', () => {
		expect(stepMatch(rows, null, 1)?.key).toBe('a.ts\u00000');
		expect(stepMatch(rows, null, -1)?.key).toBe('b.ts\u00000');
		expect(stepMatch(rows, 'a.ts\u00001', 1)?.key).toBe('b.ts\u00000');
		expect(stepMatch(rows, 'b.ts\u00000', 1)?.key).toBe('a.ts\u00000');
		expect(stepMatch(rows, 'a.ts\u00000', -1)?.key).toBe('b.ts\u00000');
	});

	test('nothing without matches', () => {
		expect(stepMatch([], null, 1)).toBeNull();
	});
});

describe('Move Editor Group Left / Right / Up / Down (⌘K ← → ↑ ↓)', () => {
	test('the group swaps places with its neighbour, editors and all', () => {
		const m = three();
		const g2 = addGroup(m, 1, 'right')!;
		const g3 = addGroup(m, g2, 'right')!;
		expect(moveGroup(m, 1, 'right')).toBe(1);
		expect(groupOrder(m)).toEqual([g2, 1, g3]);
		expect(paths(m, 1)).toEqual(['a', 'b', 'c']);
		expect(m.activeGroup).toBe(1);
		expect(moveGroup(m, 1, 'right')).toBe(1);
		expect(groupOrder(m)).toEqual([g2, g3, 1]);
		// No wrap at the edge.
		expect(moveGroup(m, 1, 'right')).toBeNull();
		expect(groupOrder(m)).toEqual([g2, g3, 1]);
	});

	test('with no group below, down puts it under a neighbour across (VS Code\'s alternative targets)', () => {
		const m = three();
		const g2 = addGroup(m, 1, 'right')!;
		expect(moveGroup(m, g2, 'down')).toBe(g2);
		expect(m.root.type === 'split' && m.root.direction).toBe('column');
		expect(groupOrder(m)).toEqual([1, g2]);
		expect(moveGroup(m, g2, 'up')).toBe(g2);
		expect(groupOrder(m)).toEqual([g2, 1]);
		expect(moveGroup(m, g2, 'up')).toBeNull();
	});

	test('a single group stays put', () => {
		const m = three();
		expect(moveGroup(m, 1, 'left')).toBeNull();
	});
});
