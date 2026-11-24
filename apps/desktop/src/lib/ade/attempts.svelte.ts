// Best-of-N attempts, stacked worktrees and agent hibernation, on top of adeTasks:
// - createAttempts: one prompt as 1-4 tasks `<slug>-a`, `-b`… sharing a group id, each with its
//   own model; compare their diff stats side by side (AttemptsCompare.svelte) and Pick winner,
//   which keeps that one and offers the others to Clean Up Tasks.
// - New Task from This Task: a task forked from another task's branch (its PR goes into it).
// - Hibernation (kingu.agent.hibernation, experimental, off by default): idle finished agent CLIs
//   are closed every minute by the planner in hibernation.ts, each on its own (Orca hibernates
//   per pane): a task's own agent, and an agent in any terminal pane of a task's worktree
//   (paneSleep.svelte.ts keeps those records), once two looks a minute apart agree (Orca's
//   confirmation). Each continues its session by itself when its terminal comes back on screen
//   (Orca's reveal wake), once per return, also the first time it is shown after a restart.

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
import { invoke } from '@tauri-apps/api/core';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { cliSessions } from './cliSessions.svelte';
import { paneAgents } from './paneAgents.svelte';
import { paneSleep } from './paneSleep.svelte';
import { tabPanes } from './adeTabs';
import { cliOf } from './agentCli';
import { profileOf } from './agentProfiles';
import { attemptLetter, attemptSlugs, losersOf, MAX_ATTEMPTS, validModel } from './attempts';
import { autoResumeOnShow, confirmHibernation, idleMs, paneHibernationRow, paneHibernationSupported, paneLaunchOf, sleepingPaneOf, TICK_MS, type HibernationConfirmations, type HibernationRow, type PaneJob } from './hibernation';
import type { TaskMeta } from './model';

class Attempts {
	/** New Task from This Task: the task whose branch the New Task form forks from. */
	stackOn = $state<string | null>(null);
	/** Tasks whose CLI launch is in flight: the claim that keeps one task from starting twice. */
	resuming = $state<Record<string, true>>({});
	/** Closes of task CLIs still being saved. */
	closing = new Map<string, Promise<void>>();

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

	/** Hibernation closes the task's idle CLI; it wakes when its terminal is shown again. */
	hibernate(slug: string) {
		const done = adeTasks
			.hibernate(slug)
			.catch((e) => void notifications.error(String(e)))
			.finally(() => this.closing.delete(slug));
		this.closing.set(slug, done);
	}

