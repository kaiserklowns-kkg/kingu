// Runs worktree card actions and the Worktree Jump palette (Orca's WorktreeJumpPalette): one
// list of the folder and every task worktree, jumping into the Agents layout on accept.

import { invoke } from '@tauri-apps/api/core';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { adeLayout, PRIMARY } from './adeLayout.svelte';
import { openEditor } from './agentsMode.svelte';
import { quickOpenWorktree } from './quickOpen.svelte.ts';
import { worktreeDir } from './keys';
import { COLUMNS, STATUS_LABEL, timeAgo } from './model';
import { adeTasks } from './tasks.svelte';
import { jumpRows, openInLabels, worktreeActions, type WorktreeAction } from './worktreeActions';
import { settings } from '#lib/settings/settings.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { cliOf, enabledBins, parseCliCommand } from './agentCli';
import { CUSTOM_PICK, KNOWN_BINS, pickerItems, programOf } from './agentProfiles';
import { canResumeWith, sessionProgram, sessionsOf, type SessionRef } from './sessionHistory';
import { workflowOf, workflowStatuses } from './workflow';
import { attempts } from './attempts.svelte';

const FOLDER_ID = '@folder';

/** The card menu of a worktree (`key` '' = the folder itself). */
export function actionsFor(key: string) {
	const view = key ? adeTasks.find(key) : undefined;
	const openIn = openInLabels(settings.get<Record<string, unknown>>('kingu.worktree.openIn'));
	return worktreeActions({
		slug: key || null,
		status: view?.status,
		running: !!view?.runtime?.working,
		hasWorktree: !view?.statError,
		openIn,
		sessions: view ? sessionsOf(view.meta).length : 0,
		attempts: !!view?.meta.group
	});
}

/** Orca's Move to Status: the board's workflow columns, the task's own one marked. */
async function moveToStatus(slug: string) {
	const meta = adeTasks.find(slug)?.meta;
	if (!meta) return;
	const statuses = workflowStatuses(settings.get('kingu.board.statuses'));
	const current = workflowOf(meta, statuses);
	const picked = await quick.choose({
		placeholder: t('adeWorkflow.pick.status', { title: meta.title }),
		items: statuses.map((s) => ({ id: s.id, label: s.label, description: s.id === current ? t('adeWorkflow.pick.statusCurrent') : undefined })),
		activeId: current
	});
	if (picked) await adeTasks.setWorkflowStatus(slug, picked.id);
}

/** One of the task's saved sessions, newest first; undefined when dismissed or there is none. */
async function pickSession(slug: string, placeholder: (title: string) => string, describe: (s: SessionRef) => string): Promise<SessionRef | undefined> {
	const meta = adeTasks.find(slug)?.meta;
	if (!meta) return;
	const list = sessionsOf(meta);
	if (!list.length) {
		status.flash(t('adeWorkflow.pick.noSessions', { title: meta.title }));
		return;
	}
	const picked = await quick.choose({
		placeholder: placeholder(meta.title),
		items: list.map((s, i) => ({ id: s.id, label: `${sessionProgram(s.agent)} · ${timeAgo(s.at, Date.now())}`, description: [i === 0 ? t('adeWorkflow.pick.sessionLatest') : null, describe(s), s.id].filter(Boolean).join(' · ') }))
	});
	return picked && list.find((s) => s.id === picked.id);
}

/** Continue Session…: resume a saved session, or hand it off when the task's agent cannot resume it. */
async function continueSession(slug: string) {
	const meta = adeTasks.find(slug)?.meta;
	if (!meta) return;
	const agent = cliOf(meta.agent);
	const name = agent ? programOf(agent) : 'Claude';
	const s = await pickSession(
		slug,
		(title) => t('adeWorkflow.pick.session', { title }),
		(s) => (canResumeWith(meta.agent, s.agent) ? t('adeWorkflow.pick.sessionResume', { agent: name }) : t('adeWorkflow.pick.sessionHandOff', { agent: name }))
	);
	if (s) await adeTasks.continueSession(slug, s);
}

/**
 * Hand Off to Another Agent… (Orca's AgentSessionContinuationDialog): a session, then an agent CLI
 * found on the PATH. Orca's initial pick: the session's own agent, else the default, else the first.
 */
async function handOff(slug: string) {
	const meta = adeTasks.find(slug)?.meta;
	if (!meta) return;
	const s = await pickSession(slug, (title) => t('adeWorkflow.pick.handOffSession', { title }), () => '');
	if (!s) return;
	const found = enabledBins(await invoke<string[]>('agent_cli_found', { names: KNOWN_BINS }).catch(() => [] as string[]), settings.get<string[]>('kingu.agent.disabled'), null);
	const items = pickerItems(found, '').filter((r) => r.id !== CUSTOM_PICK);
	if (!items.length) return status.flash(t('adeWorkflow.pick.noAgents'), 8000);
	const configured = parseCliCommand(settings.get<string>('kingu.agent.cli') ?? '');
	const own = cliOf(meta.agent);
	const source = sessionProgram(s.agent);
	const preferred = [source, configured && programOf(configured)].find((b) => b && items.some((r) => r.id === b)) ?? items[0].id;
	const picked = await quick.choose({
		placeholder: t('adeWorkflow.pick.agent'),
		items: items.map((r) => ({ ...r, description: own && programOf(own) === r.id ? `${r.description} · ${t('adeWorkflow.pick.agentCurrent')}` : r.description })),
		activeId: preferred
	});
	if (!picked) return;
	// The same program keeps the flags it already has (the task's command, else kingu.agent.cli).
	const argv = [own, configured].find((a) => a && programOf(a) === picked.id) ?? [picked.id];
	await adeTasks.handOff(slug, s, argv);
}

