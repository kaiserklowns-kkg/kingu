// Best-of-N attempts, stacked worktrees and agent hibernation, on top of adeTasks:
// - createAttempts: one prompt as 1-4 tasks `<slug>-a`, `-b`… sharing a group id, each with its
//   own model; compare their diff stats side by side (AttemptsCompare.svelte) and Pick winner,
//   which keeps that one and offers the others to Clean Up Tasks.
// - New Task from This Task: a task forked from another task's branch (its PR goes into it).
// - Hibernation (kingu.agent.hibernation, experimental, off by default): idle finished agent CLIs
//   are closed every minute by the planner in hibernation.ts; the task resumes its session.

import { untrack } from 'svelte';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { clientLog } from '#lib/client-log.ts';
import { t } from '#lib/i18n/index.ts';
import { adeLayout } from './adeLayout.svelte';
import { adeTasks } from './tasks.svelte';
import { adeDialogs } from './dialogs.svelte.ts';
import { cleanup } from './cleanup.svelte';
import { cliSessions } from './cliSessions.svelte';
import { cliOf } from './agentCli';
import { profileOf } from './agentProfiles';
import { attemptLetter, attemptSlugs, losersOf, MAX_ATTEMPTS, validModel } from './attempts';
import { hibernationCandidates, idleMs, TICK_MS, type HibernationRow } from './hibernation';
import type { TaskMeta } from './model';

class Attempts {
	/** New Task from This Task: the task whose branch the New Task form forks from. */
	stackOn = $state<string | null>(null);

	/**
	 * Best-of-N: creates one task per model (`''` = the agent's default) from the same prompt, in
	 * worktrees `<group>-a`, `<group>-b`…; opens the first. The slug of the first, or undefined
	 * when none was created.
	 */
	async createAttempts(input: { title: string; prompt: string; base: string; models: string[] }): Promise<string | undefined> {
		const title = input.title.trim();
		const models = input.models.slice(0, MAX_ATTEMPTS).map((m) => m.trim());
		if (!title || !models.length) return;
		const bad = models.find((m) => m && !validModel(m));
		if (bad) {
			status.flash(t('adeAttempts.badModel', { model: bad }), 8000);
			return;
		}
		const taken = new Set([...adeTasks.list.map((x) => x.slug), ...adeTasks.worktrees.map((w) => w.slug ?? '')]);
		const { group, slugs } = attemptSlugs(title, models.length, taken);
		let first: string | undefined;
		// One after another: each worktree, setup script and agent start in turn (git_queue keeps git serial anyway).
		for (const [i, slug] of slugs.entries()) {
			const letter = slug.slice(-1).toUpperCase();
			const created = await adeTasks.create({
				title: `${[...title].slice(0, 190).join('')} · ${letter}`,
				prompt: input.prompt.trim() || title,
				base: input.base,
				slug,
				group,
				model: models[i] || undefined,
				open: first === undefined
			});
			if (created && first === undefined) first = created;
		}
		if (first) status.flash(t('adeAttempts.started', { count: slugs.length, title }), 6000);
		return first;
	}

	/** The compare view of the task's group. */
	compare(slug: string) {
		const group = adeTasks.find(slug)?.meta.group;
		if (group) adeDialogs.open({ kind: 'compare', group });
	}

	/** Pick winner: the attempt leaves its group; the other attempts are offered to Clean Up Tasks. */
	async pickWinner(slug: string) {
		const meta = adeTasks.find(slug)?.meta;
		if (!meta?.group) return;
		const losers = losersOf(adeTasks.list, slug);
		await adeTasks.leaveGroup(slug);
		adeDialogs.close();
		status.flash(t('adeAttempts.winner', { title: meta.title }), 6000);
		if (losers.length) cleanup.offer(losers);
	}

	/** New Task from This Task: the New Task form, forking from the task's branch. */
	newFromTask(slug: string) {
		if (!adeTasks.find(slug)) return;
		this.stackOn = slug;
		adeTasks.openBoard();
		adeTasks.composing = true;
	}

