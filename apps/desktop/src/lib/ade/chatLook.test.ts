import { describe, expect, test } from 'bun:test';
import { resolveSettings } from '#lib/settings/registry.ts';
import { chatLook } from './chatLook';

const look = (user: Record<string, unknown>) => {
	const m = resolveSettings(user, {});
	return chatLook((id) => m.get(id)?.value);
};

describe('chat appearance (Orca nativeChatAppearance)', () => {
	test("Orca's defaults", () => {
		expect(look({})).toMatchObject({ fontSize: 14, codeFontSize: 12, maxWidth: '46rem', contrast: 100, fontFamily: undefined, codeLineHeight: undefined, codeWrap: false });
	});
	test("VS Code's chat fonts: chat.fontFamily over the terminal font, chat.editor.* over the editor's", () => {
		const editorFont = resolveSettings({}, {}).get('editor.fontFamily')?.value;
		expect(look({}).codeFontFamily).toBe(editorFont as string);
		expect(look({}).codeFontWeight).toBe('normal');
		expect(look({ 'chat.fontFamily': 'Inter', 'kingu.chat.matchTerminalFont': true, 'terminal.integrated.fontFamily': 'JetBrains Mono' }).fontFamily).toBe('Inter');
		expect(look({ 'chat.fontFamily': 'default', 'kingu.chat.matchTerminalFont': true, 'terminal.integrated.fontFamily': 'JetBrains Mono' }).fontFamily).toBe('JetBrains Mono');
		expect(look({ 'editor.fontFamily': 'Menlo', 'editor.fontWeight': 'bold' })).toMatchObject({ codeFontFamily: 'Menlo', codeFontWeight: 'bold' });
		expect(look({ 'chat.editor.fontFamily': 'Fira Code', 'chat.editor.fontWeight': '300', 'chat.editor.lineHeight': 20, 'chat.editor.wordWrap': 'on' })).toMatchObject({
			codeFontFamily: 'Fira Code',
			codeFontWeight: '300',
			codeLineHeight: 20,
			codeWrap: true
		});
	});
	test('settings apply, bad values fall back', () => {
		expect(look({ 'kingu.chat.fontSize': 18, 'kingu.chat.width': 'full', 'kingu.chat.contrast': 120 })).toMatchObject({ fontSize: 18, maxWidth: undefined, contrast: 120 });
		expect(look({ 'kingu.chat.fontSize': 40, 'kingu.chat.width': 'huge' })).toMatchObject({ fontSize: 14, maxWidth: '46rem' });
		expect(look({ 'kingu.chat.matchTerminalFont': true, 'terminal.integrated.fontFamily': 'JetBrains Mono' }).fontFamily).toBe('JetBrains Mono');
	});
});
