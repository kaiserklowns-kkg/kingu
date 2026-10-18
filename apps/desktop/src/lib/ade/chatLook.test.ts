import { describe, expect, test } from 'bun:test';
import { resolveSettings } from '#lib/settings/registry.ts';
import { chatLook } from './chatLook';

const look = (user: Record<string, unknown>) => {
	const m = resolveSettings(user, {});
	return chatLook((id) => m.get(id)?.value);
};

describe('chat appearance (Orca nativeChatAppearance)', () => {
	test("Orca's defaults", () => {
		expect(look({})).toEqual({ fontSize: 14, codeFontSize: 12, maxWidth: '46rem', contrast: 100, fontFamily: undefined });
	});
	test('settings apply, bad values fall back', () => {
		expect(look({ 'kingu.chat.fontSize': 18, 'kingu.chat.width': 'full', 'kingu.chat.contrast': 120 })).toMatchObject({ fontSize: 18, maxWidth: undefined, contrast: 120 });
		expect(look({ 'kingu.chat.fontSize': 40, 'kingu.chat.width': 'huge' })).toMatchObject({ fontSize: 14, maxWidth: '46rem' });
		expect(look({ 'kingu.chat.matchTerminalFont': true, 'terminal.integrated.fontFamily': 'JetBrains Mono' }).fontFamily).toBe('JetBrains Mono');
	});
});
