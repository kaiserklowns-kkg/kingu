// Chat view commands (VS Code's chat actions), in the palette and keybindings.json:
//   workbench.action.chat.open        ⌃⌘I (Ctrl+Alt+I elsewhere): show the chat and focus its input
//   workbench.action.chat.focusInput  ⌘L in the IDE (Cursor's key; the Agents layout keeps its own ⌘L)
//   workbench.action.chat.newChat     ⌘N while the chat has focus (over New Untitled File)
//   workbench.action.chat.attachContext  ⌥⌘P while the chat has focus: Add Context... (Cursor's key;
//                                     ⌘/ is the composer's model picker there)
//   kingu.chat.nextMode               ⌘. while the chat has focus: the next mode (Agent, Ask, Plan,
//                                     custom agents; ⇧Tab in the input too)
//   kingu.chat.openModelPicker        ⌘/ while the chat has focus: the composer's model picker
//   kingu.chat.cancel                 Cancel Chat: stop the running turn (⌘⇧⌫ / ⌃C in the input)
//   workbench.action.chat.export / .import  Export Chat... (JSON) / Import Chat...
//   workbench.action.chat.toggleSpeechToText and the other dictation commands (chatVoice.svelte.ts)
// The panel listens to `chatSignals` (it is mounted once, hidden with the secondary side bar).

import { commands } from '#lib/workbench/commands.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { registerCustomizeCommands } from './chatCustomizeCommands.ts';
import { registerInlineChatCommands } from './inlineChat.svelte.ts';
import { registerChatVoiceCommands } from './chatVoice.svelte.ts';

class ChatSignals {
	/** Bumped to focus the chat input. */
	focus = $state(0);
	/** Bumped to start a new chat. */
	newChat = $state(0);
	/** Bumped to open Add Context. */
	addContext = $state(0);
	/** Bumped to switch the composer to its next mode / open its model picker / stop the turn. */
	nextMode = $state(0);
	modelPicker = $state(0);
	cancel = $state(0);
	/** Bumped to export the shown chat / import one. */
	exportChat = $state(0);
	importChat = $state(0);
	/** A chat to show (a clicked notification); `n` tells two requests for the same chat apart. */
	open = $state<{ id: string; n: number } | null>(null);
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

/** Shows the chat panel with chat `id` of the open folder selected. */
export function openChat(id: string) {
	show();
	chatSignals.open = { id, n: (chatSignals.open?.n ?? 0) + 1 };
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
		}),
		commands.register({
			id: 'workbench.action.chat.attachContext',
			title: 'Add Context...',
			category: 'Chat',
			key: 'ctrl+alt+p',
			mac: 'cmd+alt+p',
			keyWhen: () => chatSignals.hasFocus(),
			weight: 100,
			run: () => {
				show();
				chatSignals.addContext++;
			}
		}),
		commands.register({
			id: 'kingu.chat.nextMode',
			title: 'Switch to the Next Chat Mode',
			category: 'Chat',
			key: 'ctrl+.',
			mac: 'cmd+.',
			keyWhen: () => chatSignals.hasFocus(),
			weight: 100,
			run: () => {
				show();
				chatSignals.nextMode++;
			}
		}),
		commands.register({
			id: 'kingu.chat.openModelPicker',
			title: 'Open the Chat Model Picker',
			category: 'Chat',
			key: 'ctrl+/',
			mac: 'cmd+/',
			keyWhen: () => chatSignals.hasFocus(),
			weight: 100,
			run: () => {
				show();
				chatSignals.modelPicker++;
			}
		}),
		commands.register({
			id: 'kingu.chat.cancel',
			title: 'Cancel Chat',
			category: 'Chat',
			run: () => chatSignals.cancel++
		}),
		commands.register({
			id: 'workbench.action.chat.export',
			title: 'Export Chat...',
			category: 'Chat',
			run: () => {
				show();
				chatSignals.exportChat++;
			}
		}),
		commands.register({
			id: 'workbench.action.chat.import',
			title: 'Import Chat...',
			category: 'Chat',
			run: () => {
				show();
				chatSignals.importChat++;
			}
		})
	];
	// Prompt files, custom agents, instructions (chatCustomizeCommands.ts).
	off.push(registerCustomizeCommands());
	// ⌘I in the editor and the terminal (inlineChat.svelte.ts).
	off.push(registerInlineChatCommands());
	// Dictation into the chat input (chatVoice.svelte.ts).
	off.push(
		registerChatVoiceCommands(
			() => {
				show();
				chatSignals.focus++;
			},
			() => chatSignals.hasFocus()
		)
	);
	return () => off.forEach((f) => f());
}
