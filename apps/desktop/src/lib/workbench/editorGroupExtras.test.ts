import { afterEach, describe, expect, test } from 'bun:test';
import {
	addGroup,
	closeEditor,
	createGroupsModel,
	DEFAULT_BEHAVIOUR,
	expandGroup,
	getGroup,
	groupOrder,
	isLockedFor,
	isSplitInGroup,
	joinWithNextGroup,
	neighbourGroup,
	openEditor,
	remapEditors,
	setBehaviour,
	setGroupLocked,
	setSplitInGroup,
	toggleMaximizeGroup,
	unlockedGroupFor
} from './editorGroups.ts';
import { parseLayout, serializeLayout } from './editorLayout.ts';
import { autoLocks, canSplitInGroup, editorTypeId } from './editorKind.ts';

afterEach(() => setBehaviour(null));

describe('locked editor groups', () => {
	test('a new editor skips a locked active group for the most recently used unlocked one', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts');
		const right = addGroup(m, 1, 'right')!;
		const below = addGroup(m, right, 'down')!;
		openEditor(m, 'b.ts', { group: below });
		openEditor(m, 'c.ts', { group: right });
		setGroupLocked(m, right, true);
		expect(unlockedGroupFor(m, 'd.ts')).toBe(below);
		// A file the locked group already shows stays there.
		expect(unlockedGroupFor(m, 'c.ts')).toBe(right);
		// An unlocked active group takes it.
		m.activeGroup = 1;
		expect(unlockedGroupFor(m, 'd.ts')).toBe(1);
	});

	test('every group locked: null, so the caller adds one', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts');
		setGroupLocked(m, 1, true);
		expect(isLockedFor(getGroup(m, 1)!, 'b.ts')).toBe(true);
		expect(isLockedFor(getGroup(m, 1)!, 'a.ts')).toBe(false);
		expect(unlockedGroupFor(m, 'b.ts')).toBeNull();
		setGroupLocked(m, 1, false);
		expect(getGroup(m, 1)!.locked).toBeUndefined();
		expect(unlockedGroupFor(m, 'b.ts')).toBe(1);
	});

	test('workbench.editor.autoLockGroups locks a group whose first editor is of a listed type', () => {
		setBehaviour(() => ({ ...DEFAULT_BEHAVIOUR, autoLock: (p) => autoLocks(p, { 'workbench.editorinputs.searchEditorInput': true, default: false }) }));
		const m = createGroupsModel();
		openEditor(m, 'a.ts', { preview: false });
		const right = addGroup(m, 1, 'right')!;
		openEditor(m, 'search-editor:1', { group: right });
		expect(getGroup(m, right)!.locked).toBe(true);
		// Not the first editor of the group, or the only group: no lock.
		openEditor(m, 'search-editor:2', { group: 1 });
		expect(getGroup(m, 1)!.locked).toBeUndefined();
		const single = createGroupsModel();
		openEditor(single, 'search-editor:1');
		expect(getGroup(single, 1)!.locked).toBeUndefined();
	});

	test('editor type ids', () => {
		expect(editorTypeId('src/a.ts')).toBe('default');
		expect(editorTypeId('search-editor:1')).toBe('workbench.editorinputs.searchEditorInput');
		expect(editorTypeId('preview:README.md')).toBe('mainThreadWebview-markdown.preview');
		expect(editorTypeId('logo.png')).toBe('imagePreview.previewEditor');
		expect(editorTypeId('settings://user')).toBeNull();
		expect(autoLocks('a.ts', { default: true })).toBe(true);
		expect(autoLocks('a.ts', { default: false })).toBe(false);
		expect(autoLocks('a.ts', null)).toBe(false);
	});
});

