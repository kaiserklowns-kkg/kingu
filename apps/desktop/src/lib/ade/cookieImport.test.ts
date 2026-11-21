import { describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import { cookieImportFailureText, cookieImportMessages, type CookieImportSummary } from './cookieImport';

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
