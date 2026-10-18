import { describe, expect, test } from 'bun:test';
import {
	activateGroup,
	activeGroupOf,
	addGroup,
	closeAllEditors,
	closeOthers,
	closeSaved,
	closeToRight,
	mruOf,
	neighbourEditor,
	reopenClosed,
	setActiveEditor,
	stickEditor,
	unstickEditor,
	closeAllGroups,
	closeAllInGroup,
	closeEditor,
	createGroupsModel,
	focusGroupAt,
	getGroup,
	groupOrder,
	moveActiveEditorToNextGroup,
	moveEditor,
	openEditor,
	openPaths,
	remapEditors,
	removeGroup,
	resizeSplit,
	setDirty,
	splitEditor,
	type GroupSplit
} from './editorGroups';

const paths = (m: ReturnType<typeof createGroupsModel>, id: number) => getGroup(m, id)!.tabs.map((t) => (t.preview ? `~${t.path}` : t.path));

describe('open and preview', () => {
	test('a preview tab is replaced by the next preview in the same group', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts');
		openEditor(m, 'b.ts');
		expect(paths(m, 1)).toEqual(['~b.ts']);
		openEditor(m, 'b.ts', { preview: false });
		openEditor(m, 'c.ts');
		expect(paths(m, 1)).toEqual(['b.ts', '~c.ts']);
		expect(activeGroupOf(m).active).toBe('c.ts');
	});

	test('each group keeps its own preview tab', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts');
		const g2 = addGroup(m, 1, 'right')!;
		openEditor(m, 'b.ts', { group: g2 });
		expect(paths(m, 1)).toEqual(['~a.ts']);
		expect(paths(m, g2)).toEqual(['~b.ts']);
		expect(m.activeGroup).toBe(g2);
		openEditor(m, 'c.ts');
		expect(paths(m, g2)).toEqual(['~c.ts']);
		expect(paths(m, 1)).toEqual(['~a.ts']);
	});

	test('new tabs open after the active tab', () => {
		const m = createGroupsModel();
		for (const p of ['a', 'b', 'c']) openEditor(m, p, { preview: false });
		activeGroupOf(m).active = 'a';
		openEditor(m, 'd', { preview: false });
		expect(paths(m, 1)).toEqual(['a', 'd', 'b', 'c']);
	});
});

describe('dirty state is per file', () => {
	test('marks the file dirty in every group and pins it', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts');
		splitEditor(m, 'right');
		setDirty(m, 'a.ts', true);
		expect(m.groups.every((g) => g.tabs[0].dirty && !g.tabs[0].preview)).toBe(true);
	});

	test('a dirty tab closes without asking while another group still shows the file', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts', { preview: false });
		openEditor(m, 'b.ts', { preview: false });
		const g2 = splitEditor(m, 'right')!;
		openEditor(m, 'a.ts', { group: g2 });
		setDirty(m, 'a.ts', true);
		expect(closeEditor(m, 1, 'a.ts')).toBe(true);
		expect(closeEditor(m, g2, 'a.ts')).toBe(false);
		expect(closeEditor(m, g2, 'a.ts', { force: true })).toBe(true);
	});
});

