// Dictation's rules, apart from the microphone and the window (dictation.svelte.ts runs them).

export type DictationState = 'idle' | 'starting' | 'listening' | 'transcribing';
export type DictationMode = 'toggle' | 'hold';

/** What Rust's `voice_transcribe` takes (voice.rs Options), from the `kingu.voice.*` settings. */
export type VoiceOptions = { engine: string; openaiModel: string; language: string; localModel: string; whisperPath: string };

export function voiceOptions(get: <T>(key: string) => T | undefined): VoiceOptions {
	const str = (key: string, fallback = '') => {
		const v = get<string>(key);
		return typeof v === 'string' ? v.trim() : fallback;
	};
	return {
		engine: str('kingu.voice.engine', 'local') || 'local',
		openaiModel: str('kingu.voice.openaiModel'),
		language: str('kingu.voice.language', 'auto') || 'auto',
		localModel: str('kingu.voice.localModel'),
		whisperPath: str('kingu.voice.whisperPath')
	};
}

/** The shortcut's effect: start from idle; stop while listening in toggle mode (hold stops on release). */
export function onShortcut(state: DictationState, mode: DictationMode): 'start' | 'stop' | 'ignore' {
	if (state === 'idle') return 'start';
	if (state === 'listening' && mode === 'toggle') return 'stop';
	return 'ignore';
}

/**
 * The chat input's microphone (always shown, like VS Code's `mic-compact` in the execute toolbar):
 * with dictation off it opens the Voice settings to turn it on; otherwise it starts from idle and
 * stops while listening.
 */
export function onMicButton(enabled: boolean, state: DictationState): 'settings' | 'start' | 'stop' | 'ignore' {
	if (state === 'listening') return 'stop';
	if (state !== 'idle') return 'ignore';
	return enabled ? 'start' : 'settings';
}

/** `m:ss`. */
export function elapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Why the microphone did not open, as a message key (getUserMedia's DOMException names). */
export function micErrorKey(e: unknown): 'voice.error.micDenied' | 'voice.error.noMic' | 'voice.error.micBusy' | 'voice.error.micUnavailable' {
	const name = e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
	if (name === 'NotAllowedError' || name === 'SecurityError') return 'voice.error.micDenied';
	if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'voice.error.noMic';
	if (name === 'NotReadableError' || name === 'AbortError') return 'voice.error.micBusy';
	return 'voice.error.micUnavailable';
}

/** The constraints for `deviceId` ('' is the system default); `exact` fails over to the default (see dictation.svelte.ts). */
export function micConstraints(deviceId: string, exact: boolean): MediaStreamConstraints {
	const base = { channelCount: 1, echoCancellation: true, noiseSuppression: true };
	return { audio: deviceId && exact ? { ...base, deviceId: { exact: deviceId } } : base, video: false };
}
