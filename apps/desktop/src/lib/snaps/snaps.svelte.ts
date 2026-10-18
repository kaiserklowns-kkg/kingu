// Snaps store: the list from `snap_list` (user snaps + the open folder's `.kingu/snaps`), trust,
// running a task in the mode that is showing (an IDE panel terminal in the folder root, or an
// ADE terminal tab in the selected worktree), and what active snaps contribute: palette
// commands, settings schemas, MCP servers and skills. Rust decides `trusted`; nothing here runs a repo
// snap's command unless it is trusted (see snapModel.isActive). Tasks and MCP servers run confined to
// their snap's permissions (snapModel.sandboxPlan) unless the user turned `kingu.snaps.sandbox` off.

import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { ask, message } from '#lib/workbench/messageBox.ts';
import { adeLayout } from '#lib/ade/adeLayout.svelte.ts';
import { settingSchemas } from '#lib/settings/schemas.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
import { terminals } from '#lib/terminal/terminals.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { setMcpProvider, setSkillPluginProvider } from '#lib/ade/mcp.ts';
import { team } from '#lib/team/team.svelte.ts';
import { createSnapEventRouter, needsFocusReload } from '#lib/team/teamEvents.ts';
import { approveSummary, canApprove, isApprovable, type TeamCatalog } from './teamSnaps.ts';
import { worktreeDir } from '#lib/ade/keys.ts';
import {
	installSummary,
	isActive,
	isUpdatable,
	mcpServersOf,
	runnableTasks,
	SANDBOX_SETTING,
	sandboxPlan,
	sandboxRefusal,
	sandboxTask,
	skillSnapIds,
	snapSettingSchemas,
	taskArgv,
	taskCommandId,
	touchesRepoSnaps,
	trustSummary,
	updateSummary,
	type McpServerSpec,
	type PreparedInstall,
	type SandboxInfo,
	type SandboxPlan,
	type SnapInfo
} from './snapModel.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';

class Snaps {
	list = $state<SnapInfo[]>([]);
	loaded = $state(false);
	/** `snap_list` itself failed (a broken snap is listed with its own error instead). */
	error = $state<string | null>(null);
	#seq = 0;
	/** What can confine snaps on this machine (`snap_sandbox_info`), read once. */
	sandboxInfo = $state<SandboxInfo | null>(null);

	/** How tasks and MCP servers run now: confined, unconfined (setting off) or refused. */
	get sandbox(): SandboxPlan {
		return sandboxPlan(this.sandboxInfo, settings.get(SANDBOX_SETTING));
	}

	/** Re-reads every snap. A slower, older read never overwrites a newer one. */
	async load() {
		const seq = ++this.#seq;
		if (!this.sandboxInfo) {
			this.sandboxInfo = await invoke<SandboxInfo>('snap_sandbox_info').catch((e) => ({ enforcer: null, launcher: null, protect: [], problem: String(e) }));
		}
		try {
			const list = await invoke<SnapInfo[]>('snap_list');
			if (seq !== this.#seq) return;
			// Reloads on focus and file changes mostly find nothing new: keep the list (and the
			// commands and settings derived from it) as it is then.
			if (JSON.stringify(list) !== JSON.stringify($state.snapshot(this.list))) this.list = list;
			this.error = null;
		} catch (e) {
			if (seq === this.#seq) this.error = String(e);
		} finally {
			if (seq === this.#seq) this.loaded = true;
		}
	}

	/** Trusts (or untrusts) a repo snap of the open folder: exactly the manifest that was listed. */
	async trust(id: string, on: boolean) {
		const snap = this.list.find((s) => s.id === id && s.source === 'repo');
		if (!snap) return;
		try {
			await invoke('snap_trust', { id, trusted: on, hash: on ? snap.hash : null });
			status.flash(on ? t('tools.snaps.trusted', { name: snap.name }) : t('tools.snaps.untrusted', { name: snap.name }));
		} catch (e) {
			notifications.error(t('tools.snaps.trustFailed', { error: String(e) }));
		}
		await this.load();
	}

	/** What an install, update or uninstall is doing right now (one at a time), for the Snaps view. */
	busy = $state<string | null>(null);

	async #exclusive<T>(label: string, run: () => Promise<T>): Promise<T | undefined> {
		if (this.busy) {
			status.flash(t('tools.snaps.waitBusy', { busy: this.busy }));
			return undefined;
		}
		this.busy = label;
		try {
			return await run();
		} finally {
			this.busy = null;
		}
	}

	/** Snap: Install from Git… — clone into staging, confirm natively, then install. */
	async install() {
		const url = await quick.input({
			placeholder: t('tools.snaps.gitUrlPlaceholder'),
			hint: (v) => (v.trim() ? t('tools.snaps.installFrom', { url: v.trim() }) : t('tools.snaps.typeUrl'))
		});
		if (!url?.trim()) return;
		await this.#exclusive(t('tools.snaps.fetchingGit'), async () => {
			const prepared = await this.#prepare(() => invoke<PreparedInstall>('snap_install_git', { url: url.trim() }));
			if (prepared) await this.#confirmAndCommit(prepared);
		});
	}

