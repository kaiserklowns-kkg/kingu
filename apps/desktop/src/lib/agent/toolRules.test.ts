/// <reference types="bun" />
// The chat side of VS Code's tool approval rules (the rules are Rust's, agent/tool_rules): the
// "Always allow" button's text and the setting value it writes, the "Auto approved by rule" line,
// the edit-rule safety ask's reason, and `tool_auto_approved` reaching its tool row.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import { approvedByText, suggestionLabel, TERMINAL_RULES, URL_RULES, usableSuggestion, withRule } from './toolRules';
import { guardAskedText } from './guardText';
import { buildTurns, type ToolPart } from './chatParts';
import { applyEvent, initialRun, type AgentEvent } from './events';

beforeAll(() => setLocale('en'));
afterAll(() => setLocale('en'));

describe('Always allow', () => {
	test('only the two rule settings, with real keys', () => {
		expect(usableSuggestion({ setting: TERMINAL_RULES, keys: ['npm test'] })).toEqual({ setting: TERMINAL_RULES, keys: ['npm test'] });
		expect(usableSuggestion({ setting: URL_RULES, keys: ['https://docs.rs'] })).not.toBeNull();
		expect(usableSuggestion({ setting: 'terminal.integrated.shell.osx', keys: ['/bin/evil'] })).toBeNull();
		expect(usableSuggestion({ setting: TERMINAL_RULES, keys: [] })).toBeNull();
		expect(usableSuggestion({ setting: TERMINAL_RULES, keys: [' '] })).toBeNull();
		expect(usableSuggestion(null)).toBeNull();
		expect(usableSuggestion(undefined)).toBeNull();
	});

	test('labels', () => {
		expect(suggestionLabel({ setting: TERMINAL_RULES, keys: ['npm test'] }).label).toBe('Always allow `npm test …`');
		expect(suggestionLabel({ setting: TERMINAL_RULES, keys: ['make', 'cargo test'] }).label).toBe('Always allow `make …`, `cargo test …`');
		expect(suggestionLabel({ setting: TERMINAL_RULES, keys: ['make'] }).hint).toContain('chat.tools.terminal.autoApprove');
		const domain = suggestionLabel({ setting: URL_RULES, keys: ['https://docs.rs'] });
		expect(domain.label).toBe('Always allow docs.rs');
		expect(domain.hint).toContain('`https://docs.rs`');
	});

	test('the new user value keeps the other rules', () => {
		expect(withRule(undefined, { setting: TERMINAL_RULES, keys: ['make'] })).toEqual({ make: true });
		expect(withRule({ rm: false, '/x/': { approve: true, matchCommandLine: true } }, { setting: TERMINAL_RULES, keys: ['make', 'cargo test'] })).toEqual({
			rm: false,
			'/x/': { approve: true, matchCommandLine: true },
			make: true,
			'cargo test': true
		});
		// A key the user had set to false: they chose to allow it now.
		expect(withRule({ make: false }, { setting: TERMINAL_RULES, keys: ['make'] })).toEqual({ make: true });
		expect(withRule(['not', 'an object'], { setting: URL_RULES, keys: ['https://a.dev'] })).toEqual({ 'https://a.dev': true });
		const before = { a: true };
		withRule(before, { setting: TERMINAL_RULES, keys: ['b'] });
		expect(before).toEqual({ a: true });
	});
});

describe('auto-approved calls', () => {
	test('the line under a row', () => {
		expect(approvedByText(undefined)).toBe('');
		expect(approvedByText([])).toBe('');
		expect(approvedByText(['ls'])).toBe('Auto approved by rule `ls`');
		expect(approvedByText(['ls', 'wc'])).toBe('Auto approved by rules `ls`, `wc`');
	});

	test('tool_auto_approved reaches its row, before or after the tool_use', () => {
		const s = initialRun();
		const events: AgentEvent[] = [
			{ kind: 'message', role: 'user', text: 'go' },
			{ kind: 'tool_auto_approved', request_id: 'r0', tool: 'Bash', tool_use_id: 'early', rules: ['pwd'] },
			{ kind: 'tool_use', id: 'early', name: 'Bash', input: { command: 'pwd' } },
			{ kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
			{ kind: 'tool_auto_approved', request_id: 'r1', tool: 'Bash', tool_use_id: 't1', rules: ['ls'] },
			{ kind: 'permission_resolved', request_id: 'r1', decision: 'allow' },
			{ kind: 'tool_use', id: 't2', name: 'Bash', input: { command: 'make' } }
		];
		for (const ev of events) applyEvent(s, ev);
		// Nothing waits for the user: the prompt never reached the page.
		expect(s.pending).toEqual([]);
		expect(s.status).not.toBe('waiting');
		const tools = buildTurns(s)[0]!.parts.filter((p): p is ToolPart => p.kind === 'tool');
		expect(tools.map((p) => p.autoApproved)).toEqual([['pwd'], ['ls'], undefined]);
		expect(buildTurns(s)[0]!.parts.some((p) => p.kind === 'confirmation')).toBe(false);
	});

	test('the edit-rule safety ask says why', () => {
		expect(guardAskedText({ check: 'edit_rule', paths: ['package.json'] })).toBe('Kingu asks first: it edits a file you approve edits to (chat.tools.edits.autoApprove) (package.json)');
	});
});
