// A snap's file icon theme: VS Code's icon theme JSON (`iconDefinitions` plus file, folder,
// extension, file name, folder name and language id maps), resolved the way VS Code's
// FileIconThemeLoader matches a resource: file name, then the longest extension, then language,
// then the default. Image icons (`iconPath`) only; font icons (`fontCharacter`) are left out and
// fall back to Kingu's own icons. Pure: contrib.svelte.ts reads the files.

import { resolveSnapPath } from './contributions.ts';

type Maps = {
	file?: string;
	folder?: string;
	folderExpanded?: string;
	rootFolder?: string;
	rootFolderExpanded?: string;
	fileExtensions: Record<string, string>;
	fileNames: Record<string, string>;
	folderNames: Record<string, string>;
	folderNamesExpanded: Record<string, string>;
	languageIds: Record<string, string>;
};

export type IconTheme = Maps & {
	/** `light` and `highContrast` overrides of the maps. */
	light: Partial<Maps>;
	highContrast: Partial<Maps>;
	/** Definition id → the icon's path in the snap. */
	icons: Record<string, string>;
};

const strings = (v: unknown): Record<string, string> => {
	const out: Record<string, string> = {};
	if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k.toLowerCase()] = x;
	return out;
};
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function maps(o: Record<string, unknown>): Maps {
	return {
		file: str(o.file),
		folder: str(o.folder),
		folderExpanded: str(o.folderExpanded),
		rootFolder: str(o.rootFolder),
		rootFolderExpanded: str(o.rootFolderExpanded),
		fileExtensions: strings(o.fileExtensions),
		fileNames: strings(o.fileNames),
		folderNames: strings(o.folderNames),
		folderNamesExpanded: strings(o.folderNamesExpanded),
		languageIds: strings(o.languageIds)
	};
}

/** Parses an icon theme file at `path` in its snap; icon paths come back relative to the snap. */
export function parseIconTheme(json: unknown, path: string): IconTheme {
	const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
	const icons: Record<string, string> = {};
	const defs = (o.iconDefinitions && typeof o.iconDefinitions === 'object' ? o.iconDefinitions : {}) as Record<string, unknown>;
	for (const [id, def] of Object.entries(defs)) {
		const iconPath = def && typeof def === 'object' ? (def as { iconPath?: unknown }).iconPath : undefined;
		const resolved = typeof iconPath === 'string' ? resolveSnapPath(path, iconPath) : null;
		if (resolved) icons[id] = resolved;
	}
	const sub = (v: unknown) => (v && typeof v === 'object' ? maps(v as Record<string, unknown>) : {});
	return { ...maps(o), light: sub(o.light), highContrast: sub(o.highContrast), icons };
}

export type IconKind = 'file' | 'folder' | 'folderOpen';
export type IconVariant = 'dark' | 'light' | 'highContrast';

/** The definition id for a file or folder name (VS Code's precedence), or undefined. */
export function iconIdFor(theme: IconTheme, name: string, kind: IconKind, languageId?: string, variant: IconVariant = 'dark'): string | undefined {
	const over: Partial<Maps> = variant === 'light' ? theme.light : variant === 'highContrast' ? theme.highContrast : {};
	const lookup = (key: keyof Maps, k: string) => (over[key] as Record<string, string> | undefined)?.[k] ?? (theme[key] as Record<string, string>)[k];
	const single = (key: 'file' | 'folder' | 'folderExpanded') => over[key] ?? theme[key];
	const lower = name.toLowerCase();
	if (kind !== 'file') {
		const named = kind === 'folderOpen' ? (lookup('folderNamesExpanded', lower) ?? lookup('folderNames', lower)) : lookup('folderNames', lower);
		return named ?? (kind === 'folderOpen' ? (single('folderExpanded') ?? single('folder')) : single('folder'));
	}
	const byName = lookup('fileNames', lower);
	if (byName) return byName;
	// `a.d.ts` tries `d.ts`, then `ts` (a leading dot is a hidden file, not an extension).
	for (let i = lower.indexOf('.', 1); i >= 0; i = lower.indexOf('.', i + 1)) {
		const hit = lookup('fileExtensions', lower.slice(i + 1));
		if (hit) return hit;
	}
	return (languageId && lookup('languageIds', languageId.toLowerCase())) || single('file');
}

/** The icon image path (in the snap) for a name, or undefined to keep Kingu's own icon. */
export function iconPathFor(theme: IconTheme, name: string, kind: IconKind, languageId?: string, variant?: IconVariant): string | undefined {
	const id = iconIdFor(theme, name, kind, languageId, variant);
	return id ? theme.icons[id] : undefined;
}
