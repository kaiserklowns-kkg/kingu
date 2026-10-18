// Plays accessibility signals: task status changes (agent waits for you, finished, failed) and,
// in `all` mode, errors. Tones are synthesized with Web Audio, so there are no sound files.
import { adeTasks } from '#lib/ade/tasks.svelte.ts';
import type { TaskStatus } from '#lib/ade/model.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { plays, taskSignal, TONES, type Signal, type SignalsMode } from './signals';

let audio: AudioContext | null = null;

export function playSignal(signal: Signal) {
	const mode = (settings.get<string>('kingu.accessibility.signals') ?? 'agents') as SignalsMode;
	if (!plays(mode, signal)) return;
	try {
		audio ??= new AudioContext();
		const t0 = audio.currentTime + 0.01;
		for (const [freq, start, length] of TONES[signal]) {
			const osc = audio.createOscillator();
			const gain = audio.createGain();
			osc.type = 'sine';
			osc.frequency.value = freq;
			// A soft attack and decay so the tones never click.
			gain.gain.setValueAtTime(0, t0 + start);
			gain.gain.linearRampToValueAtTime(0.12, t0 + start + 0.015);
			gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + length);
			osc.connect(gain).connect(audio.destination);
			osc.start(t0 + start);
			osc.stop(t0 + start + length + 0.02);
		}
	} catch {
		// No audio device: signals are a convenience.
	}
}

/** Watches task statuses for the life of the workbench; returns the cleanup. */
export function installSignals(): () => void {
	const last = new Map<string, TaskStatus>();
	return $effect.root(() => {
		$effect(() => {
			for (const v of adeTasks.views) {
				const signal = taskSignal(last.get(v.meta.slug), v.status);
				last.set(v.meta.slug, v.status);
				if (signal) playSignal(signal);
			}
		});
	});
}