/** Opens a worktree folder (absolute) in a `kingu.worktree.openIn` app; Rust reads the command from the user's settings. */
export function openWorktreeIn(label: string, path: string) {
	invoke('worktree_open_in', { label, path }).catch((e) => notifications.error(t('adeTasks.worktree.openInFailed', { app: label, error: String(e) })));
}

async function copy(text: string, what: 'path' | 'branch') {
	try {
		await navigator.clipboard.writeText(text);
		status.flash(what === 'path' ? t('adeTasks.worktree.copiedPath') : t('adeTasks.worktree.copiedBranch'));
	} catch {
		notifications.error(what === 'path' ? t('adeTasks.worktree.copyPathFailed') : t('adeTasks.worktree.copyBranchFailed'));
	}
}

export function runWorktreeAction(key: string, id: WorktreeAction) {
	const slug = key || null;
	if (id.startsWith('openIn:')) {
		if (workspace.root) openWorktreeIn(id.slice(7), slug ? `${workspace.root}/${worktreeDir(slug)}` : workspace.root);
		return;
	}
	switch (id) {
		case 'open':
			appMode.setMode('agents');
			return adeLayout.show(key);
		case 'openInEditor':
			adeLayout.show(key);
			return openEditor();
		case 'newTerminal':
			appMode.setMode('agents');
			adeLayout.show(key);
			return adeLayout.newTerminal(key);
		case 'quickOpen':
			appMode.setMode('agents');
			adeLayout.show(key);
			return quickOpenWorktree(key);
		case 'reveal':
			return invoke('fs_reveal', { rel: slug ? worktreeDir(slug) : '' }).catch((e) => notifications.error(e));
		case 'copyPath':
			return workspace.root && copy(slug ? `${workspace.root}/${worktreeDir(slug)}` : workspace.root, 'path');
		case 'copyBranch':
			return slug && copy(adeTasks.branchOf(slug), 'branch');
		case 'rename':
			return slug && adeTasks.startRename(slug);
		case 'markDone':
			return slug && adeTasks.markDone(slug);
		case 'reopen':
			return slug && adeTasks.markDone(slug, false);
		case 'moveStatus':
			return slug && moveToStatus(slug);
		case 'continueSession':
			return slug && continueSession(slug);
		case 'handOff':
			return slug && handOff(slug);
		case 'newFromTask':
			return slug && attempts.newFromTask(slug);
		case 'compareAttempts':
			return slug && attempts.compare(slug);
		case 'remove':
			return slug && adeTasks.remove(slug);
	}
}

/** Worktree Jump (⇧⌘J): the folder and every task worktree; Enter opens it in the Agents layout. */
export function jumpToWorktree() {
	if (!workspace.root) return status.flash(t('adeTasks.worktree.openFolderFirst'));
	const rows = jumpRows(
		{ name: workspace.name ?? '', branch: status.branch ?? '' },
		COLUMNS.map((c) => ({ label: c.label, tasks: adeTasks.groups[c.id].map((v) => ({ slug: v.meta.slug, title: v.meta.title, status: STATUS_LABEL[v.status], branch: adeTasks.branchOf(v.meta.slug) })) }))
	);
	let last = '';
	quick.pick({
		placeholder: t('adeTasks.worktree.jumpPlaceholder'),
		items: rows.map((r) => {
			const separator = r.group !== last ? r.group : undefined;
			last = r.group;
			return { id: r.key || FOLDER_ID, label: r.label, description: r.description, separator };
		}),
		activeId: appMode.isAgents ? adeLayout.key || FOLDER_ID : undefined,
		onAccept: (item) => runWorktreeAction(item.id === FOLDER_ID ? PRIMARY : item.id, 'open')
	});
}

export function installWorktreeCommands(): () => void {
	const unregister = [
		commands.register({ id: 'kingu.agents.jumpWorktree', title: 'Worktree Jump…', category: 'Agents', key: 'cmd+shift+j', when: () => workspace.root !== null, run: jumpToWorktree }),
		commands.register({
			id: 'kingu.agents.newTerminalInWorktree',
			title: 'New Terminal in Worktree',
			category: 'Agents',
			when: () => appMode.isAgents,
			run: () => adeLayout.newTerminal(adeLayout.key)
		})
	];
	return () => unregister.forEach((u) => u());
}

/** Orca's worktree rename: the title edits in place on the task's sidebar row. */
export function renameTask(slug: string) {
	adeTasks.startRename(slug);
}
