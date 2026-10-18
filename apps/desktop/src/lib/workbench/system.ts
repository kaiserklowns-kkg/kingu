import { t } from '#lib/i18n/index.ts';
// Pure helpers for the status bar's resource items (see system.svelte.ts).

export type KeepAwakeMode = 'off' | 'auto' | 'on';

export const KEEP_AWAKE_MODES: { id: KeepAwakeMode; readonly label: string; readonly description: string }[] = [
	{ id: 'on', get label() { return t('workbench.system.keepAwakeOn'); }, get description() { return t('workbench.system.keepAwakeOnDetail'); } },
	{ id: 'auto', get label() { return t('workbench.system.keepAwakeAuto'); }, get description() { return t('workbench.system.keepAwakeAutoDetail'); } },
	{ id: 'off', get label() { return t('workbench.system.keepAwakeOff'); }, get description() { return t('workbench.system.keepAwakeOffDetail'); } }
];

/** `791.1 MB`, `1.2 GB`. */
export function formatBytes(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

export const SAMPLE_LIMIT = 30;

/** Appends a reading, keeping the last `SAMPLE_LIMIT`. */
export function pushSample(samples: number[], value: number, limit = SAMPLE_LIMIT): number[] {
	return [...samples, value].slice(-limit);
}

/** SVG polyline points for a sparkline of `samples` in a `width`×`height` box (flat when < 2). */
export function sparkline(samples: number[], width: number, height: number): string {
	if (samples.length < 2) return `0,${height / 2} ${width},${height / 2}`;
	const min = Math.min(...samples);
	const span = Math.max(...samples) - min || 1;
	const step = width / (samples.length - 1);
	return samples.map((v, i) => `${(i * step).toFixed(1)},${(height - 1 - ((v - min) / span) * (height - 2)).toFixed(1)}`).join(' ');
}

/** Groups terminals by the workspace or worktree they started in: `.kingu/worktrees/<slug>` → `kingu/<slug>`. */
export function terminalGroup(cwd: string, root: string | null): string {
	const m = cwd.match(/\/\.kingu\/worktrees\/([^/]+)/);
	if (m) return `kingu/${m[1]}`;
	if (root && (cwd === root || cwd.startsWith(`${root}/`))) return root.slice(root.lastIndexOf('/') + 1);
	return cwd.slice(cwd.lastIndexOf('/') + 1) || cwd;
}
