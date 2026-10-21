// A task's runtime from its agent CLI's status evidence, for the open folder (cliSessions) and
// for the other added projects (projects.svelte.ts) alike. Pure, so `bun test` covers it.

import type { HookState } from './agentHooks';
import { needsInput } from './agentHooks';
import { cliName } from './agentCli';
import { hookFresh } from './agentPresence';
import type { TitleTrack } from './agentTitle';
import type { TaskRuntime } from './model';
import { profileOf } from '#lib/ade/agentProfiles.ts';
import { t } from '#lib/i18n/index.ts';

/**
 * What is known of a task's agent CLI. `working`: it printed in the last moments; `lastOutput`:
 * when it last printed. Another project's CLI has neither, nor a title (its terminal is not
 * mounted): its hooks alone tell.
 */
export type CliEvidence = { run: string[]; hook?: HookState; title?: TitleTrack; working: boolean; lastOutput?: number; now: number };

/**
 * Status evidence, best first (Orca's order): hooks that report (and have not gone silent while
 * "working" for 30 minutes), then the terminal's title (spinner / idle glyphs), then "printing =
 * working". A CLI whose process is gone has ended (its hooks say so).
 */
export function cliTaskRuntime(slug: string, e: CliEvidence): TaskRuntime {
	// claude reports its state through hooks, and so do CLIs with Kingu's status hooks once their
	// hooks report; before that (or without them) the title, else output (codex's notify adds the
	// session id and the turn's last answer).
	const { hook, title, run } = e;
	if (hook && hook.phase !== 'starting' && (profileOf(run).status === 'hooks' || hook.hooks) && hookFresh(hook, e.now)) {
		const working = hook.phase === 'working';
		const attention = needsInput(hook);
		return {
			slug,
			status: attention ? 'waiting' : working ? 'running' : 'review',
			runStatus: attention ? 'waiting' : working ? 'running' : hook.phase === 'ended' ? 'done' : 'idle',
			live: hook.phase !== 'ended',
			working,
			lastEvent: hook.message,
			pendingPermissions: hook.permission && hook.phase === 'waiting' ? 1 : 0,
			question: hook.question && hook.phase === 'waiting',
			sessionId: hook.sessionId ?? null,
			updatedAt: hook.at
		};
	}
	if (title?.status) {
		const working = title.status === 'working';
		const attention = title.status === 'permission';
		return {
			slug,
			status: attention ? 'waiting' : working ? 'running' : 'review',
			runStatus: attention ? 'waiting' : working ? 'running' : 'idle',
			live: true,
			working,
			lastEvent: t(attention ? 'ade.cli.needsAnswer' : working ? 'ade.cli.working' : 'ade.cli.waiting', { cli: cliName(run) }),
			pendingPermissions: attention ? 1 : 0,
			sessionId: hook?.sessionId ?? null,
			updatedAt: Math.max(title.at, e.lastOutput ?? 0)
		};
	}
	const working = e.working;
	return {
		slug,
		status: working ? 'running' : 'review',
		runStatus: working ? 'running' : 'idle',
		live: true,
		working,
		lastEvent: working ? t('ade.cli.working', { cli: cliName(run) }) : (hook?.message ?? t('ade.cli.waiting', { cli: cliName(run) })),
		pendingPermissions: 0,
		sessionId: hook?.sessionId ?? null,
		updatedAt: e.lastOutput
	};
}
