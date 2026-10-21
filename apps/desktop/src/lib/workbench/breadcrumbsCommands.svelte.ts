// Breadcrumbs commands (VS Code: breadcrumbsControl.ts): View: Toggle Breadcrumbs flips
// `breadcrumbs.enabled`; Copy Breadcrumbs Path copies the symbol path at the cursor, joined with
// `breadcrumbs.symbolPathSeparator`; Focus Breadcrumbs (⇧⌘;) and Focus and Select Breadcrumbs
// (⇧⌘.) put the keyboard on the active group's last crumb, the latter opening its picker
// (breadcrumbs.toggleToOn turns hidden breadcrumbs on first). The group view does the focusing.

import { symbolPath } from '#lib/lsp/convert.ts';
import { outline } from './outline.svelte';
import { settings } from '#lib/settings/settings.svelte.ts';
import { visibleSymbols, symbolPathText } from './breadcrumbs';
import { commands } from './commands.svelte';
import { editors } from './editors.svelte';
import { appMode } from './mode.svelte';
import { status } from './status.svelte';
import { t } from '#lib/i18n/index.ts';

const get = <T>(id: string) => settings.get<T>(id);

/** A request to focus a group's breadcrumbs (`seq` changes per request); EditorGroupView acts on it. */
export const crumbFocus = $state({ group: -1, select: false, seq: 0 });

/** Focus (and with `select`, open the picker of) the active group's last crumb. */
export function focusBreadcrumbs(select: boolean) {
	crumbFocus.group = editors.activeGroupId;
	crumbFocus.select = select;
	crumbFocus.seq++;
}

/** The active editor's symbol crumbs after the `breadcrumbs.show*` filters (whatever `symbolPath` shows). */
function activeSymbols() {
	const path = editors.active;
	return path ? visibleSymbols(symbolPath(outline.symbolsOf(path), { line: editors.cursor.line - 1, character: editors.cursor.column - 1 }), get, 'on') : [];
}

export function installBreadcrumbs(): () => void {
	// VS Code's breadcrumbsPossible: an editor in the IDE's active group.
	const possible = () => !appMode.isAgents && editors.active !== null;
	const shown = () => possible() && get<boolean>('breadcrumbs.enabled');
	const unregister = [
		commands.register({
			id: 'breadcrumbs.toggle',
			title: 'Toggle Breadcrumbs',
			category: 'View',
			run: () => void settings.set('breadcrumbs.enabled', !get<boolean>('breadcrumbs.enabled'), 'user')
		}),
		commands.register({ id: 'breadcrumbs.focusAndSelect', title: 'Focus and Select Breadcrumbs', key: 'cmd+shift+.', when: shown, run: () => focusBreadcrumbs(true) }),
		commands.register({ id: 'breadcrumbs.focus', title: 'Focus Breadcrumbs', key: 'cmd+shift+;', when: shown, run: () => focusBreadcrumbs(false) }),
		commands.register({
			id: 'breadcrumbs.toggleToOn',
			title: 'Toggle Breadcrumbs to On',
			key: 'cmd+shift+.',
			palette: false,
			when: () => possible() && !get<boolean>('breadcrumbs.enabled'),
			run: async () => {
				await settings.set('breadcrumbs.enabled', true, 'user');
				// The group view shows the breadcrumbs on its next render.
				setTimeout(() => focusBreadcrumbs(true), 50);
			}
		}),
		commands.register({
			id: 'breadcrumbs.copyPath',
			title: 'Copy Breadcrumbs Path',
			category: 'View',
			when: () => get<boolean>('breadcrumbs.enabled') && activeSymbols().length > 0,
			run: () => {
				const text = symbolPathText(activeSymbols(), get);
				if (text) void navigator.clipboard?.writeText(text).then(() => status.flash(t('workbench.breadcrumbs.copied', { text })));
			}
		})
	];
	return () => unregister.forEach((u) => u());
}
