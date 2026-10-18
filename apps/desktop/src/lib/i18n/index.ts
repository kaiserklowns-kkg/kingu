// UI translations: t('area.file.what', { param }) → the message in the current UI language.
//
// Plain TypeScript (no runes), so services and bun tests can import it. The app plugs in a
// reactive locale (./locale.svelte.ts reads kingu.uiLanguage): t() reads it, so a call inside a
// component template, $derived or $effect re-runs when the language changes. Strings computed
// once (a status.flash, a notification) stay in the language they were made in, like VS Code.
import { en, type MessageKey } from './en';
import { th } from './th';
import { formatMessage, resolveUiLanguage, type Locale, type ParamValue, type ParamsOf } from './format';

export type { Locale, MessageKey };
export { resolveUiLanguage };

const CATALOGS: Record<Locale, Record<MessageKey, string>> = { en, th };

let fixed: Locale = resolveUiLanguage('auto', typeof navigator !== 'undefined' ? navigator.language : null);
let read: () => Locale = () => fixed;

/** The current UI language (reactive once ./locale.svelte.ts is installed). */
export const locale = (): Locale => read();

/** Sets the language outside the app's reactive source (bun tests, scripts). */
export function setLocale(l: Locale) {
	fixed = l;
	read = () => fixed;
}

/** Called by ./locale.svelte.ts: t() reads the language through `source` from now on. */
export function useLocaleSource(source: () => Locale) {
	read = source;
}

type Message<K extends MessageKey> = (typeof en)[K];
type Args<K extends MessageKey> = [ParamsOf<Message<K>>] extends [never] ? [] : [params: Record<ParamsOf<Message<K>>, ParamValue>];

/** The message for `key` in the current UI language (English if the Thai one is somehow missing). */
export function t<K extends MessageKey>(key: K, ...args: Args<K>): string {
	const params = args[0] as Record<string, ParamValue> | undefined;
	return formatMessage(CATALOGS[read()][key] ?? en[key], params);
}

/** Same as t() for a fixed language (e.g. text that must be English whatever the UI is). */
export function tIn<K extends MessageKey>(l: Locale, key: K, ...args: Args<K>): string {
	const params = args[0] as Record<string, ParamValue> | undefined;
	return formatMessage(CATALOGS[l][key] ?? en[key], params);
}

/** Whether `key` is a catalog key (for strings that arrive as data, e.g. a stored message id). */
export const isMessageKey = (key: string): key is MessageKey => Object.hasOwn(en, key);
