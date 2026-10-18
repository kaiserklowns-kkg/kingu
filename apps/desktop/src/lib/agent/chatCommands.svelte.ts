// Chat view commands (VS Code's chat actions), in the palette and keybindings.json:
//   workbench.action.chat.open        ⌃⌘I (Ctrl+Alt+I elsewhere): show the chat and focus its input
//   workbench.action.chat.focusInput  ⌘L in the IDE (Cursor's key; the Agents layout keeps its own ⌘L)
//   workbench.action.chat.newChat     ⌘N while the chat has focus (over New Untitled File)
// The panel listens to `chatSignals` (it is mounted once, hidden with the secondary side bar).

import { commands } from '#lib/workbench/commands.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';

class ChatSignals {
	/** Bumped to focus the chat input. */
	focus = $state(0);
	/** Bumped to start a new chat. */
	newChat = $state(0);
	/** The panel's root element, to tell whether the chat has focus. */
	el: HTMLElement | null = null;

	hasFocus(): boolean {
		const active = typeof document !== 'undefined' ? document.activeElement : null;
		return !!this.el && !!active && this.el.contains(active);
	}
}

export const chatSignals = new ChatSignals();

function show() {
	if (appMode.isAgents) appMode.setMode('workbench');
	layout.auxVisible = true;
}

export function registerChatCommands(): () => void {
	const off = [
		commands.register({
			id: 'workbench.action.chat.open',
			title: 'Open Chat',
			category: 'Chat',
			key: 'ctrl+alt+i',
			mac: 'ctrl+cmd+i',
			run: () => {
				show();
				chatSignals.focus++;
			}
		}),
		commands.register({
			id: 'workbench.action.chat.focusInput',
			title: 'Focus Chat Input',
			category: 'Chat',
			key: 'cmd+l',
			keyWhen: () => !appMode.isAgents,
			run: () => {
				show();
				chatSignals.focus++;
			}
		}),
		commands.register({
			id: 'workbench.action.chat.newChat',
			title: 'New Chat',
			category: 'Chat',
			key: 'cmd+n',
			keyWhen: () => chatSignals.hasFocus(),
			weight: 100,
			run: () => {
				show();
				chatSignals.newChat++;
			}
		})
	];
	return () => off.forEach((f) => f());
}
