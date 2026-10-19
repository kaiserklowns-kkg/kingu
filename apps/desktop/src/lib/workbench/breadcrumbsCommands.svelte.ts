// Breadcrumbs commands (VS Code: breadcrumbsControl.ts): View: Toggle Breadcrumbs flips
// `breadcrumbs.enabled`; Copy Breadcrumbs Path copies the symbol path at the cursor, joined with
// `breadcrumbs.symbolPathSeparator`.

import { symbolPath } from '#lib/lsp/convert.ts';
import { outline } from './outline.svelte';
import { settings } from '#lib/settings/settings.svelte.ts';
import { visibleSymbols, symbolPathText } from './breadcrumbs';
import { commands } from './commands.svelte';
import { editors } from './editors.svelte';
import { status } from './status.svelte';
import { t } from '#lib/i18n/index.ts';

const get = <T>(id: string) => settings.get<T>(id);

/** The active editor's symbol crumbs after the `breadcrumbs.show*` filters (whatever `symbolPath` shows). */
function activeSymbols() {
	const path = editors.active;
	return path ? visibleSymbols(symbolPath(outline.symbolsOf(path), { line: editors.cursor.line - 1, character: editors.cursor.column - 1 }), get, 'on') : [];
}

export function installBreadcrumbs(): () => void {
	const unregister = [
		commands.register({
			id: 'breadcrumbs.toggle',
			title: 'Toggle Breadcrumbs',
			category: 'View',
			run: () => void settings.set('breadcrumbs.enabled', !get<boolean>('breadcrumbs.enabled'), 'user')
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
