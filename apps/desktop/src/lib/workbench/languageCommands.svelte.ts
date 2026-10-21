// Commands of the Outline view (VS Code: outline.contribution.ts / outlineActions.ts) and of the
// call and type hierarchy (the references-view extension's Calls / Types commands).

import { lsp } from '#lib/lsp/lsp.svelte.ts';
import { commands } from './commands.svelte';
import { editors } from './editors.svelte';
import { hierarchy } from './hierarchy.svelte';
import { layout } from './layout.svelte';
import { outline } from './outline.svelte';

export function installLanguageCommands(): () => void {
	const uninstallOutline = outline.install();
	const editorOpen = () => editors.active !== null && lsp.hasServer(editors.language);
	const unregister = [
		commands.register({
			id: 'outline.focus',
			title: 'Focus on Outline View',
			category: 'Explorer',
			run: () => {
				layout.showView('explorer');
				layout.sidebarVisible = true;
				outline.open = true;
				queueMicrotask(() => document.querySelector<HTMLElement>('[data-view="outline"] [role="tree"]')?.focus());
			}
		}),
		commands.register({ id: 'outline.toggleFollowCursor', title: 'Toggle Follow Cursor', category: 'Outline', run: () => void (outline.followCursor = !outline.followCursor) }),
		commands.register({ id: 'outline.toggleFilterOnType', title: 'Toggle Filter on Type', category: 'Outline', run: () => void (outline.filterOnType = !outline.filterOnType) }),
		commands.register({ id: 'outline.sortByPosition', title: 'Sort By: Position', category: 'Outline', run: () => void (outline.sortBy = 'position') }),
		commands.register({ id: 'outline.sortByName', title: 'Sort By: Name', category: 'Outline', run: () => void (outline.sortBy = 'name') }),
		commands.register({ id: 'outline.sortByKind', title: 'Sort By: Category', category: 'Outline', run: () => void (outline.sortBy = 'kind') }),
		commands.register({ id: 'references-view.showCallHierarchy', title: 'Show Call Hierarchy', category: 'Calls', key: 'shift+alt+h', when: editorOpen, run: () => hierarchy.show('call') }),
		commands.register({ id: 'references-view.showIncomingCalls', title: 'Show Incoming Calls', category: 'Calls', when: editorOpen, run: () => hierarchy.show('call', 'incoming') }),
		commands.register({ id: 'references-view.showOutgoingCalls', title: 'Show Outgoing Calls', category: 'Calls', when: editorOpen, run: () => hierarchy.show('call', 'outgoing') }),
		commands.register({ id: 'references-view.showTypeHierarchy', title: 'Show Type Hierarchy', category: 'Types', when: editorOpen, run: () => hierarchy.show('type') }),
		commands.register({ id: 'references-view.showSupertypes', title: 'Show Supertypes', category: 'Types', when: editorOpen, run: () => hierarchy.show('type', 'supertypes') }),
		commands.register({ id: 'references-view.showSubtypes', title: 'Show Subtypes', category: 'Types', when: editorOpen, run: () => hierarchy.show('type', 'subtypes') })
	];
	return () => {
		unregister.forEach((u) => u());
		uninstallOutline();
	};
}
