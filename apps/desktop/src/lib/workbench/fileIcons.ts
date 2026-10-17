// Kingu's own file icon theme: a file or folder name → a glyph (drawn by FileIcon.svelte) and a
// color. Pure so it is unit-testable. Not derived from VS Code's Seti or codicon artwork.

export type FileGlyph = 'badge' | 'braces' | 'doc' | 'book' | 'image' | 'lock' | 'gear' | 'package' | 'git' | 'terminal' | 'file' | 'folder' | 'folderOpen';
/** `label` is the short text drawn on a `badge` glyph. */
export type FileIconSpec = { glyph: FileGlyph; color: string; label?: string };

const C = {
	ts: '#3d8fd6',
	js: '#e3c344',
	rust: '#e2793b',
	go: '#2fc0d4',
	svelte: '#f2522e',
	json: '#d9b43c',
	markdown: '#7f97ab',
	css: '#9d7ad8',
	html: '#e5683f',
	config: '#9aa3ab',
	lock: '#8a8f94',
	image: '#b483d6',
	shell: '#8cc46d',
	python: '#4b8fcf',
	git: '#e05a42',
	npm: '#cf4a3d',
	text: '#a0a0a0',
	folder: '#c7a46c',
	folderMuted: '#7d7d7d'
} as const;

const badge = (label: string, color: string): FileIconSpec => ({ glyph: 'badge', label, color });
const glyph = (g: FileGlyph, color: string): FileIconSpec => ({ glyph: g, color });

/** Whole-name matches (lower case) win over extensions. */
const BY_NAME: Record<string, FileIconSpec> = {
	'cargo.toml': glyph('package', C.rust),
	'cargo.lock': glyph('lock', C.rust),
	'package.json': glyph('package', C.npm),
	'package-lock.json': glyph('lock', C.npm),
	'bun.lock': glyph('lock', C.lock),
	'bun.lockb': glyph('lock', C.lock),
	'yarn.lock': glyph('lock', C.lock),
	'pnpm-lock.yaml': glyph('lock', C.lock),
	'go.mod': glyph('package', C.go),
	'go.sum': glyph('lock', C.go),
	'go.work': glyph('package', C.go),
	'tsconfig.json': glyph('gear', C.ts),
	'jsconfig.json': glyph('gear', C.js),
	'tauri.conf.json': glyph('gear', C.rust),
	'.gitignore': glyph('git', C.git),
	'.gitattributes': glyph('git', C.git),
	'.gitmodules': glyph('git', C.git),
	'.env': glyph('gear', C.js),
	'makefile': glyph('terminal', C.config),
	dockerfile: badge('D', C.ts),
	license: glyph('doc', C.json),
	'license.md': glyph('doc', C.json),
	'license.txt': glyph('doc', C.json)
};

const BY_EXT: Record<string, FileIconSpec> = {
	ts: badge('TS', C.ts),
	mts: badge('TS', C.ts),
	cts: badge('TS', C.ts),
	tsx: badge('TX', C.ts),
	js: badge('JS', C.js),
	mjs: badge('JS', C.js),
	cjs: badge('JS', C.js),
	jsx: badge('JX', C.js),
	rs: badge('RS', C.rust),
	go: badge('GO', C.go),
	svelte: badge('S', C.svelte),
	py: badge('PY', C.python),
	css: badge('#', C.css),
	scss: badge('#', C.css),
	html: badge('<>', C.html),
	htm: badge('<>', C.html),
	wasm: badge('WA', C.css),
	json: glyph('braces', C.json),
	jsonc: glyph('braces', C.json),
	json5: glyph('braces', C.json),
	md: glyph('doc', C.markdown),
	mdx: glyph('doc', C.markdown),
	txt: glyph('doc', C.text),
	log: glyph('doc', C.text),
	toml: glyph('gear', C.config),
	yaml: glyph('gear', C.config),
	yml: glyph('gear', C.config),
	ini: glyph('gear', C.config),
	lock: glyph('lock', C.lock),
	png: glyph('image', C.image),
	jpg: glyph('image', C.image),
	jpeg: glyph('image', C.image),
	gif: glyph('image', C.image),
	webp: glyph('image', C.image),
	avif: glyph('image', C.image),
	bmp: glyph('image', C.image),
	ico: glyph('image', C.image),
	icns: glyph('image', C.image),
	svg: glyph('image', C.js),
	sh: glyph('terminal', C.shell),
	bash: glyph('terminal', C.shell),
	zsh: glyph('terminal', C.shell),
	fish: glyph('terminal', C.shell)
};

const DEFAULT_FILE = glyph('file', C.text);

const FOLDER_COLORS: Record<string, string> = {
	'.git': C.folderMuted,
	node_modules: C.folderMuted,
	target: C.folderMuted,
	dist: C.folderMuted,
	build: C.folderMuted,
	src: '#6fa8d8',
	docs: C.markdown,
	test: C.shell,
	tests: C.shell,
	'.github': C.text
};

const basename = (path: string) => path.slice(path.replace(/\/+$/, '').lastIndexOf('/') + 1).replace(/\/+$/, '');

/** Icon for a file name or workspace-relative path. */
export function fileIcon(path: string): FileIconSpec {
	const name = basename(path).toLowerCase();
	const named = BY_NAME[name];
	if (named) return named;
	if (name.startsWith('readme')) return glyph('book', C.ts);
	if (name.startsWith('dockerfile')) return BY_NAME.dockerfile;
	if (name.startsWith('.env.')) return BY_NAME['.env'];
	// A leading dot marks a hidden file, not an extension. Longest extension first, so compounds
	// like `d.ts` can be added to BY_EXT without reordering.
	const dot = name.indexOf('.', 1);
	if (dot < 0) return DEFAULT_FILE;
	const exts = name.slice(dot + 1).split('.');
	for (let i = 0; i < exts.length; i++) {
		const hit = BY_EXT[exts.slice(i).join('.')];
		if (hit) return hit;
	}
	return DEFAULT_FILE;
}

/** Icon for a folder, closed or expanded. */
export function folderIcon(path: string, open: boolean): FileIconSpec {
	const name = basename(path).toLowerCase();
	return glyph(open ? 'folderOpen' : 'folder', FOLDER_COLORS[name] ?? C.folder);
}
