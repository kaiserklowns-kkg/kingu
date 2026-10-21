// Transcript commands of the chat view (VS Code's chatFindActions and chatPromptNavigationActions),
// registered with the other chat commands (chatCommands.svelte.ts):
//   workbench.action.chat.find               ⌘F while the chat has focus: Find in Chat
//   workbench.action.chat.findNext / findPrevious   ⌘G / ⇧⌘G (F3 / ⇧F3 elsewhere) while it is open;
//                                            Enter / ⇧Enter in its input
//   workbench.action.chat.hideFind           Escape in the find bar
//   workbench.action.chat.toggleFindCaseSensitive / toggleFindWholeWord / toggleFindRegex
//                                            ⌥⌘C / ⌥⌘W / ⌥⌘R in its input (Alt+C / W / R elsewhere)
//   workbench.action.chat.previousUserPrompt / nextUserPrompt   ⌥⌘↑ / ⌥⌘↓ (Ctrl+Alt elsewhere)
//                                            while the chat has focus: scroll to the request before
//                                            / after, stopping at the first and the last
// ChatTranscriptTools (in the Agent panel) listens to `transcriptSignals`.

import { commands } from '#lib/workbench/commands.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { chatSignals } from './chatCommands.svelte.ts';
import type { FindOptions } from './chatTranscript.ts';

class TranscriptSignals {
	/** Bumped to open the find bar (or refocus it). */
	find = $state(0);
	/** A step through the matches, `n` tells two of them apart. */
	step = $state<{ dir: 1 | -1; n: number } | null>(null);
	hideFind = $state(0);
	toggle = $state<{ key: keyof FindOptions; n: number } | null>(null);
	/** A step through the requests. */
	prompt = $state<{ dir: 1 | -1; n: number } | null>(null);
	/** The find bar is open (set by ChatTranscriptTools). */
	findOpen = $state(false);
}

export const transcriptSignals = new TranscriptSignals();

let n = 0;
const chatFocused = () => chatSignals.hasFocus();
const findShown = () => transcriptSignals.findOpen;

function step(dir: 1 | -1) {
	transcriptSignals.step = { dir, n: ++n };
}

function toggle(key: keyof FindOptions) {
	transcriptSignals.toggle = { key, n: ++n };
}

export function registerTranscriptCommands(): () => void {
	const off = [
		commands.register({
			id: 'workbench.action.chat.find',
			title: 'Find in Chat',
			category: 'Chat',
			key: 'cmd+f',
			keyWhen: chatFocused,
			weight: 100,
			run: () => {
				layout.auxVisible = true;
				transcriptSignals.find++;
			}
		}),
		commands.register({
			id: 'workbench.action.chat.findNext',
			title: 'Find Next in Chat',
			category: 'Chat',
			key: 'f3',
			mac: 'cmd+g',
			when: findShown,
			keyWhen: chatFocused,
			weight: 100,
			run: () => step(1)
		}),
		commands.register({
			id: 'workbench.action.chat.findPrevious',
			title: 'Find Previous in Chat',
			category: 'Chat',
			key: 'shift+f3',
			mac: 'cmd+shift+g',
			when: findShown,
			keyWhen: chatFocused,
			weight: 100,
			run: () => step(-1)
		}),
		commands.register({ id: 'workbench.action.chat.hideFind', title: 'Hide Find in Chat', category: 'Chat', when: findShown, run: () => transcriptSignals.hideFind++ }),
		commands.register({ id: 'workbench.action.chat.toggleFindCaseSensitive', title: 'Toggle Find Case Sensitive in Chat', category: 'Chat', when: findShown, run: () => toggle('caseSensitive') }),
		commands.register({ id: 'workbench.action.chat.toggleFindWholeWord', title: 'Toggle Find Using Whole Word in Chat', category: 'Chat', when: findShown, run: () => toggle('wholeWord') }),
		commands.register({ id: 'workbench.action.chat.toggleFindRegex', title: 'Toggle Find Using Regex in Chat', category: 'Chat', when: findShown, run: () => toggle('regex') }),
		commands.register({
			id: 'workbench.action.chat.previousUserPrompt',
			title: 'Previous User Prompt',
			category: 'Chat',
			key: 'cmd+alt+up',
			keyWhen: chatFocused,
			weight: 100,
			run: () => (transcriptSignals.prompt = { dir: -1, n: ++n })
		}),
		commands.register({
			id: 'workbench.action.chat.nextUserPrompt',
			title: 'Next User Prompt',
			category: 'Chat',
			key: 'cmd+alt+down',
			keyWhen: chatFocused,
			weight: 100,
			run: () => (transcriptSignals.prompt = { dir: 1, n: ++n })
		})
	];
	return () => off.forEach((f) => f());
}
