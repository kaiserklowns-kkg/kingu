// Voice dictation (Orca's Voice pane and DictationController): the shortcut records the
// microphone, and on stop the recording becomes text (Rust voice.rs: whisper.cpp on this
// computer, or OpenAI with your Keychain key) that goes where the focus was when it started.
// Nothing of it goes to the team server.
//   installVoice()       the commands, returns the uninstall function
//   dictation.state      idle / starting / listening / transcribing (DictationIndicator.svelte)

import { invoke } from '@tauri-apps/api/core';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { ask } from '#lib/workbench/messageBox.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { elapsed, micConstraints, micErrorKey, onShortcut, voiceOptions, type DictationMode, type DictationState } from './dictation.ts';
import { captureTarget, insertText, type InsertTarget } from './target.ts';
import { concat, encodeWav, level, MAX_SECONDS, resample, toBase64 } from './wav.ts';

export const DICTATION_COMMAND = 'kingu.voice.dictation';
/** Orca's key for it, in the Agents layout. */
export const ADE_DICTATION_COMMAND = 'kingu.ade.voice.dictation';
/** A keybinding ran the command this recently (ms): hold mode then stops on the key's release. */
const KEY_RUN_MS = 150;

class Dictation {
	state = $state<DictationState>('idle');
	startedAt = $state(0);
	now = $state(0);
	level = $state(0);
	elapsed = $derived(elapsed(this.now - this.startedAt));

	#target: InsertTarget | null = null;
	#stream: MediaStream | null = null;
	#context: AudioContext | null = null;
	#chunks: Float32Array[] = [];
	#rate = 48_000;
	#timer: ReturnType<typeof setInterval> | null = null;
	/** Hold mode: the key went up before the microphone opened. */
	#releasedEarly = false;
	#holding = false;

	get mode(): DictationMode {
		return settings.get<string>('kingu.voice.dictationMode') === 'hold' ? 'hold' : 'toggle';
	}

	/** The shortcut (or the palette). */
	async shortcut(byKey: boolean) {
		if (settings.get<boolean>('kingu.voice.enabled') !== true) {
			notifications.info(t('voice.disabled'), { actions: [{ label: t('voice.openSettings'), run: () => systemSettings.showPage('voice') }] });
			return;
		}
		const action = onShortcut(this.state, byKey ? this.mode : 'toggle');
		if (action === 'start') await this.start(byKey && this.mode === 'hold');
		else if (action === 'stop') await this.stop();
	}

	/** The key of a hold-mode dictation went up. */
	release() {
		if (!this.#holding) return;
		this.#holding = false;
		if (this.state === 'starting') this.#releasedEarly = true;
		else if (this.state === 'listening') void this.stop();
	}

	async start(hold = false) {
		if (this.state !== 'idle') return;
		this.#target = captureTarget();
		this.#holding = hold;
		this.#releasedEarly = false;
		this.state = 'starting';
		try {
			this.#stream = await openMic(settings.get<string>('kingu.voice.microphone') ?? '');
		} catch (e) {
			this.#reset();
			notifications.error(t(micErrorKey(e)));
			return;
		}
		const ctx = new AudioContext();
		this.#context = ctx;
		this.#rate = ctx.sampleRate;
		this.#chunks = [];
		const source = ctx.createMediaStreamSource(this.#stream);
		// ScriptProcessor (as Orca): an AudioWorklet would need a module URL the app's CSP allows.
		const node = ctx.createScriptProcessor(4096, 1, 1);
		node.onaudioprocess = (e) => {
			const samples = new Float32Array(e.inputBuffer.getChannelData(0));
			this.#chunks.push(samples);
			this.level = level(samples);
		};
		source.connect(node);
		node.connect(ctx.destination);
		this.startedAt = this.now = Date.now();
		this.state = 'listening';
		this.#timer = setInterval(() => {
			this.now = Date.now();
			if (this.now - this.startedAt >= MAX_SECONDS * 1000) void this.stop();
		}, 250);
		if (this.#releasedEarly) void this.stop();
	}

	/** Stops recording and puts the text where the focus was. */
	async stop() {
		if (this.state !== 'listening') return;
		const samples = concat(this.#chunks);
		const rate = this.#rate;
		const target = this.#target;
		this.#closeMic();
		this.state = 'transcribing';
		try {
			if (samples.length < rate / 4) return void status.flash(t('voice.tooShort'));
			const audio = toBase64(encodeWav(resample(samples, rate)));
			const text = (await invoke<string>('voice_transcribe', { audio, options: voiceOptions((k) => settings.get(k)) })).trim();
			if (!text) return void status.flash(t('voice.nothingHeard'));
			await deliver(target, text);
		} catch (e) {
			notifications.error(t('voice.error.transcribe', { error: String(e) }), { actions: [{ label: t('voice.openSettings'), run: () => systemSettings.showPage('voice') }] });
		} finally {
			this.#reset();
		}
	}

	/** Drops the recording. */
	cancel() {
		if (this.state === 'listening' || this.state === 'starting') this.#reset();
	}

	#closeMic() {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
		this.#stream?.getTracks().forEach((tr) => tr.stop());
		this.#stream = null;
		void this.#context?.close().catch(() => {});
		this.#context = null;
		this.#chunks = [];
		this.level = 0;
	}

	#reset() {
		this.#closeMic();
		this.#target = null;
		this.#holding = false;
		this.state = 'idle';
	}
}

