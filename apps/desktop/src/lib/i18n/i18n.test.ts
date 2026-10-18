import { afterEach, describe, expect, test } from 'bun:test';
import { en } from './en';
import { th } from './th';
import { formatMessage, paramNames, resolveUiLanguage } from './format';
import { isMessageKey, locale, setLocale, t, tIn } from './index';

describe('UI catalogs', () => {
	test('Thai and English have the same keys', () => {
		expect(Object.keys(th).sort()).toEqual(Object.keys(en).sort());
	});

	test('every message is non-empty and uses the same {params} in both languages', () => {
		for (const [key, message] of Object.entries(en)) {
			const thai = (th as Record<string, string>)[key];
			expect([key, message.trim().length > 0, (thai ?? '').trim().length > 0]).toEqual([key, true, true]);
			expect([key, paramNames(thai).sort()]).toEqual([key, paramNames(message).sort()]);
		}
	});

	test('keys are area.dotted.names and plural forms are well-formed', () => {
		for (const [key, message] of [...Object.entries(en), ...Object.entries(th)]) {
			expect([key, /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/.test(key)]).toEqual([key, true]);
			for (const m of message.matchAll(/\{[^}]*\}/g)) expect([key, m[0], /^\{[A-Za-z_][A-Za-z0-9_]*(\|[^|}]*){0,2}\}$/.test(m[0])]).toEqual([key, m[0], true]);
		}
	});

	test('Thai messages use no polite particles (ครับ / ค่ะ)', () => {
		for (const [key, message] of Object.entries(th)) {
			expect([key, /(ครับ|ค่ะ|คะ)(\s|$)/.test(message)]).toEqual([key, false]);
		}
	});
});

describe('t()', () => {
	afterEach(() => setLocale('en'));

	test('formats params and plurals', () => {
		expect(formatMessage('{n|# file|# files} in {dir}', { n: 1, dir: 'src' })).toBe('1 file in src');
		expect(formatMessage('{n|# file|# files}', { n: 3 })).toBe('3 files');
		expect(formatMessage('{n} ไฟล์', { n: 3 })).toBe('3 ไฟล์');
		expect(formatMessage('missing {x}', {})).toBe('missing {x}');
		expect(paramNames('{a} {b|x|y} {a}')).toEqual(['a', 'b']);
	});

	test('follows the locale', () => {
		setLocale('th');
		expect(locale()).toBe('th');
		expect(t('common.cancel')).toBe('ยกเลิก');
		setLocale('en');
		expect(t('common.cancel')).toBe('Cancel');
		expect(tIn('th', 'common.cancel')).toBe('ยกเลิก');
		expect(isMessageKey('common.cancel')).toBe(true);
		expect(isMessageKey('nope')).toBe(false);
	});

	test('kingu.uiLanguage: auto follows the OS language', () => {
		expect(resolveUiLanguage('auto', 'th-TH')).toBe('th');
		expect(resolveUiLanguage('auto', 'TH')).toBe('th');
		expect(resolveUiLanguage('auto', 'en-US')).toBe('en');
		expect(resolveUiLanguage('auto', 'ja')).toBe('en');
		expect(resolveUiLanguage('auto', null)).toBe('en');
		expect(resolveUiLanguage('th', 'en-US')).toBe('th');
		expect(resolveUiLanguage('en', 'th-TH')).toBe('en');
		expect(resolveUiLanguage('fr', 'th-TH')).toBe('th');
	});
});
