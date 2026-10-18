/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { evaluateWhen, parseWhen } from './contextKey';
import { userKeybindings, whenKey } from './keybindingsModel';

const ctx = {
	editorTextFocus: true,
	editorHasSelection: false,
	terminalFocus: false,
	inQuickOpen: false,
	editorLangId: 'typescript',
	resourceExtname: '.ts',
	activeViewlet: 'workbench.view.explorer',
	count: 3,
	langs: ['typescript', 'rust']
};

describe('when clauses (VS Code contextkey)', () => {
	test('keys, negation, and/or with VS Code precedence', () => {
		expect(evaluateWhen('editorTextFocus', ctx)).toBe(true);
		expect(evaluateWhen('!editorTextFocus', ctx)).toBe(false);
		expect(evaluateWhen('editorTextFocus && !editorHasSelection', ctx)).toBe(true);
		expect(evaluateWhen('terminalFocus || editorTextFocus && editorHasSelection', ctx)).toBe(false);
		expect(evaluateWhen('terminalFocus || editorTextFocus && !inQuickOpen', ctx)).toBe(true);
		expect(evaluateWhen('(terminalFocus || editorTextFocus) && !editorHasSelection', ctx)).toBe(true);
		expect(evaluateWhen('missingKey', ctx)).toBe(false);
		expect(evaluateWhen('true', ctx)).toBe(true);
		expect(evaluateWhen('', ctx)).toBe(true);
		expect(evaluateWhen(undefined, ctx)).toBe(true);
	});

	test('comparisons, regex, in', () => {
		expect(evaluateWhen("editorLangId == 'typescript'", ctx)).toBe(true);
		expect(evaluateWhen('editorLangId == typescript', ctx)).toBe(true);
		expect(evaluateWhen('editorLangId != rust', ctx)).toBe(true);
		expect(evaluateWhen('editorLangId === rust', ctx)).toBe(false);
		expect(evaluateWhen('resourceExtname =~ /\\.(ts|js)$/', ctx)).toBe(true);
		expect(evaluateWhen('activeViewlet =~ /SCM/i', ctx)).toBe(false);
		expect(evaluateWhen('count > 2 && count <= 3', ctx)).toBe(true);
		expect(evaluateWhen('count >= 4', ctx)).toBe(false);
		expect(evaluateWhen('editorLangId in langs', ctx)).toBe(true);
		expect(evaluateWhen('editorLangId not in langs', ctx)).toBe(false);
		expect(evaluateWhen('editorTextFocus == true', ctx)).toBe(true);
	});

	test('a clause that does not parse never matches', () => {
		expect(() => parseWhen('editorTextFocus &&')).toThrow();
		expect(() => parseWhen('(a')).toThrow();
		expect(evaluateWhen('editorTextFocus &&', ctx)).toBe(false);
		expect(evaluateWhen('a =~ b', ctx)).toBe(false);
	});

	test('keybindings.json keeps each user key with its when', () => {
		const user = userKeybindings([
			{ key: 'cmd+/', command: 'editor.action.commentLine', when: 'editorTextFocus && !editorReadonly' },
			{ key: 'cmd+k cmd+c', command: 'editor.action.commentLine' },
			{ key: 'cmd+e', command: 'x', when: 'terminalFocus' },
			{ key: 'cmd+e', command: 'x' }
		]);
		expect(user.when.get(whenKey('editor.action.commentLine', 'cmd+/'))).toBe('editorTextFocus && !editorReadonly');
		expect(user.when.has(whenKey('editor.action.commentLine', 'cmd+k  cmd+c'))).toBe(false);
		// A later entry for the same key replaces the earlier one, its when included.
		expect(user.when.has(whenKey('x', 'cmd+e'))).toBe(false);
	});
});
