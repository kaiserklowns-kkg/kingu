// Orca's browser cookie import (docs/browser/profiles "Cookie import and Google sign-in"): the
// messages for what `browser_cookie_import` (src-tauri floating_browser/cookies.rs) did.
import { t } from '#lib/i18n/index.ts';

/** Chrome or Edge, with their profiles that have a cookie database. */
export type CookieSource = { browser: string; label: string; profiles: { name: string; directory: string }[] };

export type CookieImportFrom = { kind: 'browser'; browser: string; directory: string } | { kind: 'file'; path: string };

export type CookieImportSummary = {
	total: number;
	imported: number;
	skipped: number;
	googleSkipped: number;
	partitionSkipped: number;
	undecryptable: number;
	replaced: number;
	domains: number;
};

export type CookieImportFailure = { code: string; browser?: string; profile?: string; count?: number; detail?: string };

function isFailure(e: unknown): e is CookieImportFailure {
	return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string';
}

/** The refusal in the UI language (Orca's BROWSER_COOKIE_IMPORT_FAILURE_COPY). */
export function cookieImportFailureText(e: unknown): string {
	if (!isFailure(e)) return t('ade.cookieImport.fail.other', { error: String(e) });
	const browser = e.browser ?? '';
	switch (e.code) {
		case 'unsupported':
			return t('ade.cookieImport.fail.unsupported');
		case 'browserNotFound':
			return t('ade.cookieImport.fail.browserNotFound');
		case 'invalidBrowserProfile':
			return t('ade.cookieImport.fail.invalidBrowserProfile');
		case 'browserProfileDatabaseMissing':
			return t('ade.cookieImport.fail.browserProfileDatabaseMissing', { profile: e.profile ?? '' });
		case 'databaseCopyFailed':
			return t('ade.cookieImport.fail.databaseCopyFailed', { browser });
		case 'macFullDiskAccess':
			return t('ade.cookieImport.fail.macFullDiskAccess', { browser });
		case 'readFailed':
			return t('ade.cookieImport.fail.readFailed', { browser });
		case 'noCookies':
			return t('ade.cookieImport.fail.noCookies', { browser });
		case 'encryptionKeyDenied':
			return t('ade.cookieImport.fail.encryptionKeyDenied', { browser });
		case 'fileUnreadable':
			return t('ade.cookieImport.fail.fileUnreadable');
		case 'fileInvalidJson':
			return t('ade.cookieImport.fail.fileInvalidJson');
		case 'fileNotArray':
			return t('ade.cookieImport.fail.fileNotArray');
		case 'fileEmpty':
			return t('ade.cookieImport.fail.fileEmpty');
		case 'fileNoValidCookies':
			return t('ade.cookieImport.fail.fileNoValidCookies', { count: e.count ?? 0 });
		case 'writeFailed':
			return t('ade.cookieImport.fail.writeFailed', { error: e.detail ?? '' });
		default:
			return t('ade.cookieImport.fail.other', { error: e.detail ?? e.code });
	}
}

/** What to tell after an import (Orca's emitBrowserCookieImportToast): the result, or the
 * undecryptable warning in its place, then the Google and partition warnings. */
export function cookieImportMessages(s: CookieImportSummary, success: string): { info?: string; warnings: string[] } {
	const warnings: string[] = [];
	let info: string | undefined;
	if (s.undecryptable > 0) warnings.push(t('ade.cookieImport.undecryptable', { count: s.undecryptable }));
	else info = s.skipped > 0 ? `${success} ${t('ade.cookieImport.skipped', { count: s.skipped })}` : success;
	if (s.googleSkipped > 0) warnings.push(t('ade.cookieImport.googleSkipped'));
	if (s.partitionSkipped > 0) warnings.push(t('ade.cookieImport.partitionSkipped', { count: s.partitionSkipped }));
	return { info, warnings };
}
