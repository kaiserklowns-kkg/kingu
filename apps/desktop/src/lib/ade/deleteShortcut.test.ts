import { describe, expect, test } from 'bun:test';
import { deleteShortcutHasFocus, deleteShortcutTarget } from './deleteShortcut';

const PRIMARY = '';
const tasks = new Set(['a', 'b', 'c']);
const deletable = (key: string) => key !== PRIMARY && tasks.has(key);
const target = (selection: string[], current: string | null, extra: { repeat?: boolean; overlay?: boolean } = {}) => deleteShortcutTarget({ selection, current, deletable, ...extra });

describe('⇧⌘⌫ delete workspace (Orca resolveSidebarWorkspaceDeleteIntent)', () => {
	test('acts on the selected card', () => {
		expect(target([], 'a')).toEqual({ kind: 'single', key: 'a' });
	});
	test('nothing selected does nothing', () => {
		expect(target([], null)).toEqual({ kind: 'none' });
	});
	test('the primary checkout is never deleted', () => {
		expect(target([], PRIMARY)).toEqual({ kind: 'none' });
	});
	test('a card whose task is gone does nothing', () => {
		expect(target([], 'gone')).toEqual({ kind: 'none' });
	});
	test('a multi-selection deletes its deletable members as one batch', () => {
		expect(target(['a', PRIMARY, 'b'], 'c')).toEqual({ kind: 'bulk', keys: ['a', 'b'] });
	});
	test('a multi-selection with one deletable member is a single delete', () => {
		expect(target([PRIMARY, 'b'], 'a')).toEqual({ kind: 'single', key: 'b' });
	});
	test('a multi-selection with nothing deletable does nothing, not the open card', () => {
		expect(target([PRIMARY, 'gone'], 'a')).toEqual({ kind: 'none' });
	});
	test('a selection of one counts as no multi-selection: the open card', () => {
		expect(target(['b'], 'a')).toEqual({ kind: 'single', key: 'a' });
	});
	test('a held key deletes nothing', () => {
		expect(target([], 'a', { repeat: true })).toEqual({ kind: 'none' });
		expect(target(['a', 'b'], 'a', { repeat: true })).toEqual({ kind: 'none' });
	});
	test('an open menu or dialog blocks it', () => {
		expect(target([], 'a', { overlay: true })).toEqual({ kind: 'none' });
	});
});

describe('⇧⌘⌫ focus rule (Orca handleContainerKeyDown)', () => {
	test('only with focus on the worktree list, and not while typing', () => {
		expect(deleteShortcutHasFocus({ inList: true, typing: false })).toBe(true);
		expect(deleteShortcutHasFocus({ inList: false, typing: false })).toBe(false);
		expect(deleteShortcutHasFocus({ inList: true, typing: true })).toBe(false);
	});
});
