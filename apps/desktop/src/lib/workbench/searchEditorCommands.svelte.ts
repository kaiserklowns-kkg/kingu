// Search Editor commands (VS Code: searchEditor.contribution.ts / searchEditorActions.ts), with its
// macOS keys. Keys that act on the editor only fire while focus is inside the Search Editor.

import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from './commands.svelte';
import { appMode } from './mode.svelte';
import { editors } from './editors.svelte';
import { search } from './search.svelte';
import { searchEditors } from './searchEditor.svelte.ts';
import { deleteFileResults, isSearchEditorKey, modifyContextLines, type SearchConfig } from './searchEditor';
import { seedFromSelection } from './searchResults';
import { searchEditorView } from './SearchEditorView.svelte';

/** The active Search Editor of the IDE (never in the Agents layout). */
const activeKey = () => {
	if (appMode.isAgents) return null;
	const key = editors.active;
	return key && isSearchEditorKey(key) ? key : null;
};
/** Focus is in the Search Editor (VS Code's `inSearchEditor`). */
const inSearchEditor = () => activeKey() !== null && !!document.activeElement?.closest('[data-search-editor]');
const inResults = () => activeKey() !== null && !!document.activeElement?.closest('[data-search-editor-results]');

/** The query a new Search Editor starts with: the editor selection (or the word at the cursor). */
function seed(): Partial<SearchConfig> {
	const query = seedFromSelection(editors.selectionText(settings.get<boolean>('search.seedWithNearestWord')));
	return query ? { query } : {};
}

/** The Search view's query and options (VS Code's Open Results in Editor). */
function fromSearchView(): Partial<SearchConfig> {
	return {
		query: search.query,
		isRegexp: search.isRegex,
		isCaseSensitive: search.matchCase,
		matchWholeWord: search.wholeWord,
		filesToInclude: search.include,
		filesToExclude: search.exclude,
		useExcludeSettingsAndIgnoreFiles: search.useIgnoreFiles,
		showIncludesExcludes: !!(search.include || search.exclude || !search.useIgnoreFiles)
	};
}

/** Search: Open Results in Editor (⌘Enter in the Search view). */
export function openSearchViewInEditor() {
	searchEditors.openNew(fromSearchView(), { triggerSearch: !!search.query });
}

function editConfig(change: (c: SearchConfig) => void) {
	const key = activeKey();
	if (!key) return;
	change(searchEditors.get(key).config);
	void searchEditors.run(key);
}

function deleteResults() {
	const key = activeKey();
	const ed = key && searchEditorView(key);
	if (!key || !ed) return;
	const model = ed.getModel();
	const selections = ed.getSelections();
	if (!model || !selections) return;
	const { lines, ranges } = deleteFileResults(model.getLinesContent(), selections, searchEditors.get(key).matchRanges);
	searchEditors.setText(key, lines.join('\n'), ranges);
}

function selectAllMatches() {
	const key = activeKey();
	const ed = key && searchEditorView(key);
	if (!key || !ed) return;
	const ranges = searchEditors.get(key).matchRanges;
	if (!ranges.length) return;
	ed.setSelections(ranges.map((r) => ({ selectionStartLineNumber: r.startLineNumber, selectionStartColumn: r.startColumn, positionLineNumber: r.endLineNumber, positionColumn: r.endColumn })));
	ed.focus();
}

