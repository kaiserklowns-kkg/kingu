// Accessibility signals (VS Code's accessibility.signals.*, Orca's notification sounds): which
// task status changes deserve a sound, and the short tones to play. Pure, so it is unit-testable.
import type { TaskStatus } from '#lib/ade/model.ts';

export type Signal = 'attention' | 'done' | 'failed' | 'error';
export type SignalsMode = 'off' | 'agents' | 'all';

/** The sound for a task going from `before` to `after`, or null. A task seen for the first time is silent. */
export function taskSignal(before: TaskStatus | undefined, after: TaskStatus): Signal | null {
	if (before === undefined || before === after) return null;
	if (after === 'waiting') return 'attention';
	if (after === 'failed') return 'failed';
	if (before === 'running' && (after === 'review' || after === 'done')) return 'done';
	return null;
}

export const plays = (mode: SignalsMode, signal: Signal) => mode === 'all' || (mode === 'agents' && signal !== 'error');

/** Notes as [frequency Hz, start s, length s]: rising for attention, a chord for done, falling for failures. */
export const TONES: Record<Signal, [number, number, number][]> = {
	attention: [
		[660, 0, 0.12],
		[880, 0.13, 0.16]
	],
	done: [
		[523, 0, 0.18],
		[659, 0.07, 0.18],
		[784, 0.14, 0.24]
	],
	failed: [
		[440, 0, 0.16],
		[330, 0.17, 0.24]
	],
	error: [[300, 0, 0.14]]
};