	/** Snap: Install from Folder… — copies the folder (no symlinks), same checks and confirm. */
	async installFromFolder() {
		const path = await open({ directory: true, multiple: false, title: t('tools.snaps.pickFolder') });
		if (typeof path !== 'string') return;
		await this.#exclusive(t('tools.snaps.copying'), async () => {
			const prepared = await this.#prepare(() => invoke<PreparedInstall>('snap_install_folder', { path }));
			if (prepared) await this.#confirmAndCommit(prepared);
		});
	}

	/** Snap: Update — fetches the snap's git origin again and shows what changed before replacing it. */
	async update(id?: string) {
		const target = id ?? (await this.#pick(this.list.filter(isUpdatable), t('tools.snaps.pickUpdate')));
		if (!target) return;
		await this.#exclusive(t('tools.snaps.updating', { id: target }), async () => {
			const prepared = await this.#prepare(() => invoke<PreparedInstall>('snap_update_prepare', { id: target }));
			if (prepared) await this.#confirmAndCommit(prepared);
		});
	}

	/** Snap: Uninstall — user snaps only (repo snaps come with the repo); moves the folder to the Trash. */
	async uninstall(id?: string) {
		const target = id ?? (await this.#pick(this.list.filter((s) => s.source === 'user'), t('tools.snaps.pickUninstall')));
		const snap = this.list.find((s) => s.source === 'user' && s.id === target);
		if (!target || !snap) return;
		const sure = await ask(t('tools.snaps.uninstallAsk', { name: snap.name, dir: snap.dir }), { title: t('tools.snaps.uninstallTitle'), kind: 'warning', okLabel: t('tools.snaps.uninstall'), cancelLabel: t('common.cancel') });
		if (!sure) return;
		await this.#exclusive(t('tools.snaps.uninstalling', { name: snap.name }), async () => {
			try {
				await invoke('snap_uninstall', { id: target });
				status.flash(t('tools.snaps.uninstalled', { name: snap.name }));
			} catch (e) {
				notifications.error(t('tools.snaps.uninstallFailed', { error: String(e) }));
			}
			await this.load();
		});
	}

	/** Snap: New Snap… — writes a commented template and opens it in the editor. */
	async newSnap() {
		const id = await quick.input({
			placeholder: t('tools.snaps.newIdPlaceholder'),
			hint: (v) => (/^[a-z0-9][a-z0-9-]{0,39}$/.test(v.trim()) ? t('tools.snaps.createNamed', { id: v.trim() }) : t('tools.snaps.idRule'))
		});
		if (!id?.trim()) return;
		const name = await quick.input({ placeholder: t('tools.snaps.namePlaceholder'), hint: (v) => (v.trim() ? t('tools.snaps.nameHint', { name: v.trim() }) : t('tools.snaps.useIdAsName', { id: id.trim() })) });
		if (name === undefined) return;
		const items = [{ id: 'user', label: t('tools.snaps.locUser'), description: t('tools.snaps.locUserDesc') }];
		if (workspace.root) items.push({ id: 'repo', label: t('tools.snaps.locRepo'), description: t('tools.snaps.locRepoDesc') });
		const location = items.length === 1 ? items[0] : await quick.choose({ placeholder: t('tools.snaps.locPlaceholder'), items });
		if (!location) return;
		try {
			const key = await invoke<string>('snap_new', { id: id.trim(), name: name.trim() || id.trim(), location: location.id });
			await this.load();
			systemSettings.close();
			appMode.setMode('workbench');
			editors.open(key, { preview: false });
		} catch (e) {
			notifications.error(t('tools.snaps.createFailed', { error: String(e) }));
		}
	}

	/** Snap: Lock — writes `.kingu/snaps.lock` with the id, version and hash of each repo snap. */
	async lock() {
		if (!workspace.root) {
			status.flash(t('tools.snaps.openFolderFirst'));
			return;
		}
		try {
			const count = await invoke<number>('snap_lock');
			status.flash(t('tools.snaps.lockWritten', { count }));
		} catch (e) {
			notifications.error(t('tools.snaps.lockFailed', { error: String(e) }));
		}
		await this.load();
	}

	/** Trust from a row of the Snaps view: the same review as the details page, as a native confirm. */
	async confirmTrust(s: SnapInfo) {
		const sure = await ask(trustSummary(s, this.sandbox), { title: t('tools.snaps.trustTitle', { name: s.name }), kind: 'warning', okLabel: t('tools.snaps.trust'), cancelLabel: t('common.cancel') });
		if (sure) await this.trust(s.id, true);
	}

	/** Opens a snap's snap.toml in the editor (a user snap through its `snap://user/` key). */
	editManifest(s: SnapInfo) {
		systemSettings.close();
		appMode.setMode('workbench');
		if (s.source === 'user') editors.open(`snap://user/${s.id}/snap.toml`, { preview: false });
		else editors.open(`.kingu/snaps/${s.id}/snap.toml`, { preview: false });
	}

	async reveal(s: SnapInfo) {
		try {
			await invoke('snap_reveal', { id: s.id, source: s.source });
		} catch (e) {
			notifications.error(t('tools.snaps.openFolderFailed', { error: String(e) }));
		}
	}

	/** Run a task of the snap, picked from a quick pick when it has several. */
	async pickTask(s: SnapInfo) {
		if (!isActive(s)) {
			notifications.warn(s.source === 'repo' ? t('tools.snaps.trustBeforeRun') : t('tools.snaps.unusable'));
			return;
		}
		if (!s.tasks.length) {
			status.flash(t('tools.snaps.noTasks', { name: s.name }));
			return;
		}
		const task = s.tasks.length === 1 ? s.tasks[0] : await quick.choose({ placeholder: t('tools.snaps.runTaskOf', { name: s.name }), items: s.tasks.map((t) => ({ id: t.id, label: t.title, description: t.command.join(' ') })) });
		if (task) this.runTask(s.id, task.id);
	}

	async #pick(list: SnapInfo[], placeholder: string): Promise<string | undefined> {
		if (!list.length) {
			status.flash(t('tools.snaps.noneApplicable'));
			return undefined;
		}
		return (await quick.choose({ placeholder, items: list.map((s) => ({ id: s.id, label: s.name, description: `${s.id} v${s.version}` })) }))?.id;
	}

	async #prepare(run: () => Promise<PreparedInstall>): Promise<PreparedInstall | undefined> {
		try {
			return await run();
		} catch (e) {
			await message(String(e), { title: t('tools.snaps.installFailedTitle'), kind: 'error' });
			return undefined;
		}
	}

	/** Picks the snap of a multi-snap repo, shows the native confirm, then installs (or cleans up). */
	async #confirmAndCommit(p: PreparedInstall) {
		const cancel = () => invoke('snap_install_cancel', { token: p.token }).catch(() => {});
		let candidate = p.candidates[0];
		if (p.candidates.length > 1) {
			const picked = await quick.choose({
				placeholder: t('tools.snaps.pickCandidate'),
				items: p.candidates.map((c) => ({ id: c.snap.id, label: c.snap.name, description: c.snap.error ? t('tools.snaps.candidateBroken', { error: c.snap.error }) : `${c.snap.id} v${c.snap.version} · ${c.rel}` }))
			});
			candidate = p.candidates.find((c) => c.snap.id === picked?.id)!;
		}
		if (!candidate) return cancel();
		const s = candidate.snap;
		if (s.error) {
			await message(s.error, { title: t('tools.snaps.brokenTitle', { name: s.name }), kind: 'error' });
			return cancel();
		}
		const existing = p.existing.find((e) => e.id === s.id);
		const sure = await ask(existing ? updateSummary(existing, s, p.origin, this.sandbox) : installSummary(s, p.origin, this.sandbox), {
			title: existing ? t('tools.snaps.updateTitle', { name: s.name }) : t('tools.snaps.installTitle', { name: s.name }),
			kind: 'warning',
			okLabel: existing ? t('tools.snaps.update') : t('tools.snaps.install'),
			cancelLabel: t('common.cancel')
		});
		if (!sure) return cancel();
		try {
			await invoke('snap_install_commit', { token: p.token, id: s.id, hash: s.hash, replace: !!existing });
			status.flash(existing ? t('tools.snaps.updated', { name: s.name, version: s.version }) : t('tools.snaps.installed', { name: s.name }));
		} catch (e) {
			await message(String(e), { title: t('tools.snaps.installFailedTitle'), kind: 'error' });
		}
		await this.load();
	}

	/** The team Snap catalog; null when no team server is set or not signed in (see `teamError`). */
	teamCatalog = $state<TeamCatalog | null>(null);
	teamError = $state<string | null>(null);
	teamLoading = $state(false);
	#teamSeq = 0;

	async loadTeam() {
		const serverUrl = team.serverUrl;
		const seq = ++this.#teamSeq;
		if (!serverUrl || !team.status?.signed_in) {
			this.teamCatalog = null;
			this.teamError = null;
			return;
		}
		this.teamLoading = true;
		try {
			const catalog = await invoke<TeamCatalog>('team_snap_catalog', { serverUrl });
			if (seq !== this.#teamSeq) return;
			if (JSON.stringify(catalog) !== JSON.stringify($state.snapshot(this.teamCatalog))) this.teamCatalog = catalog;
			this.teamError = null;
		} catch (e) {
			if (seq === this.#teamSeq) this.teamError = String(e);
		} finally {
			if (seq === this.#teamSeq) this.teamLoading = false;
		}
	}

	/** Installs a team snap at the commit the team pinned; Rust refuses it unless its hash is the approved one. */
	async installTeam(id: string) {
		await this.#exclusive(t('tools.snaps.fetchingPinned', { id }), async () => {
			const prepared = await this.#prepare(() => invoke<PreparedInstall>('snap_install_team', { serverUrl: team.serverUrl, id }));
			if (prepared) await this.#confirmAndCommit(prepared);
		});
	}

	/** Snap: Approve for Team… (owner/lead) — pins an installed git snap's commit and hash for everyone. */
	async approveForTeam(id?: string) {
		if (!canApprove(this.teamCatalog?.role)) {
			status.flash(t('tools.snaps.approveRole'));
			return;
		}
		const target = id ?? (await this.#pick(this.list.filter(isApprovable), t('tools.snaps.pickApprove')));
		const snap = this.list.find((s) => s.source === 'user' && s.id === target);
		if (!target || !snap) return;
		if (!isApprovable(snap)) {
			status.flash(t('tools.snaps.approveNeedsGit', { name: snap.name }));
			return;
		}
		const level = await quick.choose({
			placeholder: t('tools.snaps.approvePlaceholder', { name: snap.name, version: snap.version }),
			items: [
				{ id: 'optional', label: t('tools.snaps.optional'), description: t('tools.snaps.optionalDesc') },
				{ id: 'required', label: t('tools.snaps.required'), description: t('tools.snaps.requiredDesc') }
			]
		});
		if (!level) return;
		const required = level.id === 'required';
		const note = await quick.input({ placeholder: t('tools.snaps.notePlaceholder'), hint: (v) => (v.trim() ? t('tools.snaps.noteHint', { note: v.trim() }) : t('tools.snaps.enterToSkip')) });
		if (note === undefined) return;
		const sure = await ask(approveSummary(snap, required), { title: t('tools.snaps.approveTitle', { name: snap.name }), kind: 'warning', okLabel: t('tools.snaps.approve'), cancelLabel: t('common.cancel') });
		if (!sure) return;
		await this.#exclusive(t('tools.snaps.approving', { name: snap.name }), async () => {
			try {
				await invoke('team_snap_approve', { serverUrl: team.serverUrl, id: snap.id, required, note: note.trim() || null });
				status.flash(t('tools.snaps.approved', { name: snap.name, version: snap.version }));
			} catch (e) {
				await message(String(e), { title: t('tools.snaps.approveFailedTitle'), kind: 'error' });
			}
			await this.loadTeam();
		});
	}

	/** Runs a task of an active snap in a new terminal of the mode that is showing. */
	runTask(snapId: string, taskId: string) {
		const snap = this.list.find((s) => s.id === snapId && isActive(s));
		const task = snap?.tasks.find((t) => t.id === taskId);
		if (!snap || !task) {
			status.flash(t('tools.snaps.taskNotFound', { id: `${snapId}/${taskId}` }));
			return;
		}
		if (!workspace.root) {
			status.flash(t('tools.snaps.openFolderBeforeTask'));
			return;
		}
		const argv = taskArgv(snap, task, (id) => settings.get(id));
		if (!argv.length) {
			status.flash(t('tools.snaps.taskNoProgram', { title: task.title }));
			return;
		}
		// The folder the terminal opens in: the selected task worktree in the ADE, else the folder.
		const slug = appMode.isAgents ? adeLayout.key : '';
		const root = slug ? `${workspace.root}/${worktreeDir(slug)}` : workspace.root;
		const confined = sandboxTask(this.sandbox, snap.permissions, root, argv);
		if ('error' in confined) {
			status.flash(confined.error, 10000);
			return;
		}
		const { run } = confined;
		const title = `${task.title} (${snap.name})`;
		systemSettings.close();
		if (appMode.isAgents) adeLayout.newTerminal(adeLayout.key, { title, run });
		else {
			terminals.open({ title, run });
			layout.showPanel('terminal');
		}
	}

	/** MCP servers of trusted, valid snaps for an agent in `root`, keyed `<snapId>-<serverName>`, confined like tasks. */
	mcpServers(root: string | null): Record<string, McpServerSpec> {
		const plan = this.sandbox;
		const refused = sandboxRefusal(plan);
		if (refused && this.list.some((s) => isActive(s) && s.mcp.length)) status.flash(refused, 10000);
		return mcpServersOf(this.list, (id) => settings.get(id), { plan, root });
	}

	/** Skill plugin folders of active snaps for an agent run (Rust lists the snaps again and writes them into the app cache). */
	async skillPlugins(): Promise<string[]> {
		const ids = skillSnapIds(this.list);
		if (!ids.length) return [];
		try {
			return await invoke<string[]>('snap_skill_plugins', { ids });
		} catch (e) {
			notifications.error(t('tools.snaps.skillsFailed', { error: String(e) }));
			return [];
		}
	}
}

