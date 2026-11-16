import { expect, test } from 'bun:test';
import { debugRowAction, moveRow, replFilter } from './debugViewKeys.ts';

test('breakpoints: Space toggles, ⌘⌫ / Delete removes, F2 edits, ↵ opens, ⌘↵ opens to the side', () => {
	expect(debugRowAction('breakpoint', { key: ' ' }, true)).toBe('toggle');
	expect(debugRowAction('breakpoint', { key: 'Backspace', metaKey: true }, true)).toBe('remove');
	expect(debugRowAction('breakpoint', { key: 'Backspace' }, true)).toBeNull();
	expect(debugRowAction('breakpoint', { key: 'Delete' }, false)).toBe('remove');
	expect(debugRowAction('breakpoint', { key: 'F2' }, true)).toBe('edit');
	expect(debugRowAction('breakpoint', { key: 'Enter' }, true)).toBe('open');
	expect(debugRowAction('breakpoint', { key: 'Enter', metaKey: true }, true)).toBe('openToSide');
	expect(debugRowAction('breakpoint', { key: 'Enter', ctrlKey: true }, false)).toBe('openToSide');
	expect(debugRowAction('dataBreakpoint', { key: 'F2' }, true)).toBeNull();
	expect(debugRowAction('functionBreakpoint', { key: ' ' }, false)).toBe('toggle');
});

test('variables: F2 (↵ on macOS) sets the value, ⌘C copies, → / ← expand and collapse', () => {
	expect(debugRowAction('variable', { key: 'Enter' }, true)).toBe('edit');
	expect(debugRowAction('variable', { key: 'Enter' }, false)).toBeNull();
	expect(debugRowAction('variable', { key: 'F2' }, false)).toBe('edit');
	expect(debugRowAction('variable', { key: 'c', metaKey: true }, true)).toBe('copy');
	expect(debugRowAction('variable', { key: 'c', ctrlKey: true }, false)).toBe('copy');
	expect(debugRowAction('variable', { key: 'ArrowRight' }, true)).toBe('expand');
	expect(debugRowAction('variable', { key: 'ArrowLeft' }, true)).toBe('collapse');
});

test('watch: edit, remove, ⌘C copies the value; arrows move', () => {
	expect(debugRowAction('watch', { key: 'F2' }, true)).toBe('edit');
	expect(debugRowAction('watch', { key: 'Backspace', metaKey: true }, true)).toBe('remove');
	expect(debugRowAction('watch', { key: 'c', metaKey: true }, true)).toBe('copy');
	expect(debugRowAction('watch', { key: 'c', metaKey: true, altKey: true }, true)).toBeNull();
	expect(debugRowAction('watch', { key: 'ArrowDown' }, true)).toBe('next');
	expect(debugRowAction('watch', { key: 'End' }, false)).toBe('last');
});

test('moveRow clamps', () => {
	expect(moveRow('next', 2, 3)).toBe(2);
	expect(moveRow('previous', 0, 3)).toBe(0);
	expect(moveRow('last', 0, 3)).toBe(2);
	expect(moveRow('first', 2, 0)).toBe(-1);
});

test('replFilter: include terms, !exclude, case-insensitive', () => {
	const f = replFilter('error, !node_modules');
	expect(f('TypeError at x')).toBe(true);
	expect(f('error in node_modules/x')).toBe(false);
	expect(f('hello')).toBe(false);
	expect(replFilter('!debug')('hello')).toBe(true);
	expect(replFilter('  ')('anything')).toBe(true);
});