	/**
	 * Starts the task's CLI again, continuing its session unless `fresh`: the one way in for the
	 * return wake and for the resume buttons, so a click racing a return starts one process.
	 * False when a launch was in flight already or the CLI did not start.
	 */
	async resume(slug: string, fresh = false): Promise<boolean> {
		if (this.resuming[slug]) return false;
		this.resuming[slug] = true;
		try {
			// A close still being saved would mark the new CLI hibernated.
			await this.closing.get(slug);
			await adeTasks.resumeCli(slug, fresh);
		} catch (e) {
			notifications.error(t('adeAttempts.hibernated.resumeFailed', { title: adeTasks.find(slug)?.meta.title ?? slug, error: String(e) }));
		} finally {
			delete this.resuming[slug];
		}
		// A failed launch leaves the task hibernated, so the next return tries again (Orca re-arms its wake target).
		return cliSessions.has(slug);
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
	let windowVisible = $state(document.visibilityState === 'visible');
	const onVisibility = () => (windowVisible = document.visibilityState === 'visible');
	document.addEventListener('visibilitychange', onVisibility);
	const shown = () => (appMode.isAgents && !adeLayout.board && adeLayout.activeTab(adeLayout.key) === 'main' && windowVisible ? adeLayout.key : null);
	/** The task terminal on screen, and the one a wake was tried for since it came on screen. */
	let lastShown: string | null = null;
	let claimed: string | null = null;
	let timer: ReturnType<typeof setInterval> | undefined;
	/** Candidate signatures at the last look (Orca's two-tick confirmation), for the task CLIs and the panes. */
	let taskLooks: HibernationConfirmations = {};
	let paneLooks: HibernationConfirmations = {};
	const idle = () => idleMs(settings.get<number>('kingu.agent.hibernationIdleMinutes'));
	/** Panes hibernate where the job in front of a shell and its folder can be read (not Windows). */
	const panesSupported = paneHibernationSupported(typeof navigator === 'undefined' ? undefined : navigator.platform);
	if (!panesSupported) clientLog('info', 'agent hibernation: terminal panes are left running on this platform (no foreground job or folder to read)');
	/** The terminal panes on screen: every pane of the tab each region of the shown worktree shows. */
	const shownPanes = (): string[] => {
		if (!appMode.isAgents || adeLayout.board || !windowVisible) return [];
		const key = adeLayout.key;
		const tabs = new Set(adeLayout.shownTabs(key));
		return (adeLayout.terminals[key] ?? []).filter((t) => tabs.has(t.id)).flatMap((t) => tabPanes(t).map((p) => adeLayout.ptyKey(key, p)));
	};
	/** The tab and pane of a pane's PTY key in a task's worktree. */
	const paneOf = (key: string) => {
		for (const [slug, list] of Object.entries(adeLayout.terminals)) {
			if (!slug) continue;
			for (const tab of list) for (const pane of tabPanes(tab)) if (adeLayout.ptyKey(slug, pane) === key) return { tab, pane };
		}
		return null;
	};
	/** Agents in the terminal panes of task worktrees, as the planner sees them. A window on an SSH host has none (its terminals have their own lifecycle, sshHolder.ts). */
	const paneRows = (front: ReadonlySet<string>): HibernationRow[] => {
		if (workspace.remote || !panesSupported) return [];
		const rows: HibernationRow[] = [];
		for (const [slug, list] of Object.entries(adeLayout.terminals)) {
			if (!slug || !adeTasks.find(slug)) continue;
			for (const tab of list)
				for (const pane of tabPanes(tab)) {
					const key = adeLayout.ptyKey(slug, pane);
					const p = paneAgents.panes[key];
					if (p && !paneSleep.has(key)) rows.push(paneHibernationRow({ key, ...p, outputs: paneAgents.outputs(key), onScreen: front.has(key), seenAt: seen[key] }));
				}
		}
		return rows;
	};
	/** Pane closes being checked or made, so two ticks never work on one pane. */
	const closingPanes = new Set<string>();
	/**
	 * Closes one confirmed pane: reads the job in front of its shell (its pid, folder and command
	 * line, Rust `pty_job_info`), plans again and closes it only if it is still confirmed with the
	 * same signature (Orca's hibernatePaneIfStillEligible). The record keeps the agent's folder and,
	 * when the tab was opened for this agent and it still runs with that launch, the launch.
	 */
	const hibernatePane = async (key: string, signature: string) => {
		const at = paneOf(key);
		if (!at || closingPanes.has(key)) return;
		closingPanes.add(key);
		try {
			const job = await invoke<PaneJob | null>('pty_job_info', { key }).catch(() => null);
			if (!job || settings.get<boolean>('kingu.agent.hibernation') !== true) return;
			const now = Date.now();
			const again = confirmHibernation({ [key]: signature }, paneRows(new Set(shownPanes())), now, idle());
			const p = paneAgents.panes[key];
			if (!again.confirmed.includes(key) || !p) return;
			const agent = sleepingPaneOf(p, now)?.agent;
			const launch = agent && at.pane === at.tab.id ? paneLaunchOf(agent, at.tab.launch, job.args) : undefined;
			const record = sleepingPaneOf(p, now, job, launch);
			if (!record) return;
			clientLog('info', `hibernating the idle ${record.agent} of ${key}`);
			if (await paneSleep.hibernate(key, record, job.pid)) paneAgents.forget(key);
		} finally {
			closingPanes.delete(key);
		}
	};
	const tick = () => {
		const now = Date.now();
		const front = shown();
		if (front) seen[front] = now;
		const frontPanes = new Set(shownPanes());
		for (const key of frontPanes) seen[key] = now;
		const panes = confirmHibernation(paneLooks, paneRows(frontPanes), now, idle());
		paneLooks = panes.state;
		for (const key of panes.confirmed) void hibernatePane(key, panes.state[key]);
		const rows: HibernationRow[] = Object.keys(cliSessions.sessions).flatMap((slug) => {
			const meta = adeTasks.find(slug)?.meta;
			if (!meta) return [];
			const hook = cliSessions.hooks[slug];
			return [
				{
					id: slug,
					phase: hook?.phase,
					waiting: !!hook && (hook.permission || hook.question || hook.phase === 'waiting'),
					ended: cliSessions.ended(slug),
					resumable: resumable(meta),
					foreground: front === slug,
					hookAt: hook?.at,
					outputAt: cliSessions.lastOutput(slug),
					seenAt: seen[slug],
					busy: !!hook?.subagents && Object.keys(hook.subagents).length > 0,
					inputAt: cliSessions.lastInput(slug),
					// A CLI that only reports finished turns has no "working" event: its turn's end is the boundary.
					turnAt: hook?.hooks ? cliSessions.turnAt(slug) : hook?.at,
					session: meta.session_id ?? undefined,
					outputs: cliSessions.outputs(slug)
				}
			];
		});
		const tasks = confirmHibernation(taskLooks, rows, now, idle());
		taskLooks = tasks.state;
		for (const slug of tasks.confirmed) {
			clientLog('info', `hibernating the idle agent CLI of ${slug}`);
			attempts.hibernate(slug);
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
					taskLooks = {};
					paneLooks = {};
				}
			});
		});
		// Leaving a CLI's terminal starts its idle time over (Orca's foreground floor).
		$effect(() => {
			const front = shown();
			if (front) untrack(() => (seen[front] = Date.now()));
		});
		// The same for terminal panes; one that sleeps and came back on screen wakes (paneSleep.svelte.ts).
		$effect(() => {
			const front = new Set(shownPanes());
			untrack(() => {
				const now = Date.now();
				for (const key of front) seen[key] = now;
				paneSleep.shown(front);
			});
		});
		// A closed tab or split, or a removed task, takes its sleeping panes' records along.
		$effect(() => {
			const open = new Set(adeLayout.ptyKeys());
			untrack(() => paneSleep.prune(open));
		});
		// A hibernated CLI's terminal on screen continues its session (hibernation.ts), also a task
		// still hibernated from before a restart (Orca's hidden-agent resume deferral). Not tied to
		// the setting: a CLI already asleep still wakes after the setting is turned off, as in Orca.
		// It follows the task's record too, so a task that loads after its terminal is shown wakes.
		$effect(() => {
			const front = shown();
			const meta = front ? adeTasks.find(front)?.meta : undefined;
			const task = meta
				? {
						hibernated: !!meta.hibernated_at || untrack(() => attempts.closing.has(meta.slug)),
						running: cliSessions.has(meta.slug),
						resumable: resumable(meta),
						resuming: !!attempts.resuming[meta.slug]
					}
				: null;
			untrack(() => {
				if (front !== lastShown) claimed = null;
				lastShown = front;
				if (!front || !autoResumeOnShow(front, claimed, task)) return;
				claimed = front;
				clientLog('info', `resuming the hibernated agent CLI of ${front}`);
				void attempts.resume(front);
			});
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
		document.removeEventListener('visibilitychange', onVisibility);
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
