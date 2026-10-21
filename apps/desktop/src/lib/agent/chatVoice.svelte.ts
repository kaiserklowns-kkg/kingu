// Dictation into the chat input (VS Code's chatSpeechToTextActions) with Kingu's own engine
// (voice/dictation.svelte.ts, the kingu.voice.* settings): the composer's microphone button and
//   workbench.action.chat.toggleSpeechToText   Dictate (Speech to Text): start, or stop and insert
//   workbench.action.chat.startVoiceChat       start dictating into the chat input
//   workbench.action.chat.stopListening        stop and insert the text
//   workbench.action.chat.cancelSpeechToText   stop and drop the recording
// The engine transcribes when the recording stops (whisper.cpp or OpenAI take a whole file), so
// the text arrives in one piece at the caret where the input had it. No default keys: ⌘I is
// Inline Chat here, and Voice: Dictation (⌥⌘V) already dictates into the focused chat input.

import { commands } from '#lib/workbench/commands.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { dictation } from '#lib/voice/dictation.svelte.ts';

export const TOGGLE_DICTATION = 'workbench.action.chat.toggleSpeechToText';

/** Whether the composer shows its microphone (VS Code shows it once dictation is set up). */
export const chatDictationShown = () => settings.get<boolean>('kingu.voice.enabled') === true;

/**
 * The microphone button: `focus` puts the caret back in the input first, so the text goes there
 * (the dictation targets whatever has focus when it starts).
 */
export function toggleChatDictation(focus: () => void) {
	if (dictation.state === 'listening') return void dictation.stop();
	if (dictation.state !== 'idle') return;
	focus();
	void dictation.shortcut(false);
}

/** `show`: reveal the chat and focus its input; `inChat`: the input has focus now. */
export function registerChatVoiceCommands(show: () => void, inChat: () => boolean): () => void {
	/** Starts once the input has focus (the panel may first have to open). */
	const start = () => {
		if (dictation.state !== 'idle') return;
		show();
		setTimeout(() => inChat() && void dictation.shortcut(false), 50);
	};
	const off = [
		commands.register({
			id: TOGGLE_DICTATION,
			title: 'Dictate (Speech to Text)',
			category: 'Chat',
			run: () => (dictation.state === 'listening' ? dictation.stop() : start())
		}),
		commands.register({ id: 'workbench.action.chat.startVoiceChat', title: 'Start Dictation in Chat', category: 'Chat', when: () => dictation.state === 'idle', run: start }),
		commands.register({ id: 'workbench.action.chat.stopListening', title: 'Stop Dictation', category: 'Chat', when: () => dictation.state === 'listening', run: () => dictation.stop() }),
		commands.register({ id: 'workbench.action.chat.cancelSpeechToText', title: 'Cancel Dictation (Speech to Text)', category: 'Chat', when: () => dictation.state === 'listening', run: () => dictation.cancel() })
	];
	return () => off.forEach((f) => f());
}