	/** A task stacked on `parent`: a new branch from the parent's branch; its PR goes into that branch. */
	async createStacked(parent: string, input: { title: string; prompt: string }): Promise<string | undefined> {
		const view = adeTasks.find(parent);
		if (!view) return;
		// The parent's uncommitted work is not on its branch, so the new task starts without it.
		if (view.stat?.dirty) status.flash(t('adeAttempts.parentDirty', { title: view.meta.title }), 8000);
		const created = await adeTasks.create({ title: input.title, prompt: input.prompt, base: adeTasks.branchOf(parent), parent });
		if (created) this.stackOn = null;
		return created;
	}
}

export const attempts = new Attempts();

/** The task's CLI can continue its saved session after hibernation. */
const resumable = (meta: TaskMeta) => {
	const cli = cliOf(meta.agent);
	return !!cli && !!meta.session_id && profileOf(cli).canResume;
};

/** Commands, and the hibernation coordinator while kingu.agent.hibernation is on. */
export function installAttempts(): () => void {
	/** When each CLI's terminal was last on screen. */
	const seen: Record<string, number> = {};
	const shown = () => (appMode.isAgents && !adeLayout.board && adeLayout.activeTab(adeLayout.key) === 'main' && document.visibilityState === 'visible' ? adeLayout.key : null);
	let timer: ReturnType<typeof setInterval> | undefined;
	const tick = () => {
		const now = Date.now();
		const front = shown();
		if (front) seen[front] = now;
		const rows: HibernationRow[] = Object.keys(cliSessions.sessions).flatMap((slug) => {
			const meta = adeTasks.find(slug)?.meta;
			if (!meta) return [];
			const hook = cliSessions.hooks[slug];
			return [
				{
					slug,
					phase: hook?.phase,
					waiting: !!hook && (hook.permission || hook.question || hook.phase === 'waiting'),
					ended: cliSessions.ended(slug),
					resumable: resumable(meta),
					foreground: front === slug,
					hookAt: hook?.at,
					outputAt: cliSessions.lastOutput(slug),
					seenAt: seen[slug]
				}
			];
		});
		for (const slug of hibernationCandidates(rows, now, idleMs(settings.get<number>('kingu.agent.hibernationIdleMinutes')))) {
			clientLog('info', `hibernating the idle agent CLI of ${slug}`);
			void adeTasks.hibernate(slug).catch((e) => notifications.error(String(e)));
		}
	};
	const stopEffects = $effect.root(() => {
		$effect(() => {
			const on = settings.get<boolean>('kingu.agent.hibernation') === true;
			untrack(() => {
				if (on && !timer) timer = setInterval(tick, TICK_MS);
				else if (!on && timer) {
					clearInterval(timer);
					timer = undefined;
				}
			});
		});
		// Leaving a CLI's terminal starts its idle time over (Orca's foreground floor).
		$effect(() => {
			const front = shown();
			if (front) untrack(() => (seen[front] = Date.now()));
		});
	});
	const active = () => (appMode.isAgents ? appMode.activeSession : null);
	const unregister = [
		commands.register({
			id: 'kingu.agents.compareAttempts',
			title: 'Compare Attempts…',
			category: 'Agents',
			when: () => !!adeTasks.find(active() ?? '')?.meta.group,
			run: () => {
				const slug = active();
				if (slug) attempts.compare(slug);
			}
		}),
		commands.register({
			id: 'kingu.agents.newTaskFromTask',
			title: 'New Task from This Task',
			category: 'Agents',
			when: () => !!adeTasks.find(active() ?? ''),
			run: () => {
				const slug = active();
				if (slug) attempts.newFromTask(slug);
			}
		})
	];
	return () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		stopEffects();
		unregister.forEach((u) => u());
	};
}

/** "A · opus" for an attempt's badge title; null for a task in no group. */
export function attemptLabel(meta: TaskMeta): string | null {
	const letter = attemptLetter(meta);
	if (!letter) return null;
	return meta.attempt_model ? t('adeAttempts.attemptModel', { letter, model: meta.attempt_model }) : t('adeAttempts.attempt', { letter });
}
