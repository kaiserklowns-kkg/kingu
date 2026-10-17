import { describe, expect, test } from 'bun:test';
import { fileIcon, folderIcon } from './fileIcons';

describe('fileIcon', () => {
	test('maps common extensions to a glyph and color', () => {
		expect(fileIcon('src/main.ts')).toMatchObject({ glyph: 'badge', label: 'TS' });
		expect(fileIcon('lib.rs')).toMatchObject({ glyph: 'badge', label: 'RS' });
		expect(fileIcon('main.go')).toMatchObject({ glyph: 'badge', label: 'GO' });
		expect(fileIcon('App.svelte')).toMatchObject({ glyph: 'badge', label: 'S' });
		expect(fileIcon('data.json').glyph).toBe('braces');
		expect(fileIcon('notes.md').glyph).toBe('doc');
		expect(fileIcon('theme.css')).toMatchObject({ glyph: 'badge', label: '#' });
		expect(fileIcon('index.html')).toMatchObject({ glyph: 'badge', label: '<>' });
		expect(fileIcon('rustfmt.toml').glyph).toBe('gear');
		expect(fileIcon('logo.PNG').glyph).toBe('image');
		expect(fileIcon('run.sh').glyph).toBe('terminal');
	});

	test('language colors differ (.ts blue, .rs orange, .go cyan)', () => {
		const colors = ['a.ts', 'a.rs', 'a.go', 'a.svelte', 'a.json', 'a.md'].map((f) => fileIcon(f).color);
		expect(new Set(colors).size).toBe(colors.length);
		for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
	});

	test('special-cases well-known file names before extensions', () => {
		expect(fileIcon('Cargo.toml')).toMatchObject({ glyph: 'package', color: fileIcon('x.rs').color });
		expect(fileIcon('apps/desktop/package.json').glyph).toBe('package');
		expect(fileIcon('Cargo.lock').glyph).toBe('lock');
		expect(fileIcon('bun.lock').glyph).toBe('lock');
		expect(fileIcon('go.mod')).toMatchObject({ glyph: 'package', color: fileIcon('x.go').color });
		expect(fileIcon('README.md').glyph).toBe('book');
		expect(fileIcon('readme').glyph).toBe('book');
		expect(fileIcon('tsconfig.json').glyph).toBe('gear');
		expect(fileIcon('.gitignore').glyph).toBe('git');
		expect(fileIcon('.env.local').glyph).toBe('gear');
	});

	test('falls back to a plain file', () => {
		expect(fileIcon('Procfile').glyph).toBe('file');
		expect(fileIcon('.hidden').glyph).toBe('file');
		expect(fileIcon('archive.unknownext').glyph).toBe('file');
	});

	test('uses the longest known extension', () => {
		expect(fileIcon('types.d.ts')).toMatchObject({ label: 'TS' });
		expect(fileIcon('vite.config.ts')).toMatchObject({ label: 'TS' });
		expect(fileIcon('backup.json.lock').glyph).toBe('lock');
	});
});

describe('folderIcon', () => {
	test('has open and closed variants', () => {
		expect(folderIcon('src/lib', false).glyph).toBe('folder');
		expect(folderIcon('src/lib', true).glyph).toBe('folderOpen');
		expect(folderIcon('src/lib', true).color).toBe(folderIcon('src/lib', false).color);
	});

	test('mutes generated folders', () => {
		expect(folderIcon('node_modules', false).color).not.toBe(folderIcon('lib', false).color);
		expect(folderIcon('apps/desktop/src-tauri/target/', false).color).toBe(folderIcon('node_modules', false).color);
	});
});
