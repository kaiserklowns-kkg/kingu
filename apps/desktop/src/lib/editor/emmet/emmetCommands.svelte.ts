// The Emmet commands of the palette (VS Code's `Emmet:` category). They are registered at start;
// the Emmet code (and the `emmet` package) loads on first use, like Monaco itself.

import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';

const run = (id: string) => () => import('./emmet.svelte.ts').then((m) => m.EMMET_ACTIONS[id]?.());

/** Registers the Emmet commands; returns the unregister function. */
export function installEmmetCommands(): () => void {
	const textEditor = () => editors.active !== null;
	const unregister = [
		commands.register({ id: 'editor.emmet.action.expandAbbreviation', title: 'Expand Abbreviation', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.expandAbbreviation') }),
		commands.register({ id: 'editor.emmet.action.wrapWithAbbreviation', title: 'Wrap with Abbreviation', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.wrapWithAbbreviation') }),
		commands.register({ id: 'editor.emmet.action.removeTag', title: 'Remove Tag', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.removeTag') }),
		commands.register({ id: 'editor.emmet.action.updateTag', title: 'Update Tag', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.updateTag') }),
		commands.register({ id: 'editor.emmet.action.matchTag', title: 'Go to Matching Pair', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.matchTag') }),
		commands.register({ id: 'editor.emmet.action.balanceIn', title: 'Balance (inward)', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.balanceIn') }),
		commands.register({ id: 'editor.emmet.action.balanceOut', title: 'Balance (outward)', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.balanceOut') }),
		commands.register({ id: 'editor.emmet.action.prevEditPoint', title: 'Go to Previous Edit Point', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.prevEditPoint') }),
		commands.register({ id: 'editor.emmet.action.nextEditPoint', title: 'Go to Next Edit Point', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.nextEditPoint') }),
		commands.register({ id: 'editor.emmet.action.mergeLines', title: 'Merge Lines', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.mergeLines') }),
		commands.register({ id: 'editor.emmet.action.selectPrevItem', title: 'Select Previous Item', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.selectPrevItem') }),
		commands.register({ id: 'editor.emmet.action.selectNextItem', title: 'Select Next Item', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.selectNextItem') }),
		commands.register({ id: 'editor.emmet.action.splitJoinTag', title: 'Split/Join Tag', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.splitJoinTag') }),
		commands.register({ id: 'editor.emmet.action.toggleComment', title: 'Toggle Comment', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.toggleComment') }),
		commands.register({ id: 'editor.emmet.action.evaluateMathExpression', title: 'Evaluate Math Expression', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.evaluateMathExpression') }),
		commands.register({ id: 'editor.emmet.action.incrementNumberByOneTenth', title: 'Increment by 0.1', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.incrementNumberByOneTenth') }),
		commands.register({ id: 'editor.emmet.action.incrementNumberByOne', title: 'Increment by 1', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.incrementNumberByOne') }),
		commands.register({ id: 'editor.emmet.action.incrementNumberByTen', title: 'Increment by 10', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.incrementNumberByTen') }),
		commands.register({ id: 'editor.emmet.action.decrementNumberByOneTenth', title: 'Decrement by 0.1', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.decrementNumberByOneTenth') }),
		commands.register({ id: 'editor.emmet.action.decrementNumberByOne', title: 'Decrement by 1', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.decrementNumberByOne') }),
		commands.register({ id: 'editor.emmet.action.decrementNumberByTen', title: 'Decrement by 10', category: 'Emmet', when: textEditor, run: run('editor.emmet.action.decrementNumberByTen') }),
		commands.register({ id: 'workbench.action.showEmmetCommands', title: 'Show Emmet Commands', run: () => quick.show('>Emmet: ') })
	];
	return () => unregister.forEach((u) => u());
}
