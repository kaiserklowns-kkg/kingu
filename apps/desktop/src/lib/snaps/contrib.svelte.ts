// Hands what active snaps contribute (contributions.ts) to the rest of the app whenever the snap
// list changes: languages and grammars to the editor, snippets to the snippet service, language
// servers to the LSP client, color and file icon themes to the theme service and the settings
// schemas, views to the workbench. Built-in snaps go through the same path as a user's.

import { untrack } from 'svelte';
import { setContributedAssociations } from '#lib/editor/languages.ts';
import { languageFor } from '#lib/editor/languages.ts';
import { setContributedLanguages } from '#lib/editor/contributedLanguages.ts';
import { snippetStore } from '#lib/editor/snippets/snippets.svelte.ts';
import { lsp, type SnapLaunch } from '#lib/lsp/lsp.svelte.ts';
import type { ServerInfo } from '#lib/lsp/model.ts';
import { parseJsonc } from '#lib/settings/jsonc.ts';
import { settingSchemas } from '#lib/settings/schemas.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { forgetSnapThemes, theme } from '#lib/theme/theme.svelte.ts';
import { allThemes, setContributedThemes, THEMES, themesOfSnaps, type ThemeInfo } from '#lib/theme/themes.ts';
import { isDarkType } from '#lib/theme/themes.ts';
import { setIconOverride, type FileIconSpec } from '#lib/workbench/fileIcons.ts';
import { clientLog } from '#lib/client-log.ts';
import {
	contributing,
	grammarsOf,
	iconThemesOf,
	languageAssociations,
	languageConfiguration,
	languagesOf,
	lspServersOf,
	snapServerSettings,
	snippetsOf,
	viewsOf,
	type ContributedIconTheme
} from './contributions.ts';
import { iconPathFor, parseIconTheme, type IconTheme } from './iconTheme.ts';
import { readSnapImage, readSnapText } from './snapFiles.ts';
import { expandArgv, expandEnv, sandboxRefusal, settingId, type SandboxPlan, type SettingValue, type SnapInfo } from './snapModel.ts';

/** The settings that pick a color theme (VS Code lists installed themes in each one's enum). */
const THEME_SETTINGS = ['workbench.colorTheme', 'workbench.preferredDarkColorTheme', 'workbench.preferredLightColorTheme', 'workbench.preferredHighContrastColorTheme', 'workbench.preferredHighContrastLightColorTheme'];
const ICON_THEME_SETTING = 'workbench.iconTheme';

class SnapContrib {
	/** Every color theme (built-in, then snaps'), for the pickers. */
	themes = $state.raw<ThemeInfo[]>(THEMES);
	/** Snaps' file icon themes. */
	iconThemes = $state.raw<ContributedIconTheme[]>([]);
	/** The snap icon theme in use and its images (definition path → data URL); null: Kingu's own. */
	icon = $state.raw<{ id: string; theme: IconTheme; images: Record<string, string> } | null>(null);
	#iconSeq = 0;
	#keys = { languages: '', snippets: '', themes: '', icons: '' };

	/** The file icon of a name under the snap icon theme in use (fileIcons.ts calls it). */
	iconFor(name: string, kind: 'file' | 'folder' | 'folderOpen'): FileIconSpec | null {
		const icon = this.icon;
		if (!icon) return null;
		const variant = isDarkType(theme.current.type) ? (theme.current.type === 'hcDark' ? 'highContrast' : 'dark') : theme.current.type === 'hcLight' ? 'highContrast' : 'light';
		const path = iconPathFor(icon.theme, name, kind, kind === 'file' ? languageFor(name) : undefined, variant);
		const src = path ? icon.images[path] : undefined;
		return src ? { glyph: 'url', color: '', src } : null;
	}

	apply(list: SnapInfo[], plan: SandboxPlan) {
		this.#languages(list);
		void this.#snippets(list);
		this.#servers(list, plan);
		this.#themes(list);
	}

	#languages(list: SnapInfo[]) {
		const langs = languagesOf(list);
		const grammars = grammarsOf(list);
		const key = JSON.stringify([langs, grammars]);
		if (key === this.#keys.languages) return;
		this.#keys.languages = key;
		const aliases = Object.fromEntries(langs.filter((l) => l.language.aliases[0]).map((l) => [l.language.id, l.language.aliases[0]]));
		setContributedAssociations(languageAssociations(langs), aliases);
		const sha = (snap: SnapInfo | undefined, path: string) => snap?.contributes?.files.find((f) => f.path === path)?.sha256;
		const find = (ref: { source: string; id: string }) => list.find((s) => s.source === ref.source && s.id === ref.id);
		setContributedLanguages({
			languages: langs.map(({ snap, language: l }) => ({
				id: l.id,
				aliases: l.aliases,
				extensions: l.extensions,
				filenames: l.filenames,
				configuration: l.configuration ? async () => languageConfiguration(parseJsonc(await readSnapText(snap, l.configuration!, sha(find(snap), l.configuration!)))) : null
			})),
			grammars: grammars.map((g) => ({ ...g, load: () => readSnapText(g.snap, g.path, g.sha256) }))
		});
	}

