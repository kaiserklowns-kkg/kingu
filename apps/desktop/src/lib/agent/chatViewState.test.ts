import { describe, expect, test } from 'bun:test';
import { newChatRuntime, parseShown, restoredChat, withShown } from './chatViewState.ts';

describe('chat view state', () => {
	test('the shown chats parse loosely', () => {
		expect(parseShown(JSON.stringify({ '/a': 'c1', '/b': '', '/c': 3, '': 'x' }))).toEqual({ '/a': 'c1', '/b': '' });
		expect(parseShown('nope')).toEqual({});
		expect(parseShown('[1]')).toEqual({});
		expect(parseShown(null)).toEqual({});
	});

	test('a folder showing a chat is the most recent; the oldest go past 100', () => {
		let s = withShown({}, '/a', 'c1');
		s = withShown(s, '/b', '');
		s = withShown(s, '/a', 'c2');
		expect(Object.entries(s)).toEqual([
			['/b', ''],
			['/a', 'c2']
		]);
		for (let i = 0; i < 105; i++) s = withShown(s, `/f${i}`, 'x');
		expect(Object.keys(s).length).toBe(100);
		expect(s['/a']).toBeUndefined();
		expect(s['/f104']).toBe('x');
	});

	test('a reloaded window shows the chat it showed; a restart only with chat.restoreLastPanelSession', () => {
		const exists = (id: string) => id === 'c1';
		expect(restoredChat('c1', { reloaded: true, restoreSetting: false, exists })).toBe('c1');
		expect(restoredChat('c1', { reloaded: false, restoreSetting: undefined, exists })).toBeNull();
		expect(restoredChat('c1', { reloaded: false, restoreSetting: true, exists })).toBe('c1');
		// A chat that is gone, a new chat, or nothing saved: a new chat.
		expect(restoredChat('gone', { reloaded: true, restoreSetting: true, exists })).toBeNull();
		expect(restoredChat('', { reloaded: true, restoreSetting: true, exists })).toBeNull();
		expect(restoredChat(undefined, { reloaded: true, restoreSetting: true, exists })).toBeNull();
	});

	test('a new chat starts on the pick, else the remembered agent while usable, else the default', () => {
		const usable = ['claude', 'arkai', 'codex'];
		expect(newChatRuntime('claude', 'codex', usable, 'arkai')).toBe('claude');
		expect(newChatRuntime(null, 'codex', usable, 'arkai')).toBe('codex');
		expect(newChatRuntime(null, 'opencode', usable, 'arkai')).toBe('arkai');
		expect(newChatRuntime(null, null, usable, 'arkai')).toBe('arkai');
	});
});
