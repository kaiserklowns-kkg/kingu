/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { addGroup, applyLayout, createGroupsModel, EDITOR_LAYOUTS, flipLayout, groupOrder, hasColumns, joinAllGroups, openEditor, type GridNode, type GroupsModel } from './editorGroups';

/** The grid as nested arrays: `r[...]` a row, `c[...]` a column, numbers are group ids. */
function shape(n: GridNode): string {
	return n.type === 'group' ? String(n.id) : `${n.direction === 'row' ? 'r' : 'c'}[${n.children.map(shape).join(',')}]`;
}

function withGroups(count: number): GroupsModel {
	const m = createGroupsModel();
	openEditor(m, 'a.ts');
	for (let i = 1; i < count; i++) {
		const id = addGroup(m, groupOrder(m).at(-1)!, 'right')!;
		openEditor(m, `f${id}.ts`, { group: id });
	}
	return m;
}

describe('editor layouts', () => {
	test('2x2 grid: the existing group plus three new ones, two columns of two rows', () => {
		const m = withGroups(1);
		applyLayout(m, EDITOR_LAYOUTS.editorLayoutTwoByTwoGrid);
		expect(m.groups.length).toBe(4);
		expect(shape(m.root)).toMatch(/^r\[c\[1,\d+\],c\[\d+,\d+\]\]$/);
		expect(groupOrder(m)[0]).toBe(1);
		expect(m.groups.find((g) => g.id === 1)!.tabs.map((t) => t.path)).toEqual(['a.ts']);
	});

	test('fewer cells than groups: the extra groups merge into the last cell', () => {
		const m = withGroups(3);
		const [first, second, third] = groupOrder(m);
		applyLayout(m, EDITOR_LAYOUTS.editorLayoutTwoRows);
		expect(shape(m.root)).toBe(`c[${first},${second}]`);
		expect(m.groups.find((g) => g.id === second)!.tabs.map((t) => t.path)).toEqual([`f${second}.ts`, `f${third}.ts`]);
		expect(m.groups.some((g) => g.id === third)).toBe(false);
	});

	test('single column joins every group', () => {
		const m = withGroups(3);
		applyLayout(m, EDITOR_LAYOUTS.editorLayoutSingle);
		expect(m.groups.length).toBe(1);
		expect(m.root.type).toBe('group');
		expect(m.groups[0].tabs.length).toBe(3);
	});

	test('two rows right and two columns bottom nest the other way', () => {
		const m = withGroups(1);
		applyLayout(m, EDITOR_LAYOUTS.editorLayoutTwoRowsRight);
		expect(shape(m.root)).toMatch(/^r\[1,c\[\d+,\d+\]\]$/);
		applyLayout(m, EDITOR_LAYOUTS.editorLayoutTwoColumnsBottom);
		expect(shape(m.root)).toMatch(/^c\[1,r\[\d+,\d+\]\]$/);
		expect(m.groups.length).toBe(3);
	});

	test('sizes are even unless the layout gives them', () => {
		const m = withGroups(1);
		applyLayout(m, EDITOR_LAYOUTS.editorLayoutThreeColumns);
		expect(m.root.type === 'split' && m.root.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
		applyLayout(m, { orientation: 'row', groups: [{ size: 3 }, { size: 1 }] });
		expect(m.root.type === 'split' && m.root.sizes).toEqual([0.75, 0.25]);
	});

	test('flip turns every split; join keeps the active group', () => {
		const m = withGroups(1);
		applyLayout(m, EDITOR_LAYOUTS.editorLayoutTwoRowsRight);
		flipLayout(m);
		expect(shape(m.root)).toMatch(/^c\[1,r\[\d+,\d+\]\]$/);
		m.activeGroup = groupOrder(m)[2];
		const active = m.activeGroup;
		joinAllGroups(m);
		expect(m.groups.map((g) => g.id)).toEqual([active]);
		expect(m.groups[0].tabs.map((t) => t.path)).toEqual(['a.ts']);
	});

	test('columns: side by side groups, or a row nested in a column', () => {
		const m = withGroups(1);
		expect(hasColumns(m)).toBe(false);
		applyLayout(m, EDITOR_LAYOUTS.editorLayoutTwoRows);
		expect(hasColumns(m)).toBe(false);
		applyLayout(m, EDITOR_LAYOUTS.editorLayoutTwoColumnsBottom);
		expect(hasColumns(m)).toBe(true);
		applyLayout(m, EDITOR_LAYOUTS.editorLayoutTwoColumns);
		expect(hasColumns(m)).toBe(true);
	});
});
