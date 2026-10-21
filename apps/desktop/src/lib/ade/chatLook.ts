// Orca's chat appearance (nativeChatAppearance) as `kingu.chat.*` for the agent timeline (the
// structured chat of timeline-mode tasks and the Agent panel), with VS Code's chat fonts:
// `chat.fontFamily` (over kingu.chat.matchTerminalFont when it names a font) and `chat.editor.*`
// for code blocks (`default`: the editor's). Pure, so `bun test` covers it.

export type ChatWidth = 'comfortable' | 'wide' | 'full';
/** Orca: comfortable is 46rem; wide and full give the transcript more room. */
export const CHAT_MAX_WIDTH: Record<ChatWidth, string | undefined> = { comfortable: '46rem', wide: '64rem', full: undefined };

export type ChatLook = {
	fontSize: number;
	codeFontSize: number;
	maxWidth: string | undefined;
	contrast: number;
	fontFamily: string | undefined;
	/** chat.editor.fontFamily, else editor.fontFamily. */
	codeFontFamily: string | undefined;
	/** chat.editor.fontWeight, else editor.fontWeight. */
	codeFontWeight: string | undefined;
	/** chat.editor.lineHeight in pixels; undefined (0) computes it from the font size. */
	codeLineHeight: number | undefined;
	/** chat.editor.wordWrap is on. */
	codeWrap: boolean;
};

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
/** A font setting's value (editor.fontWeight may be a number), or '' when it is unset or `default`. */
const named = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' && v.trim() !== 'default' ? v.trim() : '');

export function chatLook(get: (id: string) => unknown): ChatLook {
	const width = get('kingu.chat.width');
	const terminalFont = typeof get('terminal.integrated.fontFamily') === 'string' ? (get('terminal.integrated.fontFamily') as string).trim() : '';
	const lineHeight = get('chat.editor.lineHeight');
	return {
		fontSize: clamp(get('kingu.chat.fontSize'), 12, 20, 14),
		codeFontSize: clamp(get('kingu.chat.codeFontSize'), 10, 18, 12),
		maxWidth: CHAT_MAX_WIDTH[(width === 'wide' || width === 'full' ? width : 'comfortable') as ChatWidth],
		contrast: clamp(get('kingu.chat.contrast'), 50, 150, 100),
		fontFamily: named(get('chat.fontFamily')) || (get('kingu.chat.matchTerminalFont') === true && terminalFont ? terminalFont : undefined),
		codeFontFamily: named(get('chat.editor.fontFamily')) || named(get('editor.fontFamily')) || undefined,
		codeFontWeight: named(get('chat.editor.fontWeight')) || named(get('editor.fontWeight')) || undefined,
		codeLineHeight: typeof lineHeight === 'number' && Number.isFinite(lineHeight) && lineHeight > 0 ? Math.min(lineHeight, 150) : undefined,
		codeWrap: get('chat.editor.wordWrap') === 'on'
	};
}
