/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { AutoReplies, linkSchemeAllowed, Osc99, pasteNeedsWarning, rightClickAction, showTabsList, terminalStartsChord, workbenchTakesKey, zoomedFontSize } from './behaviour';
import { confirmsOnExit } from './closeGuard';
import { hideOnStartup } from './sessions';

describe('terminal settings behaviour', () => {
	test('rightClickBehavior', () => {
		expect(rightClickAction('selectWord', false)).toBe('menu');
		expect(rightClickAction('default', true)).toBe('menu');
		expect(rightClickAction('copyPaste', true)).toBe('copy');
		expect(rightClickAction('copyPaste', false)).toBe('paste');
		expect(rightClickAction('paste', true)).toBe('paste');
		expect(rightClickAction('nothing', true)).toBe('none');
	});

	test('enableMultiLinePasteWarning', () => {
		expect(pasteNeedsWarning('auto', 'a\nb', false)).toBe(true);
		expect(pasteNeedsWarning('auto', 'a\nb', true)).toBe(false);
		expect(pasteNeedsWarning('always', 'a\r\nb', true)).toBe(true);
		expect(pasteNeedsWarning('never', 'a\nb', false)).toBe(false);
		// One line with a trailing newline is not multi-line.
		expect(pasteNeedsWarning('always', 'ls\n', false)).toBe(false);
	});

	test('allowedLinkSchemes', () => {
		const schemes = ['file', 'http', 'https', 'mailto'];
		expect(linkSchemeAllowed('https://x.dev', schemes)).toBe(true);
		expect(linkSchemeAllowed('MAILTO:a@b.c', schemes)).toBe(true);
		expect(linkSchemeAllowed('ftp://x', schemes)).toBe(false);
		expect(linkSchemeAllowed('no scheme', schemes)).toBe(false);
	});

	test('autoReplies match across chunks and wait a second between replies', () => {
		const r = new AutoReplies({ 'Terminate batch job (Y/N)': 'Y\r', off: null });
		expect(r.feed('...Terminate batch ', 0)).toEqual([]);
		expect(r.feed('job (Y/N)? ', 10)).toEqual(['Y\r']);
		expect(r.feed('Terminate batch job (Y/N)', 500)).toEqual([]);
		expect(r.feed('Terminate batch job (Y/N)', 1500)).toEqual(['Y\r']);
		expect(new AutoReplies({ off: null }).empty).toBe(true);
		// A mismatch that starts the message again still matches.
		expect(new AutoReplies({ ab: 'x' }).feed('aab', 0)).toEqual(['x']);
	});

	test('OSC 99 notifications', () => {
		const n = new Osc99();
		expect(n.handle(';Build done')).toEqual({ title: 'Build done', body: '' });
		expect(n.handle('i=1:d=0;Tests')).toBeNull();
		expect(n.handle('i=1:p=body;42 passed')).toEqual({ title: 'Tests', body: '42 passed' });
		expect(n.handle(`e=1;${btoa('hi')}`)).toEqual({ title: 'hi', body: '' });
		expect(n.handle('p=icon;x')).toBeNull();
		expect(n.handle('no payload')).toBeNull();
	});

	test('tabs list visibility', () => {
		expect(showTabsList(true, 'singleTerminal', 1, 1)).toBe(false);
		expect(showTabsList(true, 'singleTerminal', 2, 1)).toBe(true);
		expect(showTabsList(true, 'singleGroup', 2, 1)).toBe(false);
		expect(showTabsList(true, 'singleGroup', 2, 2)).toBe(true);
		expect(showTabsList(true, 'never', 1, 1)).toBe(true);
		expect(showTabsList(false, 'never', 3, 3)).toBe(false);
	});

	test('mouseWheelZoom', () => {
		expect(zoomedFontSize(12, -3)).toBe(13);
		expect(zoomedFontSize(12, 3)).toBe(11);
		expect(zoomedFontSize(6, 3)).toBe(6);
		expect(zoomedFontSize(100, -3)).toBe(100);
	});

	test('keys in a focused terminal: sendKeybindingsToShell, commandsToSkipShell, allowChords', () => {
		expect(workbenchTakesKey('workbench.action.terminal.new', false, false, [])).toBe(true);
		expect(workbenchTakesKey('workbench.action.quickOpen', false, false, ['-workbench.action.quickOpen'])).toBe(false);
		expect(workbenchTakesKey('workbench.action.quickOpen', false, true, [])).toBe(false);
		expect(workbenchTakesKey('workbench.action.quickOpen', true, true, [])).toBe(true);
		expect(terminalStartsChord(true, 'k')).toBe(true);
		expect(terminalStartsChord(false, 'k')).toBe(false);
		expect(terminalStartsChord(true, 'Escape')).toBe(false);
	});

	test('confirmOnExit and hideOnStartup', () => {
		expect(confirmsOnExit('never', 3, 3)).toBe(false);
		expect(confirmsOnExit('always', 1, 0)).toBe(true);
		expect(confirmsOnExit('always', 0, 0)).toBe(false);
		expect(confirmsOnExit('hasChildProcesses', 2, 0)).toBe(false);
		expect(confirmsOnExit('hasChildProcesses', 2, 1)).toBe(true);
		expect(hideOnStartup('never', false)).toBe(false);
		expect(hideOnStartup('whenEmpty', false)).toBe(true);
		expect(hideOnStartup('whenEmpty', true)).toBe(false);
		expect(hideOnStartup('always', true)).toBe(true);
	});
});
