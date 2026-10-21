// Workbench theme service (VS Code: WorkbenchThemeService). Loads the vendored theme for
// `workbench.colorTheme`, writes its `--vscode-*` chrome variables onto <html> (overriding the
// static Dark Modern ones in theme.css), and publishes it to Monaco (theme/current.ts) and xterm.

import { parseJsonc } from '../settings/jsonc';
import { setActiveTheme } from './current';
import { chromeVariables, resolveColor, terminalTheme } from './colors';
import { findTheme, isDarkType, loadTheme, THEMES, type ThemeInfo } from './themes';
import { joinPath, type FlatTheme } from '../editor/textmate/theme';
import { colorCustomizationsFor } from '../workbench/workbenchOptions';
import { withTokenCustomizations } from './tokenCustomizations';

// Lazy chunks: only the selected theme's include chain is fetched.
const sources = import.meta.glob<string>('../editor/textmate/themes/*.json', { query: '?raw', import: 'default' });
const CACHE_KEY = 'kingu.theme.variables';

/** The theme's file and its include chain: a Snap theme's own files, else the vendored ones (by name). */
async function readChain(info: ThemeInfo): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	let next: string | undefined = info.file;
	while (next && !(next in files)) {
		let text: string | undefined = info.files?.[next];
		if (text === undefined) {
			const name: string = next.split('/').pop() ?? next;
			const load: (() => Promise<string>) | undefined = sources[`../editor/textmate/themes/${name}`];
			if (!load) throw new Error(`theme file not found: ${next}`);
			text = await load();
		}
		files[next] = text;
		const include: string | undefined = parseJsonc<{ include?: string }>(text).include;
		next = include ? joinPath(next, include) : undefined;
	}
	return files;
}

const flatCache = new Map<string, FlatTheme>();

async function flatTheme(info: ThemeInfo): Promise<FlatTheme> {
	const cached = flatCache.get(info.id);
	if (cached) return cached;
	const files = await readChain(info);
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
	/** `workbench.colorCustomizations`, on top of whichever theme is applied. */
	private custom: unknown = {};
	private customKey = '{}';
	/** `editor.tokenColorCustomizations` and `editor.semanticTokenColorCustomizations`. */
	private tokenCustom: unknown = {};
	private semanticCustom: unknown = {};
	private tokenKey = '[{},{}]';
	/** Bumped on every applied theme or customization, for effects that read the theme's data (`activeTheme()`). */
	revision = $state(0);

	/** Sets `workbench.colorCustomizations`; the current theme is applied again when they changed. */
	setCustomizations(custom: unknown) {
		const key = JSON.stringify(custom ?? {});
		if (key === this.customKey) return;
		this.custom = custom;
		this.customKey = key;
		this.reapply();
	}

	/** Sets the token color customizations; the current theme is applied again when they changed. */
	setTokenCustomizations(token: unknown, semantic: unknown) {
		const key = JSON.stringify([token ?? {}, semantic ?? {}]);
		if (key === this.tokenKey) return;
		this.tokenCustom = token;
		this.semanticCustom = semantic;
		this.tokenKey = key;
		this.reapply();
	}

	private reapply() {
		const id = this.applied;
		this.applied = '';
		if (id) void this.apply(id);
	}

	constructor() {
		// Last session's variables, so a light theme does not flash dark while settings load.
		try {
			const cached = localStorage.getItem(CACHE_KEY);
			if (cached && typeof document !== 'undefined') writeVariables(JSON.parse(cached) as Applied);
		} catch {
			// No cache: theme.css's Dark Modern values show until the theme loads.
		}
	}

	/** The setting value last asked for (it may name a Snap theme that is not loaded yet). */
	private requested: unknown = undefined;

	/** Applies a theme by setting value. Stale loads (a newer apply started) are dropped. */
	async apply(id: unknown): Promise<void> {
		this.requested = id;
		const info = findTheme(id);
		if (info.id === this.applied && this.seq === this.appliedSeq) return;
		const seq = ++this.seq;
		const base = await flatTheme(info);
		if (seq !== this.seq) return;
		const custom = colorCustomizationsFor(this.custom, info.id);
		const colored = Object.keys(custom).length ? { ...base, colors: { ...base.colors, ...custom } } : base;
		const flat = withTokenCustomizations(colored, this.tokenCustom, this.semanticCustom, [info.id, info.label]);
		const applied: Applied = { vars: chromeVariables(flat.colors, info.type), dark: isDarkType(info.type) };
		writeVariables(applied);
		this.applied = info.id;
		this.appliedSeq = seq;
		this.current = info;
		this.terminal = terminalTheme(flat.colors, info.type);
		setActiveTheme({ info, flat });
		this.revision++;
		try {
			localStorage.setItem(CACHE_KEY, JSON.stringify(applied));
		} catch {
			// Storage unavailable; only the startup flash is affected.
		}
	}

	/**
	 * The Snaps' themes changed (setSnapThemes): their cached copies are dropped and the theme asked
	 * for is applied again, so one that only now became available (startup) or changed takes effect.
	 */
	async refresh(): Promise<void> {
		for (const key of [...flatCache.keys()]) if (!THEMES.some((t) => t.id === key)) flatCache.delete(key);
		this.applied = '';
		await this.apply(this.requested);
	}
}

export const theme = new ThemeService();

/** A few colors of a theme for its preview card in Settings › Appearance (loads the theme lazily). */
export async function themeSwatch(info: ThemeInfo): Promise<Record<'chrome' | 'side' | 'editor' | 'fg' | 'muted' | 'accent' | 'border' | 'selection', string>> {
	const flat = await flatTheme(info);
	const c = (id: string, fallback: string) => resolveColor(id, flat.colors, info.type) ?? fallback;
	return {
		chrome: c('titleBar.activeBackground', '#222'),
		side: c('sideBar.background', '#222'),
		editor: c('editor.background', '#111'),
		fg: c('editor.foreground', '#ccc'),
		muted: c('descriptionForeground', '#888'),
		accent: c('button.background', '#0078D4'),
		border: c('widget.border', '#0000'),
		selection: c('list.activeSelectionBackground', '#0078D455')
	};
}