export const snaps = new Snaps();

const RELOAD_DEBOUNCE_MS = 300;

/** Workbench wiring: loads snaps per folder, registers their settings and commands. */
export function installSnaps(): () => void {
	// Agents (timeline and CLI) get the MCP servers of active snaps when a run starts.
	setMcpProvider((root) => snaps.mcpServers(root));
	setSkillPluginProvider(() => snaps.skillPlugins());
	// Editing a repo snap reloads the list (the watcher reports `.kingu/snaps/**`); the user snaps
	// dir is not watched, so they are re-listed when the window gets focus (listing is cheap).
	let reloadTimer: ReturnType<typeof setTimeout> | undefined;
	const reloadSoon = () => {
		clearTimeout(reloadTimer);
		reloadTimer = setTimeout(() => void snaps.load(), RELOAD_DEBOUNCE_MS);
	};
	// The team catalog follows the server's event stream; focus re-reads it only while that is down.
	const teamRouter = createSnapEventRouter(() => void snaps.loadTeam());
	const stopTeamEvents = team.onEvent((e) => teamRouter.event(e));
	const reloadAll = () => {
		reloadSoon();
		if (needsFocusReload(team.status?.stream)) void snaps.loadTeam();
	};
	const stopWatching = workspace.onFilesChanged((paths) => {
		if (touchesRepoSnaps(paths)) reloadSoon();
	});
	window.addEventListener('focus', reloadAll);
	let taskCommands: (() => void)[] = [];
	const unregisterTasks = () => {
		taskCommands.forEach((u) => u());
		taskCommands = [];
	};
	const stopEffects = $effect.root(() => {
		$effect(() => {
			void workspace.root;
			untrack(() => void snaps.load());
		});
		$effect(() => {
			void team.serverUrl;
			void team.status?.signed_in;
			untrack(() => void snaps.loadTeam());
		});
		$effect(() => {
			const state = team.status?.stream;
			untrack(() => teamRouter.stream(state));
		});
		$effect(() => {
			const list = snaps.list;
			untrack(() => {
				settingSchemas.contribute('snaps', snapSettingSchemas(list));
				unregisterTasks();
				taskCommands = runnableTasks(list).map(({ snap, task }) =>
					commands.register({
						id: taskCommandId(snap.id, task.id),
						title: task.title,
						category: `Snap: ${snap.name}`,
						when: () => workspace.root !== null,
						run: () => snaps.runTask(snap.id, task.id)
					})
				);
			});
		});
	});
	const unregister = [
		commands.register({
			id: 'snap.reload',
			title: 'Reload Snaps',
			category: 'Snap',
			run: async () => {
				await snaps.load();
				if (snaps.error) notifications.error(t('tools.snaps.loadFailed', { error: snaps.error }));
				else status.flash(t('tools.snaps.loaded', { count: snaps.list.length }));
			}
		}),
		commands.register({ id: 'snap.manage', title: 'Manage Snaps', category: 'Snap', run: () => systemSettings.showSnaps() }),
		commands.register({ id: 'snap.install', title: 'Install from Git…', category: 'Snap', run: () => snaps.install() }),
		commands.register({ id: 'snap.installFromFolder', title: 'Install from Folder…', category: 'Snap', run: () => snaps.installFromFolder() }),
		commands.register({ id: 'snap.update', title: 'Update Snap…', category: 'Snap', run: () => snaps.update() }),
		commands.register({ id: 'snap.uninstall', title: 'Uninstall Snap…', category: 'Snap', run: () => snaps.uninstall() }),
		commands.register({ id: 'snap.new', title: 'New Snap…', category: 'Snap', run: () => snaps.newSnap() }),
		commands.register({ id: 'snap.approveForTeam', title: 'Approve Snap for Team…', category: 'Snap', when: () => canApprove(snaps.teamCatalog?.role), run: () => snaps.approveForTeam() }),
		commands.register({ id: 'snap.lock', title: 'Write snaps.lock', category: 'Snap', when: () => workspace.root !== null, run: () => snaps.lock() }),
		// VS Code's Extensions view key.
		commands.register({ id: 'workbench.view.snaps', title: 'Show Snaps', category: 'View', key: 'cmd+shift+x', run: () => ((layout.sideView = 'snaps'), (layout.sidebarVisible = true)) })
	];
	return () => {
		clearTimeout(reloadTimer);
		stopWatching();
		window.removeEventListener('focus', reloadAll);
		stopTeamEvents();
		teamRouter.dispose();
		stopEffects();
		unregisterTasks();
		unregister.forEach((u) => u());
		settingSchemas.contribute('snaps', []);
		setMcpProvider(() => ({}));
		setSkillPluginProvider(async () => []);
	};
}
