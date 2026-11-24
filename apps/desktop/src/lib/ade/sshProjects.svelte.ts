// Projects on SSH hosts (Orca's "Open project on SSH host"): a git repository on a saved SSH host
// joins the side bar under its own heading. Its worktrees (with branch and git status) are read
// over ssh, a task makes a worktree there, and its terminals and agent CLI run there over
// `ssh -t`: held on the host by Kingu's terminal daemon where it could be installed
// (sshHolders.svelte.ts), so they outlive a dropped connection and their tab shows them again
// after the reconnect; else an agent is started again with its resume command. Rust's
// ssh_projects.rs keeps the record in projects.json (with `host` set) and runs every git command
// on the host; nothing of the project is copied to this computer.
import { invoke } from '@tauri-apps/api/core';
import { t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { floating } from '#lib/workbench/floating.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { cliName } from './agentCli';
import { KNOWN_BINS, cliResume, pasteText, profileOf, programOf } from './agentProfiles';
import { denyMessage, grantKey, scopedGrants, type GrantScope } from './permissionAsk';
import { answeredHook, permissionKey, remoteAsk, type RemoteAskView } from './sshAsks';
import { askKeysFor, isComplete, typeAskKeys, type AskSelection } from '#lib/agent/ask.ts';
import { agentLink, holderId, megabytes, restorable, type AgentLink, type Consent, type ConsentAnswer, type HolderState, type TerminalMode } from './sshHolder';
import { sshHolders } from './sshHolders.svelte';
import { sshAgentInstalls } from './sshAgentInstalls.svelte';
import { windowLabel } from '#lib/workbench/windowEvents.ts';
import { openUrl } from '#lib/terminal/pty.ts';
import { hostLaunch, hostProfiles, type HostAgent } from './sshAgents';
import { sshConnections } from './sshConnections.svelte';
import { statusKey } from './sshConnection';
import { adeCommand } from '#lib/agent/launchSpec.ts';
import { projectName } from './projects';
import { sshHosts } from './sshHosts.svelte';
import type { SshTarget } from './sshHosts';
import { hostPath, remoteKey, remoteSlug, remoteWorktreePath, sortWorktrees, type RemoteProject, type RemoteWorktree } from './sshProjects';
import { baseChoices, parseFolders, remoteAgentHooks, remoteAgentStatus, remoteAgentTitle, worktreeKey, type RemoteAgent, type RemoteBranches, type SparsePreset } from './sshRemote';
import { sshWorkspace } from './sshWorkspace.svelte';
import { agentNotifyAllowed, notify } from './agentNotify.svelte';
import { noticeFor, noticeState, type NoticeState } from './agentNotify';
import type { TaskStatus } from './model';

type Listing = { rows: RemoteWorktree[] | null; loading: boolean; error: string | null };
/** An agent CLI started in a floating terminal tab, with the worktree it runs in. */
type AgentTab = RemoteAgent & { host: string; root: string; path: string; name: string; mode: TerminalMode; /** Its session in the host's terminal daemon (`held`). */ key?: string; holder?: string; /** Its CLI's profile id (which keys its question UI takes, ask.ts). */ cli?: string };
/** What Rust's `ssh_project_terminal` answers (ssh_projects.rs `TerminalRun`). */
type TerminalRun = { run: string[]; hook: string | null; key: string | null; mode: TerminalMode };
/** What Rust's `ssh_remote_status_hooks` answers (ssh_host_hooks.rs `HostHooks`). */
type HostHooks = { hooked: boolean; opencodeConfigDir: string | null };
/** A permission prompt or question of an agent on a host, as the side bar shows it (sshAsks.ts), by its tab id. */
export type RemoteAsk = RemoteAskView & { id: string; name: string };

/** How often agent states are judged again while one runs (output timing moves without events). */
const TICK_MS = 1000;
/** Output of the same tab is recorded at most this often. */
const OUTPUT_THROTTLE_MS = 500;
/** How often a claude's hook file on the host is read (one ssh call, shared connection; **estimated**). */
const HOOK_POLL_MS = 2000;

/** Kingu's default branch prefix setting (agent/worktree.rs reads the same one for local tasks). */
const prefix = () => settings.get<string>('kingu.worktree.branchPrefix') || undefined;
/** The CLI of a held session the host's daemon names by its foreground program. */
const cliOf = (command: string | null | undefined) => (command ? profileOf([command]).id : undefined);

class SshProjects {
	list = $state<RemoteProject[]>([]);
	listings = $state<Record<string, Listing>>({});
	collapsed = $state<Record<string, boolean>>({});
	/** Agent CLIs running in SSH terminals, by floating tab id. */
	agents = $state<Record<string, AgentTab>>({});
	/** A deny reason being typed under a remote permission prompt, by tab id. */
	reasons = $state<Record<string, string>>({});
	now = $state(Date.now());
	#seen = new Map<string, NoticeState>();
	#timer: ReturnType<typeof setInterval> | undefined;

	async load() {
		this.list = (await invoke<RemoteProject[]>('ssh_projects_list').catch(() => [])) ?? [];
		if (!sshHosts.targets.length && this.list.length) await sshHosts.refresh();
	}

	host(p: RemoteProject): SshTarget | undefined {
		return sshHosts.targets.find((x) => x.id === p.host);
	}

	/** Open Project on SSH Host…: pick the host, then type the path (Orca's "Host path"). */
	async addInteractive() {
		await sshHosts.refresh();
		if (!sshHosts.targets.length) return void status.flash(t('adeProjects.sshNoHosts'), 6000);
		const pick =
			sshHosts.targets.length === 1
				? { id: sshHosts.targets[0]!.id }
				: await quick.choose({
						placeholder: t('adeProjects.sshPickHost'),
						items: sshHosts.targets.map((h) => ({ id: h.id, label: h.label, description: `${h.username ? `${h.username}@` : ''}${h.host}` }))
					});
		const target = pick && sshHosts.targets.find((h) => h.id === pick.id);
		if (!target) return;
		const text = await quick.input({
			placeholder: t('adeProjects.sshPathPlaceholder', { host: target.label }),
			value: '~/',
			hint: (v) => (hostPath(v) ? t('adeProjects.sshPathAdd', { path: v.trim(), host: target.label }) : t('adeProjects.sshPathHint'))
		});
		const path = text ? hostPath(text) : null;
		if (path) await this.add(target, path);
	}

	/** Adds `path` of `target` (Rust resolves it to the repository on the host). */
	async add(target: SshTarget, path: string): Promise<boolean> {
		status.flash(t('adeProjects.sshAdding', { path, host: target.label }), 15000);
		try {
			const r = await invoke<{ project: RemoteProject; existed: boolean }>('ssh_project_add', { host: target.id, path });
			const name = `${projectName(r.project.path)} · ${target.label}`;
			status.flash(t(r.existed ? 'adeProjects.already' : 'adeProjects.added', { name }));
			await this.load();
			void this.refresh(r.project);
			return true;
		} catch (e) {
			status.flash('');
			notifications.error(t('adeProjects.sshFailed', { error: String(e) }));
			return false;
		}
	}

	async remove(p: RemoteProject) {
		try {
			await invoke('ssh_project_remove', { host: p.host, path: p.path });
			delete this.listings[remoteKey(p)];
			await this.load();
			status.flash(t('adeProjects.removed', { name: projectName(p.path) }));
		} catch (e) {
			notifications.error(t('adeProjects.removeFailed', { error: String(e) }));
		}
	}

	/**
	 * The project's worktrees with branch and status, read on the host once it is connected
	 * (Orca gates a host's repositories on its connection: new-workspace-ssh-gate.ts). `user`: the
	 * user asked, so a host that needs a passphrase may ask for it. A host that isn't connected
	 * keeps the rows read before; its state says why (sshConnections).
	 */
	async refresh(p: RemoteProject, user = false) {
		const key = remoteKey(p);
		const prev = this.listings[key];
		this.listings[key] = { rows: prev?.rows ?? null, loading: true, error: null };
		if (!(await sshConnections.connect(p.host, user))) {
			this.listings[key] = { rows: prev?.rows ?? null, loading: false, error: null };
			return;
		}
		try {
			const rows = await invoke<RemoteWorktree[]>('ssh_project_worktrees', { host: p.host, root: p.path });
			this.listings[key] = { rows: sortWorktrees(rows, p.path), loading: false, error: null };
		} catch (e) {
			this.listings[key] = { rows: prev?.rows ?? null, loading: false, error: String(e) };
			void sshConnections.suspect(p.host);
		}
	}

	/** Connect / Reconnect / Retry of a project's host; its worktrees are read again once it answers. */
	async connect(p: RemoteProject) {
		await this.refresh(p, true);
	}

	/** The host is connected, connecting it now if the user may be asked; else says why not. */
	async #ready(p: RemoteProject): Promise<boolean> {
		if (await sshConnections.connect(p.host, true)) return true;
		const st = sshConnections.state(p.host);
		notifications.error(t('sshRemote.notConnected', { host: this.host(p)?.label ?? p.host, error: st.error ?? t(statusKey(st.status)) }));
		return false;
	}

	/** The agent CLIs each host has (ssh_agents.rs), read once per connection. */
	#hostAgents = new Map<string, HostAgent[]>();

	async #agentsOn(p: RemoteProject, argv: readonly string[], again = false): Promise<HostAgent[] | null> {
		const known = this.#hostAgents.get(p.host);
		const program = programOf(argv);
		// A custom program not asked about yet needs its own look.
		if (known && !again && (KNOWN_BINS.includes(program) || known.some((f) => f.name === program))) return known;
		status.flash(t('sshRemote.agentChecking', { host: this.host(p)?.label ?? p.host }), 10000);
		try {
			const found = await invoke<HostAgent[]>('ssh_remote_agents', { id: p.host, names: [...KNOWN_BINS, program] });
			this.#hostAgents.set(p.host, found);
			return found;
		} catch {
			// The host couldn't be asked: that is not "nothing installed" (Orca's unverifiable host).
			void sshConnections.suspect(p.host);
			return null;
		} finally {
			status.flash('');
		}
	}

	/**
	 * The agent command as it can start on the project's host, or null when it can't and the user
	 * didn't pick another: a CLI the host lacks is said so, with its install page and the agents the
	 * host does have (Orca's AgentLaunchInstallPrompt and its per-host agent list).
	 */
	async #agentForHost(p: RemoteProject, argv: string[]): Promise<string[] | null> {
		let again = false;
		for (;;) {
			const found = await this.#agentsOn(p, argv, again);
			if (!found) return argv;
			const launch = hostLaunch(argv, found);
			if (launch.kind === 'ok') return launch.argv;
			const agent = launch.profile.id === 'custom' ? launch.program : launch.profile.title;
			const others = hostProfiles(found).filter((x) => x.profile.id !== launch.profile.id);
			// Kingu can install this CLI on the host itself (sshAgentInstalls: asked first, Never per host).
			const hostLabel = this.host(p)?.label ?? p.host;
			const kinguInstall = launch.program === programOf(argv) && sshAgentInstalls.mayOffer(p.host, launch.profile.id);
			const pick = await quick.choose({
				placeholder: t('sshRemote.agentMissing', { agent }),
				items: [
					...(kinguInstall ? [{ id: '\u0000kingu', label: t('sshAgentInstall.offer', { agent, host: hostLabel }), description: '~/.kingu/agent-runtimes' }] : []),
					...(launch.installPage ? [{ id: '\u0000install', label: t('sshRemote.agentInstall', { agent }), description: launch.installPage }] : []),
					...others.map((x) => ({ id: x.bin, label: t('sshRemote.agentRunOther', { agent: x.profile.title }), description: x.bin })),
					{ id: '\u0000again', label: t('sshRemote.agentRecheck'), description: this.host(p)?.label ?? p.host }
				]
			});
			if (!pick) return null;
			if (pick.id === '\u0000kingu') {
				if (!(await sshAgentInstalls.offer(p.host, hostLabel, launch.profile.id))) return null;
				again = true;
				continue;
			}
			if (pick.id === '\u0000install') {
				void openUrl(launch.installPage!);
				return null;
			}
			if (pick.id === '\u0000again') {
				again = true;
				continue;
			}
			const next = adeCommand(pick.id, (k) => settings.get(k));
			if (!next) return null;
			argv = next;
			again = false;
		}
	}

	toggle(p: RemoteProject) {
		const key = remoteKey(p);
		this.collapsed[key] = !this.collapsed[key];
		if (!this.collapsed[key] && !this.listings[key]) void this.refresh(p);
	}

	/** New Task on the host: a name, a base branch and a sparse checkout preset → `git worktree add` of `<root>/.kingu/worktrees/<slug>`. */
	async newTask(p: RemoteProject) {
		if (!(await this.#ready(p))) return;
		const label = this.host(p)?.label ?? p.host;
		const pre = prefix() ?? 'kingu/';
		const title = await quick.input({
			placeholder: t('adeProjects.sshTaskPlaceholder'),
			hint: (v) => {
				const slug = remoteSlug(v || 'task');
				return t('adeProjects.sshTaskHint', { path: remoteWorktreePath(p.path, slug), branch: `${pre}${slug}` });
			}
		});
		if (!title) return;
		const slug = remoteSlug(title);
		const base = await this.#pickBase(p);
		if (base === undefined) return;
		const sparse = await this.#pickSparse(p);
		if (sparse === undefined) return;
		status.flash(t('adeProjects.sshCreating', { slug, host: label }), 120000);
		try {
			const path = await invoke<string>('ssh_project_worktree_add', { host: p.host, root: p.path, slug, base, prefix: prefix() ?? null, sparse: sparse.length ? sparse : null });
			status.flash(t('adeProjects.sshCreated', { slug, host: label }), 5000);
			await this.refresh(p);
			await this.terminal(p, path, true);
		} catch (e) {
			status.flash('');
			notifications.error(t('adeProjects.sshFailed', { error: String(e) }));
		}
	}

	/** The base branch (origin's default first; "current HEAD" keeps the old behaviour); undefined: cancelled. */
	async #pickBase(p: RemoteProject): Promise<string | null | undefined> {
		status.flash(t('sshRemote.readingBranches'), 15000);
		const b = await invoke<RemoteBranches>('ssh_remote_branches', { host: p.host, root: p.path }).catch(() => ({ branches: [], default: null }) as RemoteBranches);
		status.flash('');
		const items = [{ id: '', label: t('sshRemote.baseHead'), description: 'HEAD' }, ...baseChoices(b).map((x) => ({ id: x, label: x, description: x === b.default ? t('sshRemote.baseDefault') : undefined }))];
		const pick = await quick.choose({ placeholder: t('sshRemote.pickBase'), items, activeId: b.default ?? '' });
		return pick ? pick.id || null : undefined;
	}

	/** A sparse checkout preset of the project (kept on the host), typed folders, or the whole tree; undefined: cancelled. */
	async #pickSparse(p: RemoteProject): Promise<string[] | undefined> {
		const presets = await invoke<SparsePreset[]>('ssh_remote_presets', { host: p.host, root: p.path }).catch(() => [] as SparsePreset[]);
		const items = [
			{ id: '', label: t('sshRemote.sparseNone') },
			...presets.map((x) => ({ id: x.id, label: x.name, description: x.directories.join(', ') })),
			{ id: '\u0000custom', label: t('sshRemote.sparseCustom') }
		];
		const pick = await quick.choose({ placeholder: t('sshRemote.pickSparse'), items });
		if (!pick) return undefined;
		if (!pick.id) return [];
		if (pick.id === '\u0000custom') {
			const text = await quick.input({ placeholder: t('sshRemote.sparseFolders'), hint: (v) => (parseFolders(v).length ? t('sshRemote.sparseOnly', { folders: parseFolders(v).join(', ') }) : t('sshRemote.sparseFolders')) });
			const folders = text ? parseFolders(text) : [];
			return folders.length ? folders : undefined;
		}
		return presets.find((x) => x.id === pick.id)?.directories ?? [];
	}

	/**
	 * The host's holder (found, or installed now when the user allowed it for this host), saying
	 * once what it means for the host's terminals. `ask`: the user is starting something there, so a
	 * host never asked about is asked now (Install / Not now / Never for this host).
	 */
	async #holder(p: RemoteProject, ask = false): Promise<HolderState> {
		const label = this.host(p)?.label ?? p.host;
		const question = async ({ size }: { platform: string; size: number }): Promise<ConsentAnswer | null> => {
			// The whole question above the list (the placeholder would cut it off), a short one in the box.
			const pick = await quick.choose({
				title: t('sshRemote.holder.askTitle', { host: label }),
				message: [{ text: t('sshRemote.holder.ask', { host: label, size: megabytes(size) }) }],
				placeholder: t('sshRemote.holder.askPlaceholder'),
				items: [
					{ id: 'install', label: t('sshRemote.holder.askInstall'), description: '~/.kingu/host' },
					{ id: 'later', label: t('sshRemote.holder.askLater') },
					{ id: 'never', label: t('sshRemote.holder.askNever') }
				]
			});
			return (pick?.id as ConsentAnswer | undefined) ?? null;
		};
		const s = await sshHolders.ensure(p.host, ask ? question : undefined);
		if (this.#toldHolder.get(p.host) === s.phase) return s;
		this.#toldHolder.set(p.host, s.phase);
		if (s.phase === 'ready' && s.installedNow) notifications.info(t('sshRemote.holder.installed', { host: label }));
		else if (s.phase === 'unsupported') status.flash(`${label}: ${t('sshRemote.holder.unsupported', { platform: s.platform ?? '' })}`, 12000);
		else if (s.phase === 'no-artefact') status.flash(`${label}: ${t('sshRemote.holder.noArtefact', { platform: s.platform ?? '', triple: s.triple ?? '' })}`, 12000);
		else if (s.phase === 'failed') status.flash(`${label}: ${t('sshRemote.holder.failed', { error: s.error ?? '' })}`, 12000);
		return s;
	}
	#toldHolder = new Map<string, string>();

	/** What the reattach loop says in the terminal (Rust ssh_holder.rs `LoopText`). */
	#loopText(host: string) {
		return {
			lostHeld: t('sshRemote.loop.lostHeld', { host }),
			lostRestart: t('sshRemote.loop.lostRestart', { host }),
			lostGone: t('sshRemote.loop.lostGone', { host }),
			reattaching: t('sshRemote.loop.reattaching', { host }),
			restarting: t('sshRemote.loop.restarting', { host }),
			ended: t('sshRemote.loop.ended'),
			gaveUp: t('sshRemote.loop.gaveUp')
		};
	}

	/** Held plain shells open in this window, by floating tab id (agents are in `agents`). */
	#shells = new Map<string, string>();

	/**
	 * A terminal in `path` on the host, as a tab of the floating workspace (it needs no local folder
	 * open); `agent`: running the agent CLI (kingu.agent.cli), whose status its hooks, the tab's
	 * title and its output give (sshRemote.ts) and whose changes notify like a local task's. On a
	 * connected host with a holder the terminal is held there (`mode: 'held'`).
	 */
	async terminal(p: RemoteProject, path: string, agent = false) {
		let argv: string[] | null = null;
		if (agent) {
			const configured = adeCommand(null, (k) => settings.get(k));
			if (!configured) return void notifications.error(t('adeProjects.sshAgentBad'));
			if (!(await this.#ready(p))) return;
			argv = await this.#agentForHost(p, configured);
			if (!argv) return;
		}
		// A host that isn't connected yet gets the plain ssh it always got (it may ask for a passphrase itself).
		const connected = sshConnections.state(p.host).status === 'connected';
		const holder = connected ? holderId(await this.#holder(p, true)) : null;
		const hold = !!argv && connected && profileOf(argv).id === 'claude' && (await sshHolders.hold(p.host));
		let resume = argv ? cliResume(argv) : null;
		// Orca's managed agent hooks, on the host: another CLI's status hooks are in its config there
		// before it starts (claude takes its own per session); opencode gets Kingu's plugin folder as
		// its OPENCODE_CONFIG_DIR, as locally. A failure leaves the title as its status.
		if (argv && connected && profileOf(argv).id !== 'claude' && settings.get<boolean>('kingu.agent.statusHooks') !== false) {
			const r = await invoke<HostHooks>('ssh_remote_status_hooks', { id: p.host, agent: profileOf(argv).id }).catch(() => null);
			const dir = r?.opencodeConfigDir;
			if (dir) {
				const withDir = (a: string[]) => ['env', `OPENCODE_CONFIG_DIR=${dir}`, ...a];
				argv = withDir(argv);
				resume = resume && withDir(resume);
			}
		}
		const label = this.host(p)?.label ?? p.host;
		try {
			const r = await invoke<TerminalRun>('ssh_project_terminal', { host: p.host, root: p.path, path, agent: argv, resume, holder, hold, text: this.#loopText(label) });
			const leaf = path === p.path ? projectName(p.path) : (path.split('/').pop() ?? path);
			const name = `${leaf} · ${label}`;
			if (r.key && holder) sshHolders.remember(r.key, { host: p.host, root: p.path, path, name, holder, ...(r.hook ? { token: r.hook } : {}), ...(argv ? { agent: true } : {}) });
			this.#open({ host: p.host, root: p.path, path, name, title: `${argv ? cliName(argv) : 'ssh'} ${label}:${leaf}`, run: r.run, mode: r.mode, key: r.key, holder, token: r.hook, agent: !!argv, cli: argv ? profileOf(argv).id : undefined });
		} catch (e) {
			notifications.error(t('adeProjects.sshFailed', { error: String(e) }));
		}
	}

	/** Opens the floating terminal tab of a remote terminal and, for an agent, follows its status. */
	#open(o: { host: string; root: string; path: string; name: string; title: string; run: string[]; mode: TerminalMode; key: string | null; holder: string | null; token: string | null; agent: boolean; cli?: string }) {
		// Closing the tab ends a held session: nothing would show it again, and it would run on.
		const end = () => {
			if (o.key && o.holder) void sshHolders.end(o.host, o.holder, o.key);
		};
		if (!o.agent) {
			let id = '';
			id = floating.newTerminal({
				title: o.title,
				run: o.run,
				watch: {
					closed: () => {
						this.#shells.delete(id);
						end();
					}
				}
			});
			if (o.key) this.#shells.set(id, o.key);
			return;
		}
		let id = '';
		id = floating.newTerminal({
			title: o.title,
			run: o.run,
			watch: {
				title: (x) => this.agents[id] && (this.agents[id] = remoteAgentTitle(this.agents[id]!, x, Date.now()) as AgentTab),
				output: () => {
					const a = this.agents[id];
					const now = Date.now();
					if (a && now - (a.lastOutput ?? 0) > OUTPUT_THROTTLE_MS) this.agents[id] = { ...a, lastOutput: now };
				},
				closed: () => {
					const a = this.agents[id];
					if (a?.hookToken) void invoke('ssh_remote_hook_clear', { host: a.host, root: a.root, token: a.hookToken }).catch(() => {});
					end();
					delete this.agents[id];
					delete this.reasons[id];
					this.#seen.delete(id);
				}
			}
		});
		this.agents[id] = { host: o.host, root: o.root, path: o.path, name: o.name, startedAt: Date.now(), mode: o.mode, ...(o.key && o.holder ? { key: o.key, holder: o.holder } : {}), ...(o.token ? { hookToken: o.token, hookOffset: 0 } : {}), ...(o.cli ? { cli: o.cli } : {}) };
		this.#tick();
	}

	/**
	 * SSH: Reattach Terminal on Host…: the terminals the host's daemon still holds that aren't open
	 * in this window (after Kingu restarted, or its tab's loop was stopped), each opened again in a
	 * tab; one Kingu started here keeps its name, and an agent its hook file.
	 */
	async reattach() {
		await this.load();
		const hosts = [...new Set(this.list.map((x) => x.host))];
		if (!hosts.length) return void this.addInteractive();
		const labelOf = (id: string) => sshHosts.targets.find((x) => x.id === id)?.label ?? id;
		const pick = hosts.length === 1 ? { id: hosts[0]! } : await quick.choose({ placeholder: t('sshRemote.reattach.pickHost'), items: hosts.map((id) => ({ id, label: labelOf(id) })) });
		if (!pick) return;
		const host = pick.id;
		const p = this.list.find((x) => x.host === host)!;
		if (!(await this.#ready(p))) return;
		const holder = holderId(await this.#holder(p));
		if (!holder) return void status.flash(t('sshRemote.reattach.noHolder', { host: labelOf(host) }), 8000);
		try {
			const open = this.#openKeys();
			const sessions = (await sshHolders.sessions(host)).filter((x) => !open.has(x.key));
			if (!sessions.length) return void status.flash(t('sshRemote.reattach.none', { host: labelOf(host) }), 6000);
			const records = sshHolders.records();
			const chosen = await quick.choose({
				placeholder: t('sshRemote.reattach.pick', { host: labelOf(host) }),
				items: sessions.map((x) => ({ id: x.key, label: records[x.key]?.name ?? t('sshRemote.reattach.unnamed', { path: x.cwd }), description: x.command ?? x.cwd }))
			});
			const session = chosen && sessions.find((x) => x.key === chosen.id);
			if (!session) return;
			const rec = records[session.key];
			const run = await invoke<string[]>('ssh_holder_reattach', { id: host, holder, key: session.key, text: this.#loopText(labelOf(host)) });
			const name = rec?.name ?? `${session.cwd.split('/').pop() ?? session.cwd} · ${labelOf(host)}`;
			this.#open({ host, root: rec?.root ?? p.path, path: rec?.path ?? session.cwd, name, title: `${session.command ?? 'ssh'} ${name}`, run, mode: 'held', key: session.key, holder, token: rec?.token ?? null, agent: !!rec?.agent, cli: cliOf(session.command) });
		} catch (e) {
			notifications.error(t('adeProjects.sshFailed', { error: String(e) }));
		}
	}

	/** The held sessions open in tabs of this window. */
	#openKeys(): Set<string> {
		return new Set([...this.#shells.values(), ...Object.values(this.agents).flatMap((a) => (a.key ? [a.key] : []))]);
	}

	/** Hosts whose held tabs were looked for since Kingu started. */
	#restoredHosts = new Set<string>();

	/**
	 * After Kingu restarted, the first time a host connects: the terminals this computer started
	 * there that its daemon still holds are opened again in tabs by themselves, each reattached
	 * (Orca restores remote panes into their saved tabs on launch). Only the first window does it,
	 * so two windows never show the same session twice.
	 */
	async #restoreHeld(host: string) {
		if (this.#restoredHosts.has(host) || windowLabel() !== 'main') return;
		this.#restoredHosts.add(host);
		const p = this.list.find((x) => x.host === host);
		if (!p || !Object.values(sshHolders.records()).some((r) => r.host === host)) return;
		const holder = holderId(await this.#holder(p));
		if (!holder) return;
		const label = this.host(p)?.label ?? host;
		let opened = 0;
		try {
			const sessions = await sshHolders.sessions(host);
			for (const [key, rec] of restorable(sshHolders.records(), host, sessions.map((s) => s.key), this.#openKeys())) {
				const s = sessions.find((x) => x.key === key);
				const run = await invoke<string[]>('ssh_holder_reattach', { id: host, holder, key, text: this.#loopText(label) });
				this.#open({ host, root: rec.root, path: rec.path, name: rec.name, title: `${s?.command ?? 'ssh'} ${rec.name}`, run, mode: 'held', key, holder, token: rec.token ?? null, agent: !!rec.agent, cli: cliOf(s?.command) });
				opened++;
			}
		} catch {
			// The host went away meanwhile: SSH: Reattach Terminal on Host… still finds them.
			this.#restoredHosts.delete(host);
		}
		if (opened) status.flash(t('sshRemote.restored', { count: opened, host: label }), 6000);
	}

	/** SSH: Hosts…: the kept answer for installing the terminal host changed; a connected host is looked at again. */
	setHolderConsent(host: string, c: Consent | null) {
		sshHolders.setConsent(host, c);
		this.#toldHolder.delete(host);
		const p = this.list.find((x) => x.host === host);
		if (p && sshConnections.state(host).status === 'connected') void this.#holder(p);
	}

	/** The side bar's Install terminal host…: asks now (Not now earlier in this run is asked again). */
	async installHolder(p: RemoteProject) {
		if (sshHolders.consent(p.host) === 'later') sshHolders.setConsent(p.host, null);
		if (await this.#ready(p)) await this.#holder(p, true);
	}

	/** `kingu.agent.statusHooks` is off: Kingu's entries leave the host's CLI configs (nothing to do without a record). */
	async #unhook(host: string) {
		try {
			const r = await invoke<{ restored: string[]; stripped: string[]; failed: string[] }>('ssh_remote_status_hooks_remove', { id: host });
			if (r.failed.length) notifications.warn(t('sshRemote.hooksRemoveFailed', { host: sshHosts.targets.find((x) => x.id === host)?.label ?? host, error: r.failed.join('; ') }));
		} catch {
			// The host went away: its next connection tries again.
		}
	}

	/** How the agents of a worktree stand while their host is away (the most telling one), or null while it is connected. */
	link(host: string, path: string): Exclude<AgentLink, 'live'> | null {
		const st = sshConnections.state(host).status;
		const rank: Record<AgentLink, number> = { live: 3, held: 0, restarting: 1, lost: 2 };
		let best: AgentLink = 'live';
		for (const a of Object.values(this.agents)) {
			if (worktreeKey(a.host, a.path) !== worktreeKey(host, path)) continue;
			const l = agentLink(a.mode, st);
			if (rank[l] < rank[best]) best = l;
		}
		return best === 'live' ? null : best;
	}

	/** Tabs whose prompt is being answered now (their card's buttons wait). */
	answering = $state<Record<string, boolean>>({});

	/** The open permission prompts and questions of the agents in a worktree, expired ones included (sshAsks.ts). */
	asks(host: string, path: string): RemoteAsk[] {
		const out: RemoteAsk[] = [];
		const connected = sshConnections.state(host).status === 'connected';
		for (const [id, a] of Object.entries(this.agents)) {
			if (worktreeKey(a.host, a.path) !== worktreeKey(host, path)) continue;
			const view = remoteAsk(a.hook, { connected, hooked: !!a.hookToken, now: this.now });
			if (view) out.push({ ...view, id, name: a.name });
		}
		return out;
	}

	/** The card's prompt of tab `id` now, or why it can't be answered (said in the status bar). */
	#askOf(id: string, kind: RemoteAsk['kind']): { a: AgentTab; view: RemoteAskView } | null {
		const a = this.agents[id];
		const view = a && remoteAsk(a.hook, { connected: sshConnections.state(a.host).status === 'connected', hooked: !!a.hookToken, now: Date.now() });
		if (!a || !view || view.kind !== kind) return void status.flash(t('sshRemote.perm.gone'), 6000), null;
		if (view.route === 'expired') return void status.flash(t(view.expired === 'timeout' ? 'sshRemote.ask.expiredTimeout' : 'sshRemote.ask.expiredDisconnected', { host: this.#label(a.host) }), 8000), null;
		return { a, view };
	}

	#label(host: string) {
		return sshHosts.targets.find((x) => x.id === host)?.label ?? host;
	}

	/** The answer reached the agent: its card goes until the next hook event says more (cliSessions.svelte.ts does the same). */
	#answered(id: string, allow: boolean, question = false) {
		const cur = this.agents[id];
		if (cur?.hook) this.agents[id] = { ...cur, hook: answeredHook(cur.hook, { allow, question, message: t('ade.cli.answered'), now: Date.now() }) };
		delete this.reasons[id];
	}

	/**
	 * Answers an agent's permission prompt on the host from the side bar, the two ways Orca answers
	 * a remote one: a claude waiting in Kingu's hold there gets Claude's own decision, written over
	 * the host's ssh connection to the answer file the hold script waits for (allow once, with the
	 * grants shown for `scope`: this session, or Claude's suggested rules saved by that claude in
	 * this project / everywhere, or deny with the reason typed); else Enter / Esc go into its
	 * terminal, whose `ssh -t` carries them to the agent on the host. A grant is never sent as
	 * keys, and an expired prompt (the hold's 122 s ran out, or the connection dropped) is never
	 * answered: claude then asks in its own terminal.
	 */
	async answer(id: string, allow: boolean, scope?: GrantScope) {
		const got = this.#askOf(id, 'permission');
		if (!got || this.answering[id]) return;
		const { a, view } = got;
		const shown = scope ? scopedGrants(view.grants, scope).map(grantKey) : null;
		if (scope && (view.route !== 'hold' || !shown?.length)) return void status.flash(t('sshRemote.perm.gone'), 6000);
		// The reason typed under the prompt goes with a deny (the local card's rules, permissionAsk.ts).
		const message = allow ? null : (denyMessage(this.reasons[id]) ?? null);
		this.answering[id] = true;
		try {
			if (view.route === 'hold') {
				const answered = await invoke<boolean>('ssh_remote_permission_answer', { host: a.host, root: a.root, token: a.hookToken, hold: view.hold, allow, session: shown, message, scope: scope ?? null });
				if (!answered) {
					// The hold ended without this answer (its budget, or claude moved on): expired, never retried.
					const cur = this.agents[id];
					const h = cur?.hook;
					if (cur && h?.hold && h.hold.id === view.hold) this.agents[id] = { ...cur, hook: { ...h, hold: { id: h.hold.id, since: 0 } } };
					return void status.flash(t('sshRemote.ask.expiredTimeout', { host: this.#label(a.host) }), 8000);
				}
			} else if (view.route === 'keys') {
				await invoke('pty_write', { key: floating.terminalKey(id), data: permissionKey(allow) });
			} else return;
			this.#answered(id, allow);
		} catch (e) {
			notifications.error(t('sshRemote.perm.failed', { error: String(e) }));
		} finally {
			delete this.answering[id];
		}
	}

	/**
	 * Answers a question an agent on the host asks (its hooks carried the options) by typing the
	 * keys its question UI takes (ask.ts) into its terminal, as the local card does and as Orca sends
	 * a remote pane's answer through its PTY. Stops if the host drops or the tab closes meanwhile.
	 */
	async answerQuestion(id: string, selections: AskSelection[]): Promise<boolean> {
		const got = this.#askOf(id, 'question');
		if (!got || this.answering[id]) return false;
		const { a, view } = got;
		if (view.route !== 'keys' || !view.ask || !isComplete(view.ask, selections)) return false;
		const key = floating.terminalKey(id);
		this.answering[id] = true;
		try {
			const done = await typeAskKeys(askKeysFor(a.cli ?? 'claude', view.ask, selections), {
				write: (data) => invoke('pty_write', { key, data }),
				paste: pasteText,
				wait: (ms) => new Promise((r) => setTimeout(r, ms)),
				live: () => !!this.agents[id] && sshConnections.state(a.host).status === 'connected'
			});
			if (!done) return void status.flash(t('sshRemote.ask.expiredDisconnected', { host: this.#label(a.host) }), 8000), false;
			this.#answered(id, true, true);
			return true;
		} catch (e) {
			notifications.error(t('sshRemote.perm.failed', { error: String(e) }));
			return false;
		} finally {
			delete this.answering[id];
		}
	}

	/** Brings the agent's terminal tab to the front (what can only be answered there). */
	showTerminal(id: string) {
		floating.select(id);
		floating.show();
	}

	/** The most urgent status of the agents running in a worktree (needs you > working > done), or null. */
	status(host: string, path: string): TaskStatus | null {
		const rank: Partial<Record<TaskStatus, number>> = { waiting: 0, failed: 0, running: 1, review: 2 };
		let best: TaskStatus | null = null;
		for (const a of Object.values(this.agents)) {
			if (worktreeKey(a.host, a.path) !== worktreeKey(host, path)) continue;
			const s = remoteAgentStatus(a, this.now);
			if (s && (best === null || (rank[s] ?? 3) < (rank[best] ?? 3))) best = s;
		}
		return best;
	}

	/** Judges every agent again and notifies its changes (Orca's notifications, agentNotify.ts rules). */
	#tick() {
		this.now = Date.now();
		const ids = Object.keys(this.agents);
		if (ids.length && !this.#timer) this.#timer = setInterval(() => this.#tick(), TICK_MS);
		if (!ids.length && this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		if (this.now - this.#hooksAt >= HOOK_POLL_MS) {
			this.#hooksAt = this.now;
			for (const id of ids) void this.#readHooks(id);
		}
		const events = settings.get<string>('kingu.agent.notifications.events');
		for (const id of ids) {
			const a = this.agents[id]!;
			const next = noticeState(remoteAgentStatus(a, this.now) ?? 'done', a.hook?.question);
			const notice = agentNotifyAllowed() ? noticeFor(this.#seen.get(id), next, { title: a.name, lastEvent: a.hook?.message }, events) : null;
			this.#seen.set(id, next);
			if (notice) void notify(notice.title, notice.body);
		}
	}

	/** Hosts whose connection dropped and hasn't come back yet. */
	#dropped = new Set<string>();
	#hooksAt = 0;
	#reading = new Set<string>();

	/** New hook events of a claude on the host (its file there, read over ssh; one read at a time per agent). */
	async #readHooks(id: string) {
		const a = this.agents[id];
		if (!a?.hookToken || this.#reading.has(id)) return;
		// A host that dropped is being redialled (sshConnections): reads wait for it instead of piling up.
		if (sshConnections.state(a.host).status !== 'connected') return;
		this.#reading.add(id);
		try {
			const r = await invoke<{ events: object[]; offset: number }>('ssh_remote_hook_read', { host: a.host, root: a.root, token: a.hookToken, offset: a.hookOffset ?? 0 });
			const cur = this.agents[id];
			if (cur && (r.events.length || r.offset !== cur.hookOffset)) this.agents[id] = remoteAgentHooks(cur, r.events, r.offset, Date.now()) as AgentTab;
		} catch {
			// The host is unreachable for now: the title still tells, and the connection is checked.
			void sshConnections.suspect(a.host);
		} finally {
			this.#reading.delete(id);
		}
	}

	/** Removes a task worktree on the host (its branch stays); one with changes asks first. */
	async removeWorktree(p: RemoteProject, w: RemoteWorktree) {
		if (!w.slug) return;
		const force = (w.changes ?? 0) > 0;
		if (force) {
			const ok = await quick.choose({ placeholder: t('adeProjects.sshRemoveForce', { slug: w.slug }), items: [{ id: 'yes', label: t('adeProjects.sshRemoveForceYes') }] });
			if (!ok) return;
		}
		try {
			await invoke('ssh_project_worktree_remove', { host: p.host, root: p.path, slug: w.slug, force });
			status.flash(t('adeProjects.sshRemoved', { slug: w.slug }), 5000);
		} catch (e) {
			notifications.error(t('adeProjects.sshFailed', { error: String(e) }));
		}
		await this.refresh(p);
	}

	/** SSH: Open Remote Folder…: an added SSH project (or one of its task worktrees) as the folder you work in. */
	/** A worktree of an SSH project as this window's workspace, shown in the IDE (Rust remote_ws.rs). */
	async openWorktree(p: RemoteProject, path: string) {
		if (await workspace.openRemote(p.host, p.path, path)) appMode.setMode('workbench');
	}

	async openFolder(p?: RemoteProject, page = false) {
		if (!p) {
			await this.load();
			if (!this.list.length) return void this.addInteractive();
			const pick = await quick.choose({
				placeholder: t('sshRemote.pickProject'),
				items: this.list.map((x) => ({ id: remoteKey(x), label: projectName(x.path), description: `${this.host(x)?.label ?? x.host}:${x.path}` }))
			});
			p = pick ? this.list.find((x) => remoteKey(x) === pick.id) : undefined;
			if (!p) return;
		}
		await this.refresh(p);
		const rows = this.listings[remoteKey(p)]?.rows ?? [];
		const tasks = rows.filter((w) => w.slug);
		let path = p.path;
		if (tasks.length) {
			const pick = await quick.choose({
				placeholder: t('sshRemote.pickWorktree'),
				items: [{ id: p.path, label: t('adeProjects.sshMain'), description: p.path }, ...tasks.map((w) => ({ id: w.path, label: w.slug!, description: w.branch ?? '' }))]
			});
			if (!pick) return;
			path = pick.id;
		}
		if (page) await sshWorkspace.open(p, path);
		else await this.openWorktree(p, path);
	}

	install(): () => void {
		void this.load().then(() => {
			this.list.forEach((p) => void this.refresh(p));
			sshWorkspace.restore(this.list);
		});
		// Orca removes its managed hooks when status hooks are turned off (never at startup): every
		// connected host Kingu wrote entries on has them taken out (cliSessions does this locally).
		let statusHooks: boolean | undefined;
		const stopEffects = $effect.root(() => {
			$effect(() => {
				const on = settings.get<boolean>('kingu.agent.statusHooks') !== false;
				if (statusHooks === true && !on) {
					void invoke<string[]>('ssh_remote_status_hooks_hosts')
						.then((hosts) => hosts.filter((h) => sshConnections.state(h).status === 'connected').forEach((h) => void this.#unhook(h)))
						.catch(() => {});
				}
				statusHooks = on;
			});
		});
		const offs = [
			stopEffects,
			sshConnections.install(),
			// A host that came back (Orca re-reads a host's state on `connected`): its worktrees are read
			// again and its agent CLIs are looked for anew; a drop and a return are said in the status bar.
			sshConnections.onChange((id, state, previous) => {
				const label = sshHosts.targets.find((x) => x.id === id)?.label ?? id;
				if (state.status === 'reconnecting' && previous.status === 'connected') {
					this.#dropped.add(id);
					status.flash(t('sshRemote.lost', { host: label }), 8000);
				}
				if (state.status !== 'connected' || previous.status === 'connected') return;
				this.#hostAgents.delete(id);
				// The holder is asked about again on every connection (the host may have changed under it).
				sshHolders.forget(id);
				this.#toldHolder.delete(id);
				const project = this.list.find((p) => p.host === id);
				// After Kingu restarted, the terminals it left held there come back in their tabs.
				if (project) void this.#holder(project).then(() => this.#restoreHeld(id));
				// Turned off while this host was away: its entries go now.
				if (settings.get<boolean>('kingu.agent.statusHooks') === false) void this.#unhook(id);
				if (this.#dropped.delete(id)) {
					status.flash(t('sshRemote.reconnected', { host: label }), 5000);
					void this.#restartForwards(id, label);
				}
				for (const p of this.list) if (p.host === id && !this.listings[remoteKey(p)]?.loading) void this.refresh(p);
			}),
			commands.register({ id: 'kingu.ssh.addProject', title: 'SSH: Open Project on SSH Host…', category: 'Agents', run: () => void this.addInteractive() }),
			commands.register({ id: 'kingu.ssh.openFolder', title: 'SSH: Open Remote Folder…', category: 'Agents', run: () => void this.openFolder() }),
			commands.register({ id: 'kingu.ssh.openFolderPage', title: 'SSH: Open Remote Folder Page…', category: 'Agents', run: () => void this.openFolder(undefined, true) }),
			commands.register({ id: 'kingu.ssh.terminal', title: 'SSH: New Remote Terminal…', category: 'Agents', run: () => void this.pickTerminal() }),
			commands.register({ id: 'kingu.ssh.reattach', title: 'SSH: Reattach Terminal on Host…', category: 'Agents', run: () => void this.reattach() })
		];
		return () => {
			offs.forEach((off) => off());
			clearInterval(this.#timer);
			this.#timer = undefined;
		};
	}

	/**
	 * After a reconnect the host's port forwards are started again (Orca's
	 * `restoreManagedHostPortForwards` on every transition to `connected`): each was its own ssh on
	 * the connection that dropped.
	 */
	async #restartForwards(id: string, label: string) {
		try {
			const r = await invoke<{ restarted: unknown[]; failed: string[] }>('ssh_forwards_restart', { targetId: id });
			if (r.failed.length) notifications.warn(t('sshRemote.forwardsFailed', { count: r.failed.length, host: label, error: r.failed.join('; ') }));
			else if (r.restarted.length) status.flash(t('sshRemote.forwardsRestarted', { count: r.restarted.length, host: label }), 5000);
			if (r.restarted.length || r.failed.length) await sshHosts.refresh();
		} catch {
			// The host went away again: the next reconnect tries once more.
		}
	}

	/** SSH: New Remote Terminal…: the open remote folder's, else an added project's root (no local folder needed). */
	async pickTerminal() {
		const c = sshWorkspace.current;
		if (c) return this.terminal(c.project, c.path);
		await this.load();
		const pick =
			this.list.length === 1
				? { id: remoteKey(this.list[0]!) }
				: await quick.choose({ placeholder: t('sshRemote.pickProject'), items: this.list.map((x) => ({ id: remoteKey(x), label: projectName(x.path), description: `${this.host(x)?.label ?? x.host}:${x.path}` })) });
		const p = pick && this.list.find((x) => remoteKey(x) === pick.id);
		if (p) await this.terminal(p, p.path);
		else if (!this.list.length) void this.addInteractive();
	}
}

export const sshProjects = new SshProjects();
