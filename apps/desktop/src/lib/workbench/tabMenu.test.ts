import { describe, expect, test } from 'bun:test';
import { tabsToClose } from './tabMenu';

const tabs = [{ path: 'a' }, { path: 'b', dirty: true }, { path: 'c' }, { path: 'd' }];

describe('tabsToClose', () => {
	test('others, to the right, saved, all', () => {
		expect(tabsToClose('others', tabs, 'c')).toEqual(['a', 'b', 'd']);
		expect(tabsToClose('right', tabs, 'b')).toEqual(['c', 'd']);
		expect(tabsToClose('right', tabs, 'd')).toEqual([]);
		expect(tabsToClose('saved', tabs, 'a')).toEqual(['a', 'c', 'd']);
		expect(tabsToClose('all', tabs, 'a')).toEqual(['a', 'b', 'c', 'd']);
		expect(tabsToClose('right', tabs, 'missing')).toEqual([]);
	});
});
