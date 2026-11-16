// The Search view's own commands, with VS Code's ids and default keys
// (contrib/search/browser/searchActionsNav.ts, searchActionsTopBar.ts, searchActionsFind.ts):
// Replace in Files (⇧⌘H), Toggle Search Details (⇧⌘J), the query toggles while the view has focus
// (⌥⌘C Match Case, ⌥⌘W Whole Word, ⌥⌘R Regex, ⌥⌘P Preserve Case; ⌥C … off macOS), F4 / ⇧F4
// through the results from anywhere, Dismiss (⌘⌫) and Replace / Replace All in File / Folder
// (⇧⌘1) on the focused result, and the title bar's Refresh / Clear / Collapse / Expand /
// View as List / Tree in the palette.

import { commands } from './commands.svelte';
import { editors } from './editors.svelte';
import { layout } from './layout.svelte';
import { quick } from './quick.svelte';
import { search } from './search.svelte';
import { settings } from '#lib/settings/settings.svelte.ts';

/** VS Code's `searchViewFocus`: keyboard focus is somewhere in the Search view. */
export const searchViewFocused = () => !!document.activeElement?.closest('[data-context="search"]');

/** VS Code's FileMatchOrMatchFocus / FolderFocus: the results tree has focus on a row. */
const resultsFocused = () => !!document.activeElement?.closest('[data-search-results]') && search.focusedRow() !== null;
/** VS Code's ReplaceActive and IsEditableItem: the Replace box is shown and the results can be replaced. */
const canReplace = () => search.showReplace && search.searched !== null && !search.replacing;
const focusedKind = () => search.focusedRow()?.kind;

function showView() {
	layout.sideView = 'search';
	layout.sidebarVisible = true;
}

/** Find / Replace in Files: the view, seeded from the editor's selection (search.seedWithNearestWord). */
function findOrReplace(replace: boolean) {
	showView();
	if (replace) search.showReplace = true;
	search.reveal(editors.selectionText(settings.get<boolean>('search.seedWithNearestWord')));
}

function replaceFocused() {
	const row = search.focusedRow();
	if (row) void search.replaceRow(row);
}

/** Registers the commands; returns the unregister function. */
export function installSearchViewCommands(): () => void {
	const hasResults = () => search.files.length > 0;
	const unregister = [
		commands.register({ id: 'workbench.view.search', title: 'Show Search', category: 'View', run: () => (showView(), (search.focusRequested = true)) }),
		commands.register({ id: 'workbench.action.replaceInFiles', title: 'Replace in Files', category: 'Search', key: 'cmd+shift+h', scope: 'ide', run: () => findOrReplace(true) }),
		commands.register({
			id: 'workbench.action.search.toggleQueryDetails',
			title: 'Toggle Query Details',
			category: 'Search',
			key: 'cmd+shift+j',
			// Over Worktree Jump (⇧⌘J elsewhere) while the view has focus.
			weight: 1,
			keyWhen: searchViewFocused,
			run: () => (showView(), (search.showDetails = !search.showDetails))
		}),
		commands.register({ id: 'toggleSearchCaseSensitive', title: 'Toggle Match Case', category: 'Search', key: 'alt+c', mac: 'alt+cmd+c', keyWhen: searchViewFocused, run: () => search.toggleOption('matchCase') }),
		commands.register({ id: 'toggleSearchWholeWord', title: 'Toggle Match Whole Word', category: 'Search', key: 'alt+w', mac: 'alt+cmd+w', keyWhen: searchViewFocused, run: () => search.toggleOption('wholeWord') }),
		commands.register({ id: 'toggleSearchRegex', title: 'Toggle Use Regular Expression', category: 'Search', key: 'alt+r', mac: 'alt+cmd+r', keyWhen: searchViewFocused, run: () => search.toggleOption('isRegex') }),
		commands.register({ id: 'toggleSearchPreserveCase', title: 'Toggle Preserve Case', category: 'Search', key: 'alt+p', mac: 'alt+cmd+p', keyWhen: searchViewFocused, run: () => search.toggleOption('preserveCase') }),
		commands.register({
			id: 'search.action.focusNextSearchResult',
			title: 'Focus Next Search Result',
			category: 'Search',
			key: 'f4',
			scope: 'ide',
			when: hasResults,
			run: () => (showView(), search.stepMatch(1))
		}),
		commands.register({
			id: 'search.action.focusPreviousSearchResult',
			title: 'Focus Previous Search Result',
			category: 'Search',
			key: 'shift+f4',
			scope: 'ide',
			when: hasResults,
			run: () => (showView(), search.stepMatch(-1))
		}),
		// Dismiss (⌘⌫, Delete off macOS) and Replace (⇧⌘1) on the focused row of the results tree.
		commands.register({
			id: 'search.action.remove',
			title: 'Dismiss',
			category: 'Search',
			key: 'delete',
			mac: 'cmd+backspace',
			when: () => search.focusedRow() !== null,
			keyWhen: resultsFocused,
			run: () => {
				const row = search.focusedRow();
				if (row) search.dismiss(row);
			}
		}),
		commands.register({
			id: 'search.action.replace',
			title: 'Replace',
			category: 'Search',
			key: 'cmd+shift+1',
			when: () => canReplace() && focusedKind() === 'match',
			keyWhen: resultsFocused,
			run: () => replaceFocused()
		}),
		commands.register({
			id: 'search.action.replaceAllInFile',
			title: 'Replace All in File',
			category: 'Search',
			key: 'cmd+shift+1',
			when: () => canReplace() && focusedKind() === 'file',
			keyWhen: resultsFocused,
			run: () => replaceFocused()
		}),
		commands.register({
			id: 'search.action.replaceAllInFolder',
			title: 'Replace All in Folder',
			category: 'Search',
			key: 'cmd+shift+1',
			when: () => canReplace() && focusedKind() === 'folder',
			keyWhen: resultsFocused,
			run: () => replaceFocused()
		}),
		commands.register({ id: 'workbench.action.quickTextSearch', title: 'Quick Search', category: 'Search', run: () => quick.show('%') }),
		commands.register({ id: 'search.action.refreshSearchResults', title: 'Refresh', category: 'Search', when: () => search.query !== '', run: () => void search.run() }),
		commands.register({ id: 'search.action.clearSearchResults', title: 'Clear Search Results', category: 'Search', run: () => search.clear() }),
		commands.register({ id: 'search.action.collapseSearchResults', title: 'Collapse All', category: 'Search', when: hasResults, run: () => search.collapseAll() }),
		commands.register({ id: 'search.action.expandSearchResults', title: 'Expand All', category: 'Search', when: hasResults, run: () => search.collapsed.clear() }),
		commands.register({ id: 'search.action.viewAsTree', title: 'View as Tree', category: 'Search', when: () => search.viewMode === 'list', run: () => (search.viewMode = 'tree') }),
		commands.register({ id: 'search.action.viewAsList', title: 'View as List', category: 'Search', when: () => search.viewMode === 'tree', run: () => (search.viewMode = 'list') })
	];
	return () => unregister.forEach((u) => u());
}