export function installSearchEditorCommands(): () => void {
	const unregister = [
		commands.register({ id: 'search.action.openNewEditor', title: 'New Search Editor', category: 'Search', run: () => searchEditors.openNew(seed()) }),
		commands.register({
			id: 'search.action.openEditor',
			title: 'Open Search Editor',
			category: 'Search',
			// VS Code's `location: 'reuse'`: the most recent Search Editor of the group, seeded again.
			run: () => {
				const existing = editors.mru().find(isSearchEditorKey);
				if (!existing) return void searchEditors.openNew(seed());
				editors.open(existing, { preview: false });
				const s = searchEditors.get(existing);
				const { query } = seed();
				if (query && query !== s.config.query) {
					s.config.query = query;
					void searchEditors.run(existing);
				} else s.focusInput++;
			}
		}),
		commands.register({ id: 'search.action.openNewEditorToSide', title: 'Open New Search Editor to the Side', category: 'Search', run: () => searchEditors.openNew(seed(), { toSide: true }) }),
		commands.register({
			id: 'search.action.openInEditor',
			title: 'Open Results in Editor',
			category: 'Search',
			key: 'cmd+enter',
			keyWhen: () => !!document.activeElement?.closest('[aria-label="Search"]') && !document.activeElement?.closest('.monaco-editor'),
			when: () => search.query !== '',
			run: openSearchViewInEditor
		}),
		commands.register({ id: 'rerunSearchEditorSearch', title: 'Search Again', category: 'Search Editor', key: 'cmd+shift+r', weight: 1, when: () => activeKey() !== null, keyWhen: inSearchEditor, run: () => searchEditors.run(activeKey()!) }),
		commands.register({
			id: 'search.searchEditor.action.deleteFileResults',
			title: 'Delete File Results',
			category: 'Search Editor',
			key: 'cmd+shift+backspace',
			weight: 1,
			when: () => activeKey() !== null,
			keyWhen: inSearchEditor,
			run: deleteResults
		}),
		commands.register({ id: 'toggleSearchEditorCaseSensitive', title: 'Toggle Match Case', category: 'Search Editor', key: 'alt+c', mac: 'alt+cmd+c', weight: 1, when: () => activeKey() !== null, keyWhen: inSearchEditor, run: () => editConfig((c) => (c.isCaseSensitive = !c.isCaseSensitive)) }),
		commands.register({ id: 'toggleSearchEditorWholeWord', title: 'Toggle Match Whole Word', category: 'Search Editor', key: 'alt+w', mac: 'alt+cmd+w', weight: 1, when: () => activeKey() !== null, keyWhen: inSearchEditor, run: () => editConfig((c) => (c.matchWholeWord = !c.matchWholeWord)) }),
		commands.register({ id: 'toggleSearchEditorRegex', title: 'Toggle Use Regular Expression', category: 'Search Editor', key: 'alt+r', mac: 'alt+cmd+r', weight: 1, when: () => activeKey() !== null, keyWhen: inSearchEditor, run: () => editConfig((c) => (c.isRegexp = !c.isRegexp)) }),
		commands.register({ id: 'toggleSearchEditorContextLines', title: 'Toggle Context Lines', category: 'Search Editor', key: 'alt+l', mac: 'alt+cmd+l', weight: 1, when: () => activeKey() !== null, keyWhen: inSearchEditor, run: () => searchEditors.toggleContextLines(activeKey()!) }),
		commands.register({ id: 'increaseSearchEditorContextLines', title: 'Increase Context Lines', category: 'Search Editor', key: 'alt+=', weight: 1, when: () => activeKey() !== null, keyWhen: inSearchEditor, run: () => editConfig((c) => (c.contextLines = modifyContextLines(c.contextLines, true))) }),
		commands.register({ id: 'decreaseSearchEditorContextLines', title: 'Decrease Context Lines', category: 'Search Editor', key: 'alt+-', weight: 1, when: () => activeKey() !== null, keyWhen: inSearchEditor, run: () => editConfig((c) => (c.contextLines = modifyContextLines(c.contextLines, false))) }),
		commands.register({ id: 'selectAllSearchEditorMatches', title: 'Select All Matches', category: 'Search Editor', key: 'cmd+shift+l', weight: 1, when: () => activeKey() !== null, keyWhen: inSearchEditor, run: selectAllMatches }),
		commands.register({ id: 'search.action.focusQueryEditorWidget', title: 'Focus Search Editor Input', category: 'Search Editor', when: () => activeKey() !== null, keyWhen: inResults, run: () => searchEditors.get(activeKey()!).focusInput++ })
	];
	return () => unregister.forEach((u) => u());
}
