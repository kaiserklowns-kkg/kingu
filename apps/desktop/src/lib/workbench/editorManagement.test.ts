// VS Code's editor management settings (workbench.editor.*) on the group model and the tab labels.
import { afterEach, describe, expect, test } from 'bun:test';
import {
	addGroup,
	closeEditor,
	createGroupsModel,
	DEFAULT_BEHAVIOUR,
	enforceLimit,
	groupShowing,
	neighbourGroup,
	nextUnpinned,
	openEditor,
	setBehaviour,
	setDirty,
	stickEditor,
	toggleExpandGroup,
	toggleMaximizeGroup,
	activateGroup,
	type Behaviour,
	type GroupSplit,
	type GroupsModel
} from './editorGroups';
import { NavigationHistory } from './navigation';
import { customLabel, customLabelPatterns, tabDescription, untitledLabel } from './tabLabels';

const paths = (m: GroupsModel, id = m.activeGroup) => m.groups.find((g) => g.id === id)!.tabs.map((t) => t.path);
const use = (b: Partial<Behaviour>) => setBehaviour(() => ({ ...DEFAULT_BEHAVIOUR, ...b }));
afterEach(() => setBehaviour(null));

describe('workbench.editor.openPositioning', () => {
	const opened = (positioning: Behaviour['openPositioning']) => {
		setBehaviour(null);
		const m = createGroupsModel();
		for (const p of ['a', 'b', 'c']) openEditor(m, p, { preview: false });
		openEditor(m, 'b', { preview: false });
		use({ openPositioning: positioning });
		openEditor(m, 'new', { preview: false });
		return paths(m);
	};
	test('right (default), left, first, last', () => {
		expect(opened('right')).toEqual(['a', 'b', 'new', 'c']);
		expect(opened('left')).toEqual(['a', 'new', 'b', 'c']);
		expect(opened('first')).toEqual(['new', 'a', 'b', 'c']);
		expect(opened('last')).toEqual(['a', 'b', 'c', 'new']);
	});
	test('pinned tabs stay first', () => {
		use({ openPositioning: 'first' });
		const m = createGroupsModel();
		openEditor(m, 'a', { preview: false });
		stickEditor(m, 1, 'a');
		openEditor(m, 'b', { preview: false });
		expect(paths(m)).toEqual(['a', 'b']);
	});
});

describe('closing editors', () => {
	test('focusRecentEditorAfterClose: most recently used, or the neighbour', () => {
		const run = () => {
			const m = createGroupsModel();
			for (const p of ['a', 'b', 'c']) openEditor(m, p, { preview: false });
			openEditor(m, 'a');
			openEditor(m, 'b');
			closeEditor(m, 1, 'b');
			return m.groups[0].active;
		};
		expect(run()).toBe('a');
		use({ focusRecentEditorAfterClose: false });
		expect(run()).toBe('c');
	});
	test('closeEmptyGroups off keeps an emptied group', () => {
		use({ closeEmptyGroups: false });
		const m = createGroupsModel();
		const g2 = addGroup(m, 1, 'right')!;
		openEditor(m, 'a', { group: g2 });
		closeEditor(m, g2, 'a');
		expect(m.groups).toHaveLength(2);
	});
});

describe('workbench.editor.splitSizing', () => {
	const sizes = (sizing: Behaviour['splitSizing'], uneven = false) => {
		use({ splitSizing: sizing });
		const m = createGroupsModel();
		const g2 = addGroup(m, 1, 'right')!;
		if (uneven) (m.root as GroupSplit).sizes = [0.8, 0.2];
		addGroup(m, g2, 'right');
		return (m.root as GroupSplit).sizes.map((s) => Math.round(s * 100) / 100);
	};
	test('split halves the group, distribute evens the row, auto distributes only an even row', () => {
		expect(sizes('split')).toEqual([0.5, 0.25, 0.25]);
		expect(sizes('distribute', true)).toEqual([0.33, 0.33, 0.33]);
		expect(sizes('auto')).toEqual([0.33, 0.33, 0.33]);
		expect(sizes('auto', true)).toEqual([0.8, 0.1, 0.1]);
	});
});