describe('join, expand and maximize', () => {
	test('neighbours in every direction', () => {
		const m = createGroupsModel();
		const right = addGroup(m, 1, 'right')!;
		const below = addGroup(m, right, 'down')!;
		expect(neighbourGroup(m, right, 'left')).toBe(1);
		expect(neighbourGroup(m, below, 'left')).toBe(1);
		expect(neighbourGroup(m, below, 'up')).toBe(right);
		expect(neighbourGroup(m, 1, 'up')).toBeNull();
		// Left of the right column lands on its nearest group.
		const m2 = createGroupsModel();
		const r2 = addGroup(m2, 1, 'right')!;
		const r3 = addGroup(m2, r2, 'right')!;
		expect(neighbourGroup(m2, r3, 'left')).toBe(r2);
	});

	test('Join Editor Group with Next Group merges right, else left', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts');
		const right = addGroup(m, 1, 'right')!;
		openEditor(m, 'b.ts', { group: right });
		expect(joinWithNextGroup(m, 1)).toBe(right);
		expect(groupOrder(m)).toEqual([right]);
		expect(getGroup(m, right)!.tabs.map((t) => t.path)).toEqual(['b.ts', 'a.ts']);
		const m2 = createGroupsModel();
		const r = addGroup(m2, 1, 'right')!;
		openEditor(m2, 'x.ts', { group: r });
		expect(joinWithNextGroup(m2, r)).toBe(1);
		expect(joinWithNextGroup(m2, 1)).toBeNull();
	});

	test('Expand Editor Group, Toggle Maximize', () => {
		const m = createGroupsModel();
		const right = addGroup(m, 1, 'right')!;
		expandGroup(m, right);
		expect(m.expanded).toBe(right);
		expandGroup(m, right);
		expect(m.expanded).toBe(right);
		toggleMaximizeGroup(m, 1);
		expect(m.maximized).toBe(1);
		toggleMaximizeGroup(m, 1);
		expect(m.maximized).toBeNull();
	});
});

describe('split editor in group', () => {
	test('split, follows renames, ends with the tab', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts');
		setSplitInGroup(m, 1, 'a.ts', true);
		const g = getGroup(m, 1)!;
		expect(isSplitInGroup(g, 'a.ts')).toBe(true);
		// Splitting keeps the editor (no longer a preview).
		expect(g.tabs[0].preview).toBe(false);
		remapEditors(m, (p) => (p === 'a.ts' ? 'b.ts' : null));
		expect(isSplitInGroup(g, 'b.ts')).toBe(true);
		closeEditor(m, 1, 'b.ts');
		expect(g.splitIn).toBeUndefined();
		// Only a tab of the group can be split.
		setSplitInGroup(m, 1, 'zzz.ts', true);
		expect(g.splitIn).toBeUndefined();
	});

	test('join in group', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts', { preview: false });
		setSplitInGroup(m, 1, 'a.ts', true);
		setSplitInGroup(m, 1, 'a.ts', false);
		expect(isSplitInGroup(getGroup(m, 1), 'a.ts')).toBe(false);
	});

	test('which editors can split', () => {
		expect(canSplitInGroup('src/a.ts')).toBe(true);
		expect(canSplitInGroup('untitled:Untitled-1')).toBe(true);
		for (const k of ['diff:src/a.ts', 'logo.png', 'nb.ipynb', 'settings://user', 'preview:a.md', null]) expect(canSplitInGroup(k)).toBe(false);
	});
});

describe('restored per workspace', () => {
	test('locked groups, split editors and the maximized group come back', () => {
		const m = createGroupsModel();
		openEditor(m, 'a.ts', { preview: false });
		setSplitInGroup(m, 1, 'a.ts', true);
		const right = addGroup(m, 1, 'right')!;
		openEditor(m, 'b.ts', { group: right, preview: false });
		setGroupLocked(m, right, true);
		toggleMaximizeGroup(m, right);
		const keep = () => true;
		const back = parseLayout(JSON.parse(JSON.stringify(serializeLayout(m, keep))), keep)!.model;
		expect(getGroup(back, right)!.locked).toBe(true);
		expect(getGroup(back, 1)!.locked).toBeUndefined();
		expect(getGroup(back, 1)!.splitIn).toEqual(['a.ts']);
		expect(back.maximized).toBe(right);
		expect(back.activeGroup).toBe(right);
	});

	test('bad saved values are dropped', () => {
		const keep = () => true;
		const raw = {
			groups: [
				{ id: 1, tabs: [{ path: 'a.ts' }], active: 'a.ts', mru: [], locked: 'yes', splitIn: ['gone.ts', 3, 'a.ts'] },
				{ id: 2, tabs: [], active: null, mru: [] }
			],
			root: { type: 'split', id: 3, direction: 'row', children: [{ type: 'group', id: 1 }, { type: 'group', id: 2 }], sizes: [0.5, 0.5] },
			activeGroup: 1,
			maximized: 9
		};
		const back = parseLayout(raw, keep)!.model;
		expect(getGroup(back, 1)!.locked).toBeUndefined();
		expect(getGroup(back, 1)!.splitIn).toEqual(['a.ts']);
		expect(back.maximized).toBeNull();
	});
});
