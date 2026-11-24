import { describe, expect, test } from 'bun:test';
import { en } from '#lib/i18n/en.ts';
import { th } from '#lib/i18n/th.ts';
import { sessionName } from '#lib/workbench/agentBrowser.ts';
import { relayGrantAnswer, relayGrantPrompt, RELAY_GRANT_ANSWERS } from './sshBrowserRelay';

const tr = (key: string, vars: Record<string, string | number> = {}) =>
	String((en as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));

describe('the grant an SSH host agent asks for', () => {
	test('opening says which host and address, with Allow Once, Allow for This Run and Deny', () => {
		const p = relayGrantPrompt({ host: 'box', url: 'https://a.dev/', kind: 'open', run: 'abcdef12' }, tr);
		expect(p.title).toBe('Open Browser Page for an SSH Agent?');
		expect(p.message).toContain('box');
		expect(p.message).toContain('https://a.dev/');
		expect(p.message).toContain('your computer');
		expect(p.buttons).toEqual(['Allow Once', 'Allow for This Run', 'Deny']);
		expect(relayGrantPrompt({ host: 'box', url: 'https://b.dev/', kind: 'navigate' }, tr).title).toBe('Navigate Browser for an SSH Agent?');
	});

	test('the pressed button is the answer; Escape and anything else decline', () => {
		expect(RELAY_GRANT_ANSWERS.map((_, i) => relayGrantAnswer(i))).toEqual(['once', 'run', 'deny']);
		expect(relayGrantAnswer(null)).toBe('deny');
		expect(relayGrantAnswer(7)).toBe('deny');
	});

	test('the log and indicator name a run by its host', () => {
		expect(sessionName('ssh:box:abcdef123456abcdef123456')).toBe('box run abcdef12');
		expect(sessionName('chat:/r:c1')).toBe('chat c1');
	});

	test('Thai has every string', () => {
		for (const k of Object.keys(en).filter((k) => k.startsWith('agentBrowser.ssh.'))) expect((th as Record<string, string>)[k]?.length).toBeGreaterThan(0);
	});
});
