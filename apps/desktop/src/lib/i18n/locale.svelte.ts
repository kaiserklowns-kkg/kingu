// The reactive UI language: kingu.uiLanguage (auto | th | en), with `auto` following the
// OS / WebView language. Installed once by the workbench (settings/apply.svelte.ts); from then on
// every t() call made in a reactive context re-runs when the setting changes.
import { invoke } from '@tauri-apps/api/core';
import { settings } from '#lib/settings/settings.svelte.ts';
import { resolveUiLanguage, useLocaleSource, type Locale } from './index';

const osLanguage = () => (typeof navigator !== 'undefined' ? navigator.language : null);

class UiLocale {
	current = $state<Locale>(resolveUiLanguage('auto', osLanguage()));
}

export const uiLocale = new UiLocale();
useLocaleSource(() => uiLocale.current);

/**
 * Follows kingu.uiLanguage and the OS language; sets <html lang> and tells Rust (`app_set_locale`)
 * so its errors, dialogs and notifications use the same language. Returns an uninstaller.
 */
export function installUiLanguage(): () => void {
	let os = $state(osLanguage());
	const onLanguage = () => (os = osLanguage());
	window.addEventListener('languagechange', onLanguage);
	const dispose = $effect.root(() => {
		$effect(() => {
			const l = resolveUiLanguage(settings.get('kingu.uiLanguage'), os);
			uiLocale.current = l;
			document.documentElement.lang = l;
			invoke('app_set_locale', { locale: l }).catch(() => {});
		});
	});
	return () => {
		window.removeEventListener('languagechange', onLanguage);
		dispose();
	};
}