/** The chosen microphone, else (unplugged, renamed) the system default. */
async function openMic(deviceId: string): Promise<MediaStream> {
	if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('no mediaDevices', 'NotSupportedError');
	try {
		return await navigator.mediaDevices.getUserMedia(micConstraints(deviceId, true));
	} catch (e) {
		if (!deviceId || micErrorKey(e) !== 'voice.error.noMic') throw e;
		return navigator.mediaDevices.getUserMedia(micConstraints('', false));
	}
}

/** Into the target (asking first for a terminal when kingu.voice.terminalConfirmBeforeInsert), else onto the clipboard. */
async function deliver(target: InsertTarget | null, text: string) {
	if (target?.kind === 'terminal' && settings.get<boolean>('kingu.voice.terminalConfirmBeforeInsert') === true) {
		if (!(await ask(t('voice.confirmTerminal', { text }), { title: t('voice.title'), okLabel: t('voice.insert') }))) return;
	}
	if (target && insertText(target, text)) return;
	await navigator.clipboard?.writeText(text).catch(() => {});
	status.flash(t('voice.copied'), 6000);
}

export const dictation = new Dictation();

export function installVoice(): () => void {
	const run = (id: string) => () => {
		const k = commands.lastKeyRun;
		return dictation.shortcut(!!k && k.id === id && performance.now() - k.at < KEY_RUN_MS);
	};
	const onKeyUp = () => dictation.release();
	const onBlur = () => dictation.release();
	window.addEventListener('keyup', onKeyUp, true);
	window.addEventListener('blur', onBlur);
	const unregister = [
		// VS Code's Editor Dictation key (⌥⌘V); Orca's ⌘E in the Agents layout.
		commands.register({ id: DICTATION_COMMAND, title: 'Voice: Dictation', key: 'cmd+alt+v', run: run(DICTATION_COMMAND) }),
		commands.register({ id: ADE_DICTATION_COMMAND, title: 'Voice: Dictation', mac: 'cmd+e', scope: 'agents', palette: false, run: run(ADE_DICTATION_COMMAND) }),
		commands.register({ id: 'kingu.voice.cancel', title: 'Voice: Cancel Dictation', when: () => dictation.state === 'listening', run: () => dictation.cancel() }),
		commands.register({ id: 'kingu.voice.settings', title: 'Voice: Open Voice Settings', run: () => systemSettings.showPage('voice') })
	];
	return () => {
		window.removeEventListener('keyup', onKeyUp, true);
		window.removeEventListener('blur', onBlur);
		dictation.cancel();
		unregister.forEach((u) => u());
	};
}
