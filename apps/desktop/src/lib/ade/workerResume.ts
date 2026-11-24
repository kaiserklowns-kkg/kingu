// Which task agents to offer back after Kingu's exit took their terminals (workerResume.svelte.ts). Pure.

import type { TaskStatus } from './model.ts';

/** The tasks of `gone` CLIs worth reopening: still listed and not finished, each once. */
export function workersToReopen(gone: readonly string[], tasks: readonly { slug: string; status: TaskStatus }[]): string[] {
	return [...new Set(gone)].filter((slug) => tasks.some((x) => x.slug === slug && x.status !== 'done'));
}