	async #snippets(list: SnapInfo[]) {
		const files = snippetsOf(list);
		const key = JSON.stringify(files);
		if (key === this.#keys.snippets) return;
		this.#keys.snippets = key;
		const loaded = await Promise.all(
			files.map(async (f) => {
				try {
					return { file: `${f.snapName}: ${f.path}`, language: f.language, text: await readSnapText(f.snap, f.path, f.sha256) };
				} catch (e) {
					clientLog('info', `snap snippets ${f.snap.id}/${f.path}: ${e}`);
					return null;
				}
			})
		);
		if (key === this.#keys.snippets) snippetStore.setSnapFiles(loaded.filter((x) => x !== null));
	}

	#servers(list: SnapInfo[], plan: SandboxPlan) {
		const find = (info: ServerInfo) => list.find((s) => s.source === info.snap?.source && s.id === info.snap?.id);
		const values = (snap: SnapInfo) => {
			const out: Record<string, SettingValue | undefined> = {};
			for (const st of snap.settings) {
				const v = settings.get(settingId(snap.id, st.key));
				out[st.key] = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : st.default;
			}
			return out;
		};
		lsp.setSnapServers(lspServersOf(list), {
			launch: (info): SnapLaunch => {
				const snap = find(info);
				if (!snap || !info.snap) return { error: `${info.name}: snap not found` };
				const v = values(snap);
				const argv = expandArgv(info.snap.command, v);
				const env = expandEnv(info.snap.env, v);
				// Built-in servers run as the table's always did; others like the snap's tasks.
				if (snap.source === 'builtin' || plan.kind === 'off') return { argv, env, sandbox: false };
				if (plan.kind === 'refuse') return { error: sandboxRefusal(plan)! };
				return { argv, env, sandbox: true };
			},
			settings: (info) => snapServerSettings(find(info), info.snap?.settingsSection ?? null, (id) => settings.get(id))
		});
	}

	#themes(list: SnapInfo[]) {
		const snaps = contributing(list).filter((s) => s.source !== 'builtin');
		const themes = themesOfSnaps(snaps);
		const icons = iconThemesOf(list);
		const key = JSON.stringify([themes, icons]);
		if (key === this.#keys.themes) return;
		this.#keys.themes = key;
		forgetSnapThemes();
		setContributedThemes(themes);
		this.themes = allThemes();
		const extra = this.themes.filter((t) => !THEMES.includes(t));
		for (const id of THEME_SETTINGS)
			settingSchemas.extendEnum(
				'snaps',
				id,
				extra.map((t) => t.id),
				extra.map((t) => t.label)
			);
		settingSchemas.extendEnum(
			'snaps',
			ICON_THEME_SETTING,
			icons.map((i) => i.theme.id),
			icons.map((i) => i.theme.label)
		);
		this.iconThemes = icons;
		theme.themesChanged();
		this.#keys.icons = '';
		void this.loadIconTheme(settings.get(ICON_THEME_SETTING));
	}

	/** Loads the snap icon theme `id` names (its JSON and images); anything else is Kingu's own. */
	async loadIconTheme(id: unknown) {
		const entry = this.iconThemes.find((i) => i.theme.id === id);
		const key = entry ? JSON.stringify(entry) : '';
		if (key === this.#keys.icons) return;
		this.#keys.icons = key;
		const seq = ++this.#iconSeq;
		if (!entry) {
			this.icon = null;
			return;
		}
		try {
			const parsed = parseIconTheme(parseJsonc(await readSnapText(entry.snap, entry.theme.path, entry.sha256)), entry.theme.path);
			const images: Record<string, string> = {};
			await Promise.all(
				[...new Set(Object.values(parsed.icons))].map(async (p) => {
					images[p] = await readSnapImage(entry.snap, p).catch(() => '');
				})
			);
			if (seq === this.#iconSeq) this.icon = { id: entry.theme.id, theme: parsed, images };
		} catch (e) {
			clientLog('info', `snap icon theme ${entry.theme.id}: ${e}`);
			if (seq === this.#iconSeq) this.icon = null;
		}
	}

	/** Views of active user and repo snaps. */
	views(list: SnapInfo[]) {
		return viewsOf(list);
	}
}

export const snapContrib = new SnapContrib();
setIconOverride((name, kind) => snapContrib.iconFor(name, kind));

/** Applies `all()` (built-in and listed snaps) whenever it or the sandbox plan changes. */
export function installContributions(all: () => SnapInfo[], plan: () => SandboxPlan): () => void {
	return $effect.root(() => {
		$effect(() => {
			const list = all();
			const p = plan();
			untrack(() => snapContrib.apply(list, p));
		});
		$effect(() => {
			const id = settings.get(ICON_THEME_SETTING);
			untrack(() => void snapContrib.loadIconTheme(id));
		});
	});
}
