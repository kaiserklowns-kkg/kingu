// Window title (VS Code's `window.title` setting, browser/parts/titlebar/windowTitle.ts and the
// `template()` helper of base/common/labels.ts). Pure, so it is unit-testable.

export const APP_NAME = 'Kingu';
export const TITLE_SEPARATOR = ' — ';
/** VS Code's `${dirty}`: shown before the editor name while it has unsaved changes. */
export const DIRTY_MARK = '● ';

/** VS Code's macOS default (the dirty state shows in the window's close button there). */
export const DEFAULT_TITLE_MAC = '${activeEditorShort}${separator}${rootName}${separator}${profileName}';
/** VS Code's Windows/Linux default. */
export const DEFAULT_TITLE_OTHER = '${dirty}${activeEditorShort}${separator}${rootName}${separator}${profileName}${separator}${appName}';

export const defaultTitleTemplate = (mac: boolean) => (mac ? DEFAULT_TITLE_MAC : DEFAULT_TITLE_OTHER);

/** The user changed `window.title` from the platform default (the command center then shows the full title). */
export const isCustomTitle = (template: string | null | undefined, mac: boolean) => !!template && template !== defaultTitleTemplate(mac);

type Separator = { label: string };
type Segment = { value: string; type: 'text' | 'variable' | 'separator' };

/**
 * VS Code's `template()`: `${name}` is replaced by `values[name]`; a separator value is kept only
 * between two non-empty segments, so `${activeEditorShort}${separator}${rootName}` with no editor is
 * just the folder name. (Like VS Code, a `$` always starts a variable.)
 */
export function template(tpl: string, values: Record<string, string | Separator | null | undefined>): string {
	const segments: Segment[] = [];
	let inVariable = false;
	let cur = '';
	for (const ch of tpl) {
		if (ch === '$' || (inVariable && ch === '{')) {
			if (cur) segments.push({ value: cur, type: 'text' });
			cur = '';
			inVariable = true;
		} else if (ch === '}' && inVariable) {
			const resolved = values[cur];
			if (typeof resolved === 'string') {
				if (resolved.length) segments.push({ value: resolved, type: 'variable' });
			} else if (resolved) {
				// No two separators in a row.
				if (segments[segments.length - 1]?.type !== 'separator') segments.push({ value: resolved.label, type: 'separator' });
			}
			cur = '';
			inVariable = false;
		} else cur += ch;
	}
	if (cur && !inVariable) segments.push({ value: cur, type: 'text' });
	return segments
		.filter((s, i) => {
			if (s.type !== 'separator') return true;
			const around = [segments[i - 1], segments[i + 1]];
			return around.every((o) => o && o.type !== 'separator' && o.value.length > 0);
		})
		.map((s) => s.value)
		.join('');
}

export type TitleContext = {
	/** The active editor's labels: file name, workspace-relative path, absolute path. */
	editor?: { short: string; medium?: string; long?: string } | null;
	/** The open folder's name (`${rootName}`, `${folderName}`). */
	rootName?: string | null;
	/** The open folder's path (`${rootPath}`, `${folderPath}`). */
	rootPath?: string | null;
	dirty?: boolean;
	/** `${activeRepositoryBranchName}`. */
	branch?: string | null;
	/** `${activeEditorLanguageId}`. */
	languageId?: string | null;
	/** `${focusedView}`: the name of the focused view (Explorer, Terminal…). */
	focusedView?: string | null;
	app?: string;
	separator?: string;
};

/** The variables of VS Code's window title. Kingu has no profiles or remotes: those are always empty. */
export function titleVariables(ctx: TitleContext): Record<string, string | Separator> {
	const e = ctx.editor;
	const dir = (path: string | undefined) => (path && path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
	const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
	const activeFolderLong = dir(e?.long);
	return {
		dirty: e && ctx.dirty ? DIRTY_MARK : '',
		activeEditorShort: e?.short ?? '',
		activeEditorMedium: e ? (e.medium ?? e.short) : '',
		activeEditorLong: e ? (e.long ?? e.medium ?? e.short) : '',
		activeEditorLanguageId: e ? (ctx.languageId ?? '') : '',
		activeEditorState: e && ctx.dirty ? 'Modified' : '',
		activeFolderShort: activeFolderLong ? base(activeFolderLong) : '',
		activeFolderMedium: dir(e?.medium),
		activeFolderLong,
		rootName: ctx.rootName ?? '',
		rootNameShort: ctx.rootName ?? '',
		rootPath: ctx.rootPath ?? '',
		folderName: ctx.rootName ?? '',
		folderPath: ctx.rootPath ?? '',
		activeRepositoryName: ctx.branch && ctx.rootName ? ctx.rootName : '',
		activeRepositoryBranchName: ctx.branch ?? '',
		appName: ctx.app ?? APP_NAME,
		profileName: '',
		remoteName: '',
		focusedView: ctx.focusedView ?? '',
		separator: { label: ctx.separator ?? TITLE_SEPARATOR }
	};
}

/** The window title from a `window.title` template; an empty result falls back to the app name, like VS Code. */
export function renderWindowTitle(tpl: string, ctx: TitleContext): string {
	return template(tpl, titleVariables(ctx)).trim() || (ctx.app ?? APP_NAME);
}

/** The Windows/Linux default title: `● file.ts — folder — Kingu`. */
export function windowTitle({ editor, folder, dirty = false, app = APP_NAME }: { editor?: string | null; folder?: string | null; dirty?: boolean; app?: string }): string {
	return renderWindowTitle(DEFAULT_TITLE_OTHER, { editor: editor ? { short: editor } : null, rootName: folder, dirty, app });
}
