// Orca's browser cookie import (docs/browser/profiles "Cookie import and Google sign-in"): the
// messages for what `browser_cookie_import` (src-tauri floating_browser/cookies.rs) did.
import { t } from '#lib/i18n/index.ts';

/** Chrome or Edge, with their profiles that have a cookie database. */
export type CookieSource = { browser: string; label: string; profiles: { name: string; directory: string }[] };

export type CookieImportFrom = { kind: 'browser'; browser: string; directory: string | null } | { kind: 'file'; path: string };

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

// ---- the Import Cookies picker (Orca 4a4cbdfc9, `browser-cookie-import-picker-rows.ts`) -------

/** A browser profile cookies come from; `directory` is null for a browser that listed no profiles. */
export type CookiePickSource = { browser: string; directory: string | null };

/** A row of the picker (Quick Input's `PickItem`). */
export type CookiePickRow = { id: string; label: string; description?: string; separator?: string; source?: CookiePickSource };

const SEP = '\u001f';
const sourceId = (s: CookiePickSource) => `b:${s.browser}${SEP}${s.directory ?? ''}`;

/** The source a row id names, if it is a profile row (`b:` or the Last used `last:b:`). */
export function cookiePickSource(id: string): CookiePickSource | null {
	const m = id.replace(/^last:/, '').match(/^b:([^\u001f]*)\u001f(.*)$/s);
	return m ? { browser: m[1], directory: m[2] || null } : null;
}

/**
 * The profile rows for `query`: "Last used" first (empty search only, and only while that browser
 * and profile are still there), then one group per browser with matching rows. A one-profile browser
 * is a single row named after the browser. Every typed word must appear in "<browser> <profile>", so
 * "chrome work" finds Chrome's Work profile. Group labels are hidden while searching, so a profile
 * row then names its browser beside it.
 */
export function cookiePickRows(sources: readonly CookieSource[], lastUsed: CookiePickSource | null, query: string, lastUsedLabel: string): CookiePickRow[] {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const searching = words.length > 0;
	const out: CookiePickRow[] = [];
	let last: CookiePickRow | null = null;
	for (const s of sources) {
		const single = s.profiles.length <= 1;
		const profiles = s.profiles.length > 0 ? s.profiles : [null];
		const rows = profiles.map((p) => {
			const source: CookiePickSource = { browser: s.browser, directory: p?.directory ?? null };
			return { source, name: p?.name ?? '', label: single ? s.label : (p?.name ?? ''), search: `${s.label} ${p?.name ?? ''}`.toLowerCase() };
		});
		if (!searching && !last && lastUsed?.browser === s.browser) {
			const row = rows.find((r) => r.source.directory === lastUsed.directory);
			if (row) last = { id: `last:${sourceId(row.source)}`, label: single ? s.label : `${s.label} · ${row.label}`, separator: lastUsedLabel, source: row.source };
		}
		const matching = rows.filter((r) => words.every((w) => r.search.includes(w)));
		// A one-profile browser's row names it, so its group has no label: only a rule above it.
		const heading = single ? (out.length > 0 || last ? ' ' : undefined) : s.label;
		matching.forEach((r, i) =>
			out.push({
				id: sourceId(r.source),
				label: r.label,
				...(searching && !single ? { description: s.label } : {}),
				...(i === 0 && heading ? { separator: heading } : {}),
				source: r.source
			})
		);
	}
	return last ? [last, ...out] : out;
}

// One remembered source serves every tab: they all import from this computer's browsers.
const LAST_USED_KEY = 'kingu.browser.cookieImport.lastUsedSource';

export function readCookieImportLastUsed(): CookiePickSource | null {
	try {
		const v: unknown = JSON.parse(localStorage.getItem(LAST_USED_KEY) ?? 'null');
		if (v && typeof v === 'object' && typeof (v as CookiePickSource).browser === 'string') {
			const d = (v as CookiePickSource).directory;
			if (d === null || typeof d === 'string') return { browser: (v as CookiePickSource).browser, directory: d };
		}
	} catch {
		/* storage unavailable */
	}
	return null;
}

export function rememberCookieImportLastUsed(source: CookiePickSource): void {
	try {
		localStorage.setItem(LAST_USED_KEY, JSON.stringify({ browser: source.browser, directory: source.directory }));
	} catch {
		/* storage unavailable */
	}
}
