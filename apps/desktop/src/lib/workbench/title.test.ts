/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { DEFAULT_TITLE_MAC, DEFAULT_TITLE_OTHER, defaultTitleTemplate, isCustomTitle, renderWindowTitle, template, windowTitle } from './title';

test('window title follows VS Code: dirty mark, editor, folder, app', () => {
	expect(windowTitle({ editor: 'main.ts', folder: 'kingu' })).toBe('main.ts — kingu — Kingu');
	expect(windowTitle({ editor: 'main.ts', folder: 'kingu', dirty: true })).toBe('● main.ts — kingu — Kingu');
	expect(windowTitle({ editor: null, folder: 'kingu', dirty: true })).toBe('kingu — Kingu');
	expect(windowTitle({ editor: 'Settings', folder: '' })).toBe('Settings — Kingu');
	expect(windowTitle({})).toBe('Kingu');
});

test('template() keeps a separator only between two non-empty values (VS Code labels.template)', () => {
	const sep = { label: ' - ' };
	expect(template('${a}${separator}${b}', { a: 'x', b: 'y', separator: sep })).toBe('x - y');
	expect(template('${a}${separator}${b}', { a: '', b: 'y', separator: sep })).toBe('y');
	expect(template('${a}${separator}${b}', { a: 'x', b: '', separator: sep })).toBe('x');
	expect(template('${a}${separator}${separator}${b}', { a: 'x', b: 'y', separator: sep })).toBe('x - y');
	expect(template('[${a}] ${unknown}!', { a: 'x' })).toBe('[x] !');
	expect(template('plain text', {})).toBe('plain text');
});

test('window.title variables', () => {
	const ctx = {
		editor: { short: 'main.ts', medium: 'src/lib/main.ts', long: '/Users/me/kingu/src/lib/main.ts' },
		rootName: 'kingu',
		rootPath: '/Users/me/kingu',
		dirty: true,
		branch: 'feature/x'
	};
	expect(renderWindowTitle(DEFAULT_TITLE_OTHER, ctx)).toBe('● main.ts — kingu — Kingu');
	expect(renderWindowTitle(DEFAULT_TITLE_MAC, ctx)).toBe('main.ts — kingu');
	expect(renderWindowTitle('${activeEditorMedium}${separator}${activeRepositoryBranchName}', ctx)).toBe('src/lib/main.ts — feature/x');
	expect(renderWindowTitle('${activeEditorLong}', ctx)).toBe('/Users/me/kingu/src/lib/main.ts');
	expect(renderWindowTitle('${activeFolderShort} ${folderPath}', ctx)).toBe('lib /Users/me/kingu');
	expect(renderWindowTitle('${rootName}${separator}${appName}', { ...ctx, separator: ' | ' })).toBe('kingu | Kingu');
	// No editor: no dirty mark, no dangling separators; nothing at all falls back to the app name.
	expect(renderWindowTitle(DEFAULT_TITLE_OTHER, { ...ctx, editor: null })).toBe('kingu — Kingu');
	expect(renderWindowTitle(DEFAULT_TITLE_MAC, {})).toBe('Kingu');
	expect(renderWindowTitle('${activeEditorShort}', { app: 'Kingu Dev' })).toBe('Kingu Dev');
});

test('platform default and customised titles', () => {
	expect(defaultTitleTemplate(true)).toBe('${activeEditorShort}${separator}${rootName}');
	expect(defaultTitleTemplate(false)).toBe('${dirty}${activeEditorShort}${separator}${rootName}${separator}${appName}');
	expect(isCustomTitle(DEFAULT_TITLE_MAC, true)).toBe(false);
	expect(isCustomTitle(DEFAULT_TITLE_MAC, false)).toBe(true);
	expect(isCustomTitle('${rootName}', true)).toBe(true);
	expect(isCustomTitle('', true)).toBe(false);
});
