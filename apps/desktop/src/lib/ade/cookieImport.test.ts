import { describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import { cookieImportFailureText, cookieImportMessages, cookiePickRows, cookiePickSource, type CookieImportSummary, type CookieSource } from './cookieImport';

const base: CookieImportSummary = { total: 10, imported: 8, skipped: 0, googleSkipped: 0, partitionSkipped: 0, undecryptable: 0, replaced: 0, domains: 3 };

describe("Orca's cookie import messages", () => {
	setLocale('en');

	test('refusals name the browser, profile or count', () => {
		expect(cookieImportFailureText({ code: 'databaseCopyFailed', browser: 'Google Chrome' })).toBe('Could not copy Google Chrome cookies database. Try closing Google Chrome first.');
		expect(cookieImportFailureText({ code: 'browserProfileDatabaseMissing', profile: 'Profile 2' })).toBe('No cookies database found for profile "Profile 2".');
		expect(cookieImportFailureText({ code: 'fileNoValidCookies', count: 1 })).toBe('No valid cookies found. 1 entry was skipped due to missing or invalid fields.');
		expect(cookieImportFailureText({ code: 'somethingNew', detail: 'x' })).toBe('Could not import cookies: x');
		expect(cookieImportFailureText('boom')).toBe('Could not import cookies: boom');
	});

	test('a clean import is a success; skipped Google cookies add the sign-in warning', () => {
		expect(cookieImportMessages(base, 'Imported 8 cookies from file.')).toEqual({ info: 'Imported 8 cookies from file.', warnings: [] });
		const m = cookieImportMessages({ ...base, skipped: 2, googleSkipped: 4 }, 'Done.');
		expect(m.info).toBe('Done. 2 cookies skipped.');
		expect(m.warnings).toEqual(['Google cookies were not imported. Open a browser in Kingu with this profile, then sign into Google.']);
	});

	test('undecryptable cookies replace the success message with a warning', () => {
		const m = cookieImportMessages({ ...base, undecryptable: 5, partitionSkipped: 1 }, 'Done.');
		expect(m.info).toBeUndefined();
		expect(m.warnings[0]).toContain('5 cookies could not be decrypted');
		expect(m.warnings[1]).toContain('1 cookies were not imported');
	});
});

describe("Orca's Import Cookies picker (4a4cbdfc9)", () => {
	const sources: CookieSource[] = [
		{ browser: 'chrome', label: 'Google Chrome', profiles: [{ name: 'Personal', directory: 'Default' }, { name: 'Work', directory: 'Profile 1' }] },
		{ browser: 'edge', label: 'Microsoft Edge', profiles: [{ name: 'Default', directory: 'Default' }] }
	];
	const view = (rows: ReturnType<typeof cookiePickRows>) => rows.map((r) => [r.label, r.separator ?? '', r.description ?? '']);

	test('profiles grouped by browser; a one-profile browser is one row named after it', () => {
		expect(view(cookiePickRows(sources, null, '', 'Last used'))).toEqual([
			['Personal', 'Google Chrome', ''],
			['Work', '', ''],
			['Microsoft Edge', ' ', '']
		]);
	});

	test('Last used comes first on an empty search, and only while that profile is there', () => {
		const rows = cookiePickRows(sources, { browser: 'chrome', directory: 'Profile 1' }, '', 'Last used');
		expect(rows[0]).toMatchObject({ id: 'last:b:chrome\u001fProfile 1', label: 'Google Chrome · Work', separator: 'Last used' });
		expect(cookiePickSource(rows[0].id)).toEqual({ browser: 'chrome', directory: 'Profile 1' });
		expect(cookiePickRows(sources, { browser: 'chrome', directory: 'Gone' }, '', 'Last used')[0].label).toBe('Personal');
		expect(cookiePickRows(sources, { browser: 'chrome', directory: 'Profile 1' }, 'work', 'Last used').some((r) => r.id.startsWith('last:'))).toBe(false);
	});

	test('every typed word must match the browser or profile name', () => {
		expect(view(cookiePickRows(sources, null, 'chrome work', ''))).toEqual([['Work', 'Google Chrome', 'Google Chrome']]);
		expect(view(cookiePickRows(sources, null, 'edge', ''))).toEqual([['Microsoft Edge', '', '']]);
		expect(cookiePickRows(sources, null, 'firefox', '')).toEqual([]);
	});

	test('a browser that listed no profiles still gets a row', () => {
		const rows = cookiePickRows([{ browser: 'chrome', label: 'Google Chrome', profiles: [] }], null, '', '');
		expect(rows).toHaveLength(1);
		expect(cookiePickSource(rows[0].id)).toEqual({ browser: 'chrome', directory: null });
	});
});
