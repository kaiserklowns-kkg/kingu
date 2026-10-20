// problems.sortOrder for Monaco's Go to Next/Previous Problem (F8), which reads it from Monaco's
// configuration service like VS Code's MarkerNavigationService does; and the Problems view's
// commands (VS Code: markers.contribution.ts): filter toggles, view as tree/table, copy, focus.

import { untrack } from 'svelte';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { copyText } from './problemsFilter';
import { problemsView } from './problemsViewState.svelte';

const problemsShown = () => layout.panelVisible && layout.panelTab === 'problems';
/** Focus is in the Problems list (not its filter box): ⌘C, Enter and ⌘Enter act on the selection. */
const listFocused = () => !!document.activeElement?.closest('[data-problems-view]');

async function copy(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		status.flash(t('problems.copied'));
	} catch (e) {
		notifications.error(e);
	}
}

function openSelected(side: boolean) {
	const s = problemsView.selected;
	if (!s || s.file.rel === null) return;
	const reveal = { line: s.item.range.start.line + 1, column: s.item.range.start.character + 1, focus: true };
	if (side) editors.openToSide(s.file.rel, reveal);
	else editors.open(s.file.rel, { preview: false, reveal });
}

export function installProblemsSettings(): () => void {
	const view = problemsView;
	const toggle = (id: string, title: string, flip: () => void) => commands.register({ id, title, category: 'Problems', run: flip });
	const unregister = [
		commands.register({ id: 'workbench.actions.view.toggleProblems', title: 'Toggle Problems (Errors, Warnings, Infos)', category: 'View', run: () => (problemsShown() ? (layout.panelVisible = false) : layout.showPanel('problems')) }),
		commands.register({ id: 'workbench.action.showErrorsWarnings', title: 'Show Errors and Warnings', palette: false, run: () => layout.showPanel('problems') }),
		commands.register({ id: 'workbench.actions.table.workbench.panel.markers.view.viewAsTree', title: 'View as Tree', category: 'Problems', when: () => view.mode === 'table', run: () => (view.mode = 'tree') }),
		commands.register({ id: 'workbench.actions.table.workbench.panel.markers.view.viewAsTable', title: 'View as Table', category: 'Problems', when: () => view.mode === 'tree', run: () => (view.mode = 'table') }),
		toggle('workbench.actions.workbench.panel.markers.view.toggleErrors', 'Show Errors', () => (view.showErrors = !view.showErrors)),
		toggle('workbench.actions.workbench.panel.markers.view.toggleWarnings', 'Show Warnings', () => (view.showWarnings = !view.showWarnings)),
		toggle('workbench.actions.workbench.panel.markers.view.toggleInfos', 'Show Infos', () => (view.showInfos = !view.showInfos)),
		toggle('workbench.actions.workbench.panel.markers.view.toggleActiveFile', 'Show Active File Only', () => (view.activeFile = !view.activeFile)),
		toggle('workbench.actions.workbench.panel.markers.view.toggleExcludedFiles', 'Hide Excluded Files', () => (view.excludedFiles = !view.excludedFiles)),
		commands.register({ id: 'workbench.actions.treeView.workbench.panel.markers.view.collapseAll', title: 'Collapse All', category: 'Problems', when: () => view.mode === 'tree', run: () => view.collapseAll() }),
		commands.register({
			id: 'problems.action.copy',
			title: 'Copy',
			category: 'Problems',
			key: 'cmd+c',
			when: () => view.selected !== null,
			keyWhen: () => listFocused() && !window.getSelection()?.toString(),
			run: () => view.selected && copy(copyText(view.selected.file, view.selected.item))
		}),
		commands.register({ id: 'problems.action.copyMessage', title: 'Copy Message', category: 'Problems', when: () => view.selected !== null, run: () => view.selected && copy(view.selected.item.message) }),
		commands.register({ id: 'problems.action.open', title: 'Open', category: 'Problems', palette: false, when: () => view.selected !== null, run: () => openSelected(false) }),
		commands.register({ id: 'problems.action.openToSide', title: 'Open to the Side', category: 'Problems', palette: false, key: 'cmd+enter', keyWhen: listFocused, when: () => view.selected !== null, run: () => openSelected(true) }),
		commands.register({
			id: 'problems.action.focusFilter',
			title: 'Focus problems filter',
			category: 'Problems',
			when: problemsShown,
			run: () => (view.focusFilterRequested = true)
		}),
		commands.register({
			id: 'problems.action.focusProblemsFromFilter',
			title: 'Focus problems view',
			category: 'Problems',
			palette: false,
			run: () => view.focusList()
		}),
		commands.register({ id: 'problems.action.clearFilterText', title: 'Clear filters text', category: 'Problems', palette: false, run: () => view.clearFilter() }),
		commands.register({ id: 'problems.action.showMultilineMessage', title: 'Show message in multiple lines', category: 'Problems', when: () => !view.multiline, run: () => (view.multiline = true) }),
		commands.register({ id: 'problems.action.showSinglelineMessage', title: 'Show message in single line', category: 'Problems', when: () => view.multiline, run: () => (view.multiline = false) })
	];
	const stop = $effect.root(() => {
		$effect(() => {
			const order = settings.get<string>('problems.sortOrder');
			untrack(() => void import('#lib/editor/monacoConfiguration.ts').then(({ updateMonacoConfiguration }) => updateMonacoConfiguration([['problems.sortOrder', order]])));
		});
	});
	return () => {
		stop();
		unregister.forEach((u) => u());
	};
}
