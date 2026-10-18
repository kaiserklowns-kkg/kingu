// App-level attention outside the window, and the board following pull requests:
// - the dock badge (Orca's unread dock badge, `app.dock.setBadge`): how many agents and tasks wait
//   on you (`adeTasks.badgeCount`, the title bar's "needs you" count), set through Rust
//   `app_badge` (Tauri's badge label on macOS, `99+` past 99);
// - `kingu.board.autoStatus`: a task whose PR opens moves to In review, one whose PR merges to
//   Done (workflow.ts `autoWorkflow`, forward only), when that PR state is first seen this session.

import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { settings } from '#lib/settings/settings.svelte.ts';
import { clientLog } from '#lib/client-log.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { adeTasks } from './tasks.svelte';
import { prStatuses } from './prStatus.svelte';
import { autoWorkflow, workflowOf, workflowStatuses } from './workflow.ts';

export function installAdeAttention(): () => void {
	let shown = -1;
	/** The PR state each task was last moved for, so moving a card back by hand sticks. */
	const seen = new Map<string, string>();
	const stop = $effect.root(() => {
		$effect(() => {
			const count = adeTasks.badgeCount;
			if (count === shown) return;
			shown = count;
			void invoke('app_badge', { count }).catch((e) => clientLog('info', `app badge: ${e}`));
		});
		$effect(() => {
			const prs = adeTasks.list.map((m) => ({ slug: m.slug, state: prStatuses.bySlug[m.slug]?.pr?.state ?? null, merged: !!m.merged_at }));
			untrack(() => {
				if (settings.get<boolean>('kingu.board.autoStatus') === false) return;
				const statuses = workflowStatuses(settings.get('kingu.board.statuses'));
				for (const pr of prs) {
					const state = pr.merged ? 'MERGED' : (pr.state ?? '');
					const task = `${workspace.root}\n${pr.slug}`;
					if (!state || seen.get(task) === state) continue;
					seen.set(task, state);
					const meta = adeTasks.list.find((m) => m.slug === pr.slug);
					const next = meta && autoWorkflow(workflowOf(meta, statuses), pr, statuses);
					if (next) void adeTasks.setWorkflowStatus(pr.slug, next, true);
				}
			});
		});
	});
	return () => {
		stop();
		void invoke('app_badge', { count: 0 }).catch(() => {});
	};
}
