// Workbench-wide appearance and input settings that act on the whole page or the native window
// (VS Code: the workbench's classes and CSS variables, the window's native theme, the keybinding
// dispatcher). The rules are pure (workbenchOptions.ts); this applies them live.

import { untrack } from 'svelte';
import { settings } from '#lib/settings/settings.svelte.ts';
import { theme } from '#lib/theme/theme.svelte.ts';
import { isDarkType } from '#lib/theme/themes.ts';
import { setKeyboardDispatch, type KeyboardDispatch } from './keys';
import { editorTabHeight, fontSmoothing, nativeWindowTheme, reducedMotion } from './workbenchOptions';

export function installWorkbenchAppearance(): () => void {
	const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
	let osReduced = $state(motion?.matches ?? false);
	const onMotion = (e: MediaQueryListEvent) => (osReduced = e.matches);
	motion?.addEventListener('change', onMotion);
	// devicePixelRatio changes when the window moves to another display.
	let dpr = $state(window.devicePixelRatio || 1);
	const onResize = () => (dpr = window.devicePixelRatio || 1);
	window.addEventListener('resize', onResize);

	const dispose = $effect.root(() => {
		$effect(() => {
			const root = document.documentElement;
			// workbench.sash.size / workbench.sash.hoverDelay (Sash.svelte reads the variables).
			root.style.setProperty('--kg-sash-size', `${settings.get<number>('workbench.sash.size')}px`);
			root.style.setProperty('--kg-sash-hover-delay', `${settings.get<number>('workbench.sash.hoverDelay')}ms`);
			// window.density.editorTabHeight: the tab strip and the title control of a group.
			root.style.setProperty('--kg-tab-height', `${editorTabHeight(settings.get<string>('window.density.editorTabHeight'))}px`);
			// workbench.fontAliasing
			root.style.setProperty('--kg-font-smoothing', fontSmoothing(settings.get<string>('workbench.fontAliasing'), dpr));
			// workbench.reduceMotion / workbench.shadows
			root.classList.toggle('kg-reduce-motion', reducedMotion(settings.get<string>('workbench.reduceMotion'), osReduced));
			root.classList.toggle('kg-no-shadows', !settings.get<boolean>('workbench.shadows'));
		});
		// keyboard.dispatch
		$effect(() => setKeyboardDispatch(settings.get<KeyboardDispatch>('keyboard.dispatch')));
		// window.systemColorTheme: the native dialogs, menus and window frame (null follows the OS).
		$effect(() => {
			const native = nativeWindowTheme(settings.get<string>('window.systemColorTheme'), isDarkType(theme.current.type), settings.get<boolean>('window.autoDetectColorScheme'));
			if (!settings.loaded) return;
			untrack(() => {
				void import('@tauri-apps/api/window')
					.then(({ getCurrentWindow }) => getCurrentWindow().setTheme(native))
					.catch(() => {});
			});
		});
	});
	return () => {
		motion?.removeEventListener('change', onMotion);
		window.removeEventListener('resize', onResize);
		dispose();
	};
}
