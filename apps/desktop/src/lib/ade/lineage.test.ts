import { describe, expect, test } from 'bun:test';
import { descendantsOf } from './lineage';

describe('descendants (Orca nested workspaces)', () => {
	test('children by parent or dispatcher, then grandchildren; cycles and strangers ignored', () => {
		const list = [
			{ slug: 'a' },
			{ slug: 'b', parent: 'a' },
			{ slug: 'c', dispatched_by: 'a' },
			{ slug: 'd', parent: 'b' },
			{ slug: 'e', parent: 'x' },
			{ slug: 'f', parent: 'g' },
			{ slug: 'g', parent: 'f' }
		];
		expect(descendantsOf(list, 'a')).toEqual(['b', 'c', 'd']);
		expect(descendantsOf(list, 'd')).toEqual([]);
		expect(descendantsOf(list, 'f')).toEqual(['g']);
	});
});
