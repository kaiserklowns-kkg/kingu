import { describe, expect, test } from 'bun:test';
import { groupSections, groupedPaths, type Project, type ProjectGroup, type SidebarProject } from './projects';

const g = (id: string, name: string, tab_order: number, parent: string | null = null): ProjectGroup => ({ id, name, tab_order, parent_group_id: parent, parent_path: null, created_from: 'manual', is_collapsed: false, color: null });
const item = (path: string, open = false): SidebarProject => ({ path, name: path.slice(1), open });

describe('groupSections', () => {
	const list: Project[] = [
		{ path: '/a', added_at: 1, group: 'g2', group_order: 1 },
		{ path: '/b', added_at: 2, group: 'g2', group_order: 0 },
		{ path: '/c', added_at: 3, group: 'child' },
		{ path: '/d', added_at: 4, group: 'gone' },
		{ path: '/e', added_at: 5 },
		{ path: '/open', added_at: 6, group: 'g1' }
	];
	const items = list.map((p) => item(p.path, p.path === '/open'));
	const groups = [g('g2', 'Work', 1), g('g1', 'Alpha', 0), g('child', 'Sub', 0, 'g2')];
	const sections = groupSections(items, list, groups);

	test('groups by order, sub-groups after their parent', () => {
		expect(sections.map((s) => [s.group.id, s.depth])).toEqual([
			['g1', 0],
			['g2', 0],
			['child', 1]
		]);
	});
	test('projects by their order in the group; open folder and missing groups left out', () => {
		expect(sections.map((s) => s.projects.map((p) => p.path))).toEqual([[], ['/b', '/a'], ['/c']]);
		expect([...groupedPaths(sections)].sort()).toEqual(['/a', '/b', '/c']);
	});
	test('a group whose parent is unknown or itself is a top-level group', () => {
		const s = groupSections(items, list, [g('x', 'X', 0, 'missing'), g('y', 'Y', 1, 'y')]);
		expect(s.map((x) => [x.group.id, x.depth])).toEqual([
			['x', 0],
			['y', 0]
		]);
	});
});