describe('workbench.editor.limit.*', () => {
	const model = () => {
		const m = createGroupsModel();
		for (const p of ['a', 'b', 'c', 'd']) openEditor(m, p, { preview: false });
		return m;
	};
	test('closes the least recently used, never the active, pinned or dirty ones', () => {
		const m = model();
		stickEditor(m, 1, 'a');
		setDirty(m, 'b', true);
		enforceLimit(m, { value: 2, perEditorGroup: false, excludeDirty: false }, { group: 1, path: 'd' });
		expect(paths(m)).toEqual(['a', 'b', 'd']);
	});
	test('excludeDirty does not count dirty editors', () => {
		const m = model();
		setDirty(m, 'a', true);
		enforceLimit(m, { value: 3, perEditorGroup: false, excludeDirty: true });
		expect(paths(m)).toEqual(['a', 'b', 'c', 'd']);
		enforceLimit(m, { value: 3, perEditorGroup: false, excludeDirty: false });
		expect(paths(m)).toEqual(['a', 'c', 'd']);
	});
	test('per editor group or across groups', () => {
		const m = model();
		const g2 = addGroup(m, 1, 'right')!;
		openEditor(m, 'x', { group: g2, preview: false });
		openEditor(m, 'y', { group: g2, preview: false });
		const perGroup = structuredClone(m);
		enforceLimit(perGroup, { value: 2, perEditorGroup: true, excludeDirty: false });
		expect([paths(perGroup, 1), paths(perGroup, g2)]).toEqual([['c', 'd'], ['x', 'y']]);
		enforceLimit(m, { value: 3, perEditorGroup: false, excludeDirty: false });
		expect([paths(m, 1), paths(m, g2)]).toEqual([['d'], ['x', 'y']]);
	});
});

describe('groups', () => {
	test('revealIfOpen finds the group that shows a file, the active one first', () => {
		const m = createGroupsModel();
		const g2 = addGroup(m, 1, 'right')!;
		openEditor(m, 'a', { group: g2 });
		activateGroup(m, 1);
		expect(groupShowing(m, 'a')).toBe(g2);
		expect(groupShowing(m, 'b')).toBeNull();
	});
	test('openSideBySideDirection: the group to the right or below', () => {
		const m = createGroupsModel();
		const right = addGroup(m, 1, 'right')!;
		expect(neighbourGroup(m, 1, 'right')).toBe(right);
		expect(neighbourGroup(m, 1, 'down')).toBeNull();
		const below = addGroup(m, 1, 'down')!;
		expect(neighbourGroup(m, 1, 'down')).toBe(below);
		expect(neighbourGroup(m, below, 'right')).toBe(right);
	});
	test('double click expands a group, again evens the grid; maximize shows one group until another is used', () => {
		const m = createGroupsModel();
		const g2 = addGroup(m, 1, 'right')!;
		toggleExpandGroup(m, g2);
		expect((m.root as GroupSplit).sizes).toEqual([0.1, 0.9]);
		toggleExpandGroup(m, g2);
		expect((m.root as GroupSplit).sizes).toEqual([0.5, 0.5]);
		toggleMaximizeGroup(m, g2);
		expect(m.maximized).toBe(g2);
		activateGroup(m, 1);
		expect(m.maximized).toBeNull();
	});
	test('preventPinnedEditorClose: ⌘W on a pinned editor shows the latest unpinned one', () => {
		const m = createGroupsModel();
		for (const p of ['a', 'b', 'c']) openEditor(m, p, { preview: false });
		stickEditor(m, 1, 'c');
		openEditor(m, 'b');
		openEditor(m, 'c');
		expect(nextUnpinned(m)).toEqual([1, 'b']);
	});
});

describe('workbench.editor.navigationScope', () => {
	test('back and forward skip entries outside the scope', () => {
		const h = new NavigationHistory();
		h.record({ path: 'a', line: 1, column: 1, group: 1 });
		h.record({ path: 'b', line: 1, column: 1, group: 2 });
		h.record({ path: 'c', line: 1, column: 1, group: 2 });
		expect(h.back((l) => l.group === 1)?.path).toBe('a');
		expect(h.forward((l) => l.path === 'c')?.path).toBe('c');
		expect(h.back((l) => l.group === 3)).toBeNull();
	});
});

describe('tab labels', () => {
	const root = '/work/kingu';
	test('labelFormat', () => {
		const others = ['src/a/index.ts', 'src/b/index.ts', 'README.md'];
		expect(tabDescription('src/a/index.ts', others, 'default', root)).toBe('…/a');
		expect(tabDescription('README.md', others, 'default', root)).toBe('');
		expect(tabDescription('src/a/index.ts', others, 'short', root)).toBe('a');
		expect(tabDescription('src/a/index.ts', others, 'medium', root)).toBe('src/a');
		expect(tabDescription('src/a/index.ts', others, 'long', root)).toBe('/work/kingu/src/a');
	});
	test('customLabels.patterns', () => {
		const patterns = customLabelPatterns({ '**/index.{ts,js}': '${dirname}/${filename}.${extname}', '**/src/**/*.test.ts': '${dirname(1)} › ${filename}', '*.md': '' });
		expect(customLabel('src/a/index.ts', root, patterns)).toBe('a/index.ts');
		expect(customLabel('src/lib/x/y.test.ts', root, patterns)).toBe('lib › y');
		expect(customLabel('README.md', root, patterns)).toBeUndefined();
	});
	test('untitled.labelFormat', () => {
		expect(untitledLabel('Untitled-1', '  hello world ', 'content')).toBe('hello world');
		expect(untitledLabel('Untitled-1', '', 'content')).toBe('Untitled-1');
		expect(untitledLabel('Untitled-1', 'hello', 'name')).toBe('Untitled-1');
	});
});
