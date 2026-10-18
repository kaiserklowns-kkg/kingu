// Orca's chat appearance (nativeChatAppearance) as `kingu.chat.*` for the agent timeline (the
// structured chat of timeline-mode tasks and the Agent panel). Pure, so `bun test` covers it.

export type ChatWidth = 'comfortable' | 'wide' | 'full';
/** Orca: comfortable is 46rem; wide and full give the transcript more room. */
export const CHAT_MAX_WIDTH: Record<ChatWidth, string | undefined> = { comfortable: '46rem', wide: '64rem', full: undefined };

export type ChatLook = { fontSize: number; codeFontSize: number; maxWidth: string | undefined; contrast: number; fontFamily: string | undefined };

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function chatLook(get: (id: string) => unknown): ChatLook {
	const width = get('kingu.chat.width');
	const terminalFont = typeof get('terminal.integrated.fontFamily') === 'string' ? (get('terminal.integrated.fontFamily') as string).trim() : '';
	return {
		fontSize: clamp(get('kingu.chat.fontSize'), 12, 20, 14),
		codeFontSize: clamp(get('kingu.chat.codeFontSize'), 10, 18, 12),
		maxWidth: CHAT_MAX_WIDTH[(width === 'wide' || width === 'full' ? width : 'comfortable') as ChatWidth],
		contrast: clamp(get('kingu.chat.contrast'), 50, 150, 100),
		fontFamily: get('kingu.chat.matchTerminalFont') === true && terminalFont ? terminalFont : undefined
	};
}
