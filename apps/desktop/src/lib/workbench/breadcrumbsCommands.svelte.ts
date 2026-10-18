// Breadcrumbs commands (VS Code: breadcrumbsControl.ts): View: Toggle Breadcrumbs flips
// `breadcrumbs.enabled`; Copy Breadcrumbs Path copies the symbol path at the cursor, joined with
// `breadcrumbs.symbolPathSeparator`.

import { lsp } from '#lib/lsp/lsp.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { visibleSymbols, symbolPathText } from './breadcrumbs';
import { commands } from './commands.svelte';
import { editors } from './editors.svelte';
import { status } from './status.svelte';

const get = <T>(id: string) => settings.get<T>(id);

/** The active editor's symbol crumbs after the `breadcrumbs.show*` filters (whatever `symbolPath` shows). */
function activeSymbols() {
	const path = editors.active;
	return path ? visibleSymbols(lsp.crumbs(path, editors.cursor.line, editors.cursor.column), get, 'on') : [];
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
				if (text) void navigator.clipboard?.writeText(text).then(() => status.flash(`คัดลอก ${text}`));
			}
		})
	];
	return () => unregister.forEach((u) => u());
}
