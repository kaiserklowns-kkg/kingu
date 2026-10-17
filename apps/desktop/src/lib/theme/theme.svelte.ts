// Workbench theme service (VS Code: WorkbenchThemeService). Loads the vendored theme for
// `workbench.colorTheme`, writes its `--vscode-*` chrome variables onto <html> (overriding the
// static Dark Modern ones in theme.css), and publishes it to Monaco (theme/current.ts) and xterm.

import { parseJsonc } from '../settings/jsonc';
import { setActiveTheme } from './current';
import { chromeVariables, terminalTheme } from './colors';
import { findTheme, isDarkType, loadTheme, type ThemeInfo } from './themes';
import type { FlatTheme } from '../editor/textmate/theme';

// Lazy chunks: only the selected theme's include chain is fetched.
const sources = import.meta.glob<string>('../editor/textmate/themes/*.json', { query: '?raw', import: 'default' });
const CACHE_KEY = 'kingu.theme.variables';

async function readChain(file: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	let next: string | undefined = file;
	while (next && !(next in files)) {
		const load: (() => Promise<string>) | undefined = sources[`../editor/textmate/themes/${next}`];
		if (!load) throw new Error(`theme file not vendored: ${next}`);
		const text: string = await load();
		files[next] = text;
		const include: string | undefined = parseJsonc<{ include?: string }>(text).include;
		next = include?.replace(/^\.\//, '');
	}
	return files;
}

const flatCache = new Map<string, FlatTheme>();

async function flatTheme(info: ThemeInfo): Promise<FlatTheme> {
	const cached = flatCache.get(info.id);
	if (cached) return cached;
	const files = await readChain(info.file);
	const flat = loadTheme(info, (p) => files[p]);
	flatCache.set(info.id, flat);
	return flat;
}

type Applied = { vars: Record<string, string>; dark: boolean };

function writeVariables({ vars, dark }: Applied) {
	const root = document.documentElement;
	for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
	root.style.colorScheme = dark ? 'dark' : 'light';
	root.dataset.themeType = dark ? 'dark' : 'light';
}

class ThemeService {
	current = $state.raw<ThemeInfo>(findTheme(undefined));
	/** xterm.js theme for the terminal. */
	terminal = $state.raw<ReturnType<typeof terminalTheme>>({} as ReturnType<typeof terminalTheme>);
	private seq = 0;
	/** Last fully applied theme id and its load sequence (skips re-applying the same theme). */
	private applied = '';
	private appliedSeq = -1;

	constructor() {
		// Last session's variables, so a light theme does not flash dark while settings load.
		try {
			const cached = localStorage.getItem(CACHE_KEY);
			if (cached && typeof document !== 'undefined') writeVariables(JSON.parse(cached) as Applied);
		} catch {
			// No cache: theme.css's Dark Modern values show until the theme loads.
		}
	}

	/** Applies a theme by setting value. Stale loads (a newer apply started) are dropped. */
	async apply(id: unknown): Promise<void> {
		const info = findTheme(id);
		if (info.id === this.applied && this.seq === this.appliedSeq) return;
		const seq = ++this.seq;
		const flat = await flatTheme(info);
		if (seq !== this.seq) return;
		const applied: Applied = { vars: chromeVariables(flat.colors, info.type), dark: isDarkType(info.type) };
		writeVariables(applied);
		this.applied = info.id;
		this.appliedSeq = seq;
		this.current = info;
		this.terminal = terminalTheme(flat.colors, info.type);
		setActiveTheme({ info, flat });
		try {
			localStorage.setItem(CACHE_KEY, JSON.stringify(applied));
		} catch {
			// Storage unavailable; only the startup flash is affected.
		}
	}
}

export const theme = new ThemeService();
