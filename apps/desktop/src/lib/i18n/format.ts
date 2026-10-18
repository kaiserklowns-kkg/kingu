// Message formatting for the UI catalogs (pure; no Svelte, so bun tests and plain .ts services use it).
//
// A message is plain text with placeholders:
//   {name}                  the param's value
//   {count|one|other}       plural choice: `one` when count is 1, else `other`; `#` in a form is the number
// Thai has no plural, so a Thai message usually writes `{count} ไฟล์` where English writes
// `{count|# file|# files}`. Both catalogs must use the same param names (checked by i18n.test.ts).

export type Locale = 'en' | 'th';
export type ParamValue = string | number;

/** Param names a message uses, in order of first use (`{a}`, `{a|x|y}` → `a`). */
export function paramNames(message: string): string[] {
	const names: string[] = [];
	for (const m of message.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)(?:\|[^}]*)?\}/g)) if (!names.includes(m[1])) names.push(m[1]);
	return names;
}

/** Fills a message's placeholders. A missing param is left as `{name}` so the gap shows. */
export function formatMessage(message: string, params?: Record<string, ParamValue>): string {
	if (!params) return message;
	return message.replace(/\{([A-Za-z_][A-Za-z0-9_]*)(\|[^}]*)?\}/g, (whole, name: string, forms: string | undefined) => {
		const value = params[name];
		if (value === undefined) return whole;
		if (!forms) return String(value);
		const [one, other = one] = forms.slice(1).split('|');
		const n = Number(value);
		return (n === 1 ? one : other).replace(/#/g, String(value));
	});
}

/**
 * The UI language for a `kingu.uiLanguage` value: `th` / `en` as set; `auto` (or anything else)
 * follows the OS / WebView language — Thai when it starts with `th`, English otherwise.
 */
export function resolveUiLanguage(setting: unknown, osLanguage: string | null | undefined): Locale {
	if (setting === 'th' || setting === 'en') return setting;
	return (osLanguage ?? '').toLowerCase().startsWith('th') ? 'th' : 'en';
}

/** Param names of a message as a type (`'a' | 'b'`), so t() asks for exactly those. */
export type ParamsOf<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? (P extends `${infer N}|${string}` ? N : P) | ParamsOf<Rest> : never;
