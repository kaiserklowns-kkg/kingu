// Window title (VS Code's `window.title` default:
// `${dirty}${activeEditorShort}${separator}${rootName}${separator}${appName}`).

export const APP_NAME = 'Kingu';
export const TITLE_SEPARATOR = ' — ';
/** VS Code's `${dirty}`: shown before the editor name while it has unsaved changes. */
export const DIRTY_MARK = '● ';

export function windowTitle({ editor, folder, dirty = false, app = APP_NAME }: { editor?: string | null; folder?: string | null; dirty?: boolean; app?: string }): string {
	return [editor ? `${dirty ? DIRTY_MARK : ''}${editor}` : '', folder ?? '', app].filter(Boolean).join(TITLE_SEPARATOR);
}