describe('split and close', () => {
	test('splitEditor opens the active file pinned in a new group to the right', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts');
		const g2 = splitEditor(m, 'right')!;
		expect(groupOrder(m)).toEqual([1, g2]);
		expect(m.activeGroup).toBe(g2);
		expect(paths(m, g2)).toEqual(['a.ts']);
		expect((m.root as GroupSplit).direction).toBe('row');
	});

	test('splitting right twice keeps one row; splitting down nests a column', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts');
		const g2 = splitEditor(m, 'right')!;
		const g3 = splitEditor(m, 'right')!;
		const root = m.root as GroupSplit;
		expect(root.children.map((c) => c.type)).toEqual(['group', 'group', 'group']);
		expect(root.sizes).toEqual([0.5, 0.25, 0.25]);
		expect(groupOrder(m)).toEqual([1, g2, g3]);
		const g4 = splitEditor(m, 'down')!;
		expect(groupOrder(m)).toEqual([1, g2, g3, g4]);
		const nested = (m.root as GroupSplit).children[2] as GroupSplit;
		expect(nested.direction).toBe('column');
	});

	test('closing the last tab of a group removes the group and collapses the split', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts');
		const g2 = splitEditor(m, 'right')!;
		closeEditor(m, g2, 'a.ts');
		expect(m.groups.map((g) => g.id)).toEqual([1]);
		expect(m.root).toEqual({ type: 'group', id: 1 });
		expect(m.activeGroup).toBe(1);
		// The only group stays, empty.
		closeEditor(m, 1, 'a.ts');
		expect(m.groups).toHaveLength(1);
		expect(activeGroupOf(m).active).toBeNull();
	});

	test('removing a middle group gives its space to the previous sibling', () => {
		const m = createGroupsModel();
		const g2 = addGroup(m, 1, 'right')!;
		const g3 = addGroup(m, g2, 'right')!;
		removeGroup(m, g2);
		expect(groupOrder(m)).toEqual([1, g3]);
		expect((m.root as GroupSplit).sizes).toEqual([0.75, 0.25]);
	});

	test('collapsing a nested split merges same-direction children into the parent', () => {
		const m = createGroupsModel();
		const g2 = addGroup(m, 1, 'right')!; // row [1, 2]
		const g3 = addGroup(m, g2, 'down')!; // row [1, column [2, 3]]
		const g4 = addGroup(m, g3, 'right')!; // row [1, column [2, row [3, 4]]]
		removeGroup(m, g2); // column has one child (row [3, 4]) → merged into the root row
		const root = m.root as GroupSplit;
		expect(root.direction).toBe('row');
		expect(root.children).toEqual([
			{ type: 'group', id: 1 },
			{ type: 'group', id: g3 },
			{ type: 'group', id: g4 }
		]);
		expect(root.sizes.reduce((a, b) => a + b)).toBeCloseTo(1);
	});

	test('closeAllInGroup keeps dirty tabs and removes an emptied group', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts', { preview: false });
		const g2 = splitEditor(m, 'right')!;
		openEditor(m, 'b.ts', { preview: false });
		setDirty(m, 'b.ts', true);
		expect(closeAllInGroup(m, g2)).toEqual(['b.ts']);
		expect(paths(m, g2)).toEqual(['b.ts']);
		closeEditor(m, g2, 'b.ts', { force: true });
		expect(getGroup(m, g2)).toBeUndefined();
		const g3 = splitEditor(m, 'right')!;
		closeAllInGroup(m, g3);
		expect(m.groups.map((g) => g.id)).toEqual([1]);
	});
});

describe('focus and active tracking', () => {
	test('focusGroupAt focuses by grid order and creates the next group', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts');
		expect(focusGroupAt(m, 0)).toBe(1);
		const g2 = focusGroupAt(m, 1)!;
		expect(m.groups).toHaveLength(2);
		expect(m.activeGroup).toBe(g2);
		expect(getGroup(m, g2)!.tabs).toEqual([]);
		expect(focusGroupAt(m, 3)).toBeNull();
		focusGroupAt(m, 0);
		expect(activeGroupOf(m).active).toBe('a.ts');
	});

	test('removing the active group activates its neighbour', () => {
		const m = createGroupsModel();
		const g2 = addGroup(m, 1, 'right')!;
		const g3 = addGroup(m, g2, 'right')!;
		m.activeGroup = g3;
		removeGroup(m, g3);
		expect(m.activeGroup).toBe(g2);
	});
});

