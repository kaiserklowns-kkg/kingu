/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import { buildTurns } from './chatParts';
import { guardBlockedText } from './guardText';
import { initialRun, applyEvent, type AgentEvent } from './events';

beforeAll(() => setLocale('en'));
afterAll(() => setLocale('en'));

describe('safety check text', () => {
	test('known threats in the UI language, else goose’s description; repetition', () => {
		expect(guardBlockedText({ check: 'security', threats: ['rm_rf_root_bare'], detail: 'Recursive deletion of root filesystem' })).toBe(
			'Blocked by Kingu safety check: deleting the whole filesystem'
		);
		expect(guardBlockedText({ check: 'security', threats: ['some_new_pattern'], detail: 'Something new' })).toBe('Blocked by Kingu safety check: Something new');
		expect(guardBlockedText({ check: 'repetition', threats: [], detail: '' })).toBe('Blocked by Kingu safety check: the same tool call a third time in a row');
		setLocale('th');
		expect(guardBlockedText({ check: 'security', threats: ['curl_bash_execution'], detail: '' })).toBe('ถูกบล็อกโดยการตรวจความปลอดภัยของ Kingu: รันสคริปต์ที่ดาวน์โหลดมาใน shell');
		setLocale('en');
	});

	test('the chat shows a block in the response', () => {
		const s = initialRun();
		const evs: AgentEvent[] = [
			{ kind: 'message', role: 'user', text: 'clean up' },
			{ kind: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'rm -rf /' } },
			{ kind: 'guard_blocked', tool: 'Bash', tool_use_id: 'tu1', check: 'security', threats: ['rm_rf_root_bare'], detail: '' }
		];
		for (const ev of evs) applyEvent(s, ev);
		const parts = buildTurns(s)[0]?.parts ?? [];
		expect(parts.some((p) => p.kind === 'error' && p.message.startsWith('Blocked by Kingu safety check'))).toBe(true);
	});
});
