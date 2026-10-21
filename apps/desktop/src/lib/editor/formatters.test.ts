/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { BUILTIN_FORMATTER, chooseFormatter, formatterCandidates, formatterSettingValue, matchesFormatterId } from './formatters';

const builtin = {};
const tsServer = { displayName: 'TypeScript language server' };
const eslint = { displayName: 'ESLint' };
const rust = { displayName: 'rust-analyzer' };

describe('default formatter', () => {
	test('the built-in formatter steps aside for a language server; names are deduplicated', () => {
		expect(formatterCandidates([builtin, tsServer])).toEqual([tsServer]);
		expect(formatterCandidates([builtin])).toEqual([builtin]);
		expect(formatterCandidates([tsServer, { displayName: 'TypeScript language server' }])).toEqual([tsServer]);
	});

	test('ids: a server name, or the VS Code extension it stands in for', () => {
		expect(matchesFormatterId(tsServer, 'vscode.typescript-language-features')).toBe(true);
		expect(matchesFormatterId(builtin, 'vscode.json-language-features')).toBe(true);
		expect(matchesFormatterId(rust, 'RUST-ANALYZER')).toBe(true);
		expect(matchesFormatterId(rust, 'rust-lang.rust-analyzer')).toBe(true);
		expect(matchesFormatterId(eslint, 'vscode.typescript-language-features')).toBe(false);
	});

	test('what Configure Default Formatter writes', () => {
		expect(formatterSettingValue(tsServer, 'typescript')).toBe('vscode.typescript-language-features');
		expect(formatterSettingValue(builtin, 'json')).toBe('vscode.json-language-features');
		expect(formatterSettingValue(builtin, 'typescript')).toBe('vscode.typescript-language-features');
		expect(formatterSettingValue(rust, 'rust')).toBe('rust-lang.rust-analyzer');
		expect(formatterSettingValue(eslint, 'typescript')).toBe('ESLint');
		expect(formatterSettingValue({}, 'x')).toBe('vscode.typescript-language-features');
		expect(BUILTIN_FORMATTER).toBe('Kingu (built-in)');
	});

	test("VS Code's choice: the configured one, the only one, or a problem", () => {
		expect(chooseFormatter([builtin, tsServer], null)).toEqual({ formatter: tsServer });
		expect(chooseFormatter([tsServer, eslint], null)).toEqual({ problem: 'multiple' });
		expect(chooseFormatter([tsServer, eslint], 'ESLint')).toEqual({ formatter: eslint });
		expect(chooseFormatter([tsServer, eslint], 'vscode.typescript-language-features')).toEqual({ formatter: tsServer });
		// The built-in one, set aside while a server formats, can still be chosen by name.
		expect(chooseFormatter([builtin, tsServer], BUILTIN_FORMATTER)).toEqual({ formatter: builtin });
		// A Kingu formatter that cannot format this document formats nothing, like VS Code.
		expect(chooseFormatter([tsServer], 'rust-analyzer')).toEqual({ problem: 'unavailable' });
		// An extension Kingu does not have counts as unset.
		expect(chooseFormatter([tsServer], 'esbenp.prettier-vscode')).toEqual({ formatter: tsServer });
		expect(chooseFormatter([tsServer, eslint], 'esbenp.prettier-vscode')).toEqual({ problem: 'multiple' });
	});
});