describe('move', () => {
	test('moveActiveEditorToNextGroup creates a group to the right, then reuses it', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts', { preview: false });
		openEditor(m, 'b.ts', { preview: false });
		expect(moveActiveEditorToNextGroup(m)).toBe(true);
		const [, g2] = groupOrder(m);
		expect(paths(m, 1)).toEqual(['a.ts']);
		expect(paths(m, g2)).toEqual(['b.ts']);
		expect(m.activeGroup).toBe(g2);
		// From the last group with one tab there is nowhere further to go.
		expect(moveActiveEditorToNextGroup(m)).toBe(false);
	});

	test('moving the last tab out of a group removes the group', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts', { preview: false });
		const g2 = addGroup(m, 1, 'right')!;
		openEditor(m, 'b.ts', { preview: false, group: g2 });
		moveEditor(m, g2, 'b.ts', 1, 0);
		expect(m.groups.map((g) => g.id)).toEqual([1]);
		expect(paths(m, 1)).toEqual(['b.ts', 'a.ts']);
		expect(m.activeGroup).toBe(1);
		expect(activeGroupOf(m).active).toBe('b.ts');
	});

	test('moving onto a group that already shows the file just activates it there', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts', { preview: false });
		openEditor(m, 'b.ts', { preview: false });
		const g2 = splitEditor(m, 'right')!; // shows b.ts
		moveEditor(m, 1, 'b.ts', g2);
		expect(paths(m, 1)).toEqual(['a.ts']);
		expect(paths(m, g2)).toEqual(['b.ts']);
	});

	test('moving within a group reorders', () => {
		const m = createGroupsModel();
		for (const p of ['a', 'b', 'c']) openEditor(m, p, { preview: false });
		moveEditor(m, 1, 'c', 1, 0);
		expect(paths(m, 1)).toEqual(['c', 'a', 'b']);
		moveEditor(m, 1, 'c', 1, 3);
		expect(paths(m, 1)).toEqual(['a', 'b', 'c']);
	});

	test('a moved preview tab is pinned so the target keeps one preview', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts', { preview: false });
		openEditor(m, 'p.ts');
		const g2 = addGroup(m, 1, 'right')!;
		openEditor(m, 'q.ts', { group: g2 });
		moveEditor(m, 1, 'p.ts', g2);
		expect(paths(m, g2)).toEqual(['~q.ts', 'p.ts']);
		expect([...openPaths(m)].sort()).toEqual(['a.ts', 'p.ts', 'q.ts']);
	});
});

test('resizeSplit clamps to the minimum size', () => {
	const m = createGroupsModel();
	addGroup(m, 1, 'right');
	const root = m.root as GroupSplit;
	resizeSplit(m, root.id, 0, 0.2);
	expect(root.sizes[0]).toBeCloseTo(0.7);
	resizeSplit(m, root.id, 0, 5);
	expect(root.sizes[0]).toBeCloseTo(0.9);
	expect(root.sizes[1]).toBeCloseTo(0.1);
});

describe('workspace file operations', () => {
	test('remapEditors renames tabs in place in every group', () => {
		const m = createGroupsModel();
		openEditor(m, 'src/a.ts', { preview: false });
		openEditor(m, 'README.md', { preview: false });
		const right = splitEditor(m, 'right')!;
		openEditor(m, 'src/b.ts', { preview: false, group: right });
		remapEditors(m, (p) => (p.startsWith('src/') ? 'lib/' + p.slice(4) : null));
		expect(getGroup(m, 1)!.tabs.map((t) => t.path)).toEqual(['lib/a.ts', 'README.md']);
		expect(getGroup(m, 1)!.active).toBe('README.md');
		expect(getGroup(m, right)!.tabs.map((t) => t.path)).toEqual(['README.md', 'lib/b.ts']);
		expect(getGroup(m, right)!.active).toBe('lib/b.ts');
		expect(m.groups).toHaveLength(2);
	});

	test('closeAllGroups leaves one empty group, discarding dirty tabs', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts', { preview: false });
		setDirty(m, 'a.ts', true);
		const right = splitEditor(m, 'down')!;
		openEditor(m, 'b.ts', { group: right });
		closeAllGroups(m);
		expect(m.groups).toHaveLength(1);
		expect(openPaths(m).size).toBe(0);
		expect(m.root.type).toBe('group');
	});
});

describe('editor commands (VS Code editorCommands.ts)', () => {
	const four = () => {
		const m = createGroupsModel();
		for (const p of ['a', 'b', 'c', 'd']) openEditor(m, p, { preview: false });
		return m;
	};

	test('close others / to the right / saved keep dirty tabs', () => {
		let m = four();
		setDirty(m, 'a', true);
		expect(closeOthers(m, 1, 'c')).toEqual(['a']);
		expect(paths(m, 1)).toEqual(['a', 'c']);
		expect(getGroup(m, 1)!.active).toBe('c');
		m = four();
		setActiveEditor(m, 1, 'd');
		expect(closeToRight(m, 1, 'b')).toEqual([]);
		expect(paths(m, 1)).toEqual(['a', 'b']);
		expect(getGroup(m, 1)!.active).toBe('b');
		m = four();
		setDirty(m, 'b', true);
		closeSaved(m, 1);
		expect(paths(m, 1)).toEqual(['b']);
	});

	test('closing focuses the most recently used editor', () => {
		const m = four();
		setActiveEditor(m, 1, 'a');
		setActiveEditor(m, 1, 'd');
		closeEditor(m, 1, 'd');
		expect(getGroup(m, 1)!.active).toBe('a');
		expect(mruOf(m, 1)).toEqual(['a', 'c', 'b']);
	});

	test('reopen closed editor restores the position and skips missing files', () => {
		const m = four();
		closeEditor(m, 1, 'b');
		closeEditor(m, 1, 'c');
		expect(reopenClosed(m, (p) => p !== 'c')).toBe('b');
		expect(paths(m, 1)).toEqual(['a', 'b', 'd']);
		expect(reopenClosed(m)).toBeNull();
		openEditor(m, 'untitled:Untitled-1', { preview: false });
		closeEditor(m, 1, 'untitled:Untitled-1', { force: true });
		expect(reopenClosed(m)).toBeNull();
	});

	test('a moved editor is not reopened in its old group', () => {
		const m = four();
		const g2 = addGroup(m, 1, 'right')!;
		moveEditor(m, 1, 'b', g2);
		expect(reopenClosed(m)).toBeNull();
	});

	test('next/previous editor wraps across groups', () => {
		const m = createGroupsModel();
		openEditor(m, 'a', { preview: false });
		openEditor(m, 'b', { preview: false });
		const g2 = addGroup(m, 1, 'right')!;
		openEditor(m, 'c', { preview: false, group: g2 });
		expect(neighbourEditor(m, 1)).toEqual([1, 'a']);
		expect(neighbourEditor(m, -1)).toEqual([1, 'b']);
		activateGroup(m, 1);
		setActiveEditor(m, 1, 'b');
		expect(neighbourEditor(m, 1)).toEqual([g2, 'c']);
		expect(neighbourEditor(m, 1, { inGroup: true })).toEqual([1, 'a']);
		expect(neighbourEditor(m, -1)).toEqual([1, 'a']);
	});

	test('sticky tabs stay first and new tabs open after them', () => {
		const m = four();
		stickEditor(m, 1, 'c');
		expect(paths(m, 1)).toEqual(['c', 'a', 'b', 'd']);
		setActiveEditor(m, 1, 'c');
		openEditor(m, 'e', { preview: false });
		expect(paths(m, 1)).toEqual(['c', 'e', 'a', 'b', 'd']);
		stickEditor(m, 1, 'd');
		unstickEditor(m, 1, 'c');
		expect(paths(m, 1)).toEqual(['d', 'c', 'e', 'a', 'b']);
		expect(getGroup(m, 1)!.tabs[0].sticky).toBe(true);
	});

	test('split left and up put the new group first', () => {
		const m = createGroupsModel();
		openEditor(m, 'a', { preview: false });
		const left = splitEditor(m, 'left')!;
		expect(groupOrder(m)).toEqual([left, 1]);
		const up = splitEditor(m, 'up')!;
		expect(groupOrder(m)).toEqual([up, left, 1]);
		expect(paths(m, up)).toEqual(['a']);
		expect(closeAllEditors(m)).toEqual([]);
		expect(m.groups).toHaveLength(1);
	});
});
