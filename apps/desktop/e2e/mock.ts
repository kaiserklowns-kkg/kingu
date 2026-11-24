import type { Page } from '@playwright/test';
import type { SetupReport } from '../src/lib/setup/setup';

export const READY: SetupReport = {
	os: 'macos',
	arch: 'aarch64',
	checks: [
		{ id: 'git', status: 'ok', detail: 'git version 2.43.0' },
		{ id: 'agents', status: 'ok', found: ['claude', 'codex'] },
		{ id: 'gh', status: 'ok', detail: 'gh version 2.40.0 (2024-01-01)' },
		{ id: 'gh_auth', status: 'ok', detail: 'github.com' },
		{ id: 'ripgrep', status: 'ok', detail: 'ripgrep 14.1.0' },
		{ id: 'shell', status: 'ok', detail: '/bin/zsh' }
	]
};

export const BLOCKED: SetupReport = {
	...READY,
	checks: READY.checks.map((c) =>
		c.id === 'agents'
			? { id: 'agents', status: 'fail' as const }
			: c.id === 'gh'
				? { id: 'gh', status: 'warn' as const }
				: c
	)
};

/**
 * What a test seeds beyond the defaults. `managed`: Copilot is an agent CLI Kingu can install
 * (managed_cli_*) and none is on the computer. `ssh`: one saved SSH host (`box`) with one project
 * (`/srv/app`); its dials answer as `__e2e.ssh` says (`{ connect: 'hold' }`: the first dial waits).
 * `signIn`: the chat's agent is signed out (agent-host acpSignIn.ts): `browser` (Kingu's
 * Antigravity server) answers Sign in with Google's link and then the turn; `terminal` (agy) asks
 * for its own login first; `cursor` is Cursor's `cursor-agent login` in a terminal. Each
 * `agent_sign_in` is counted in `__e2e.calls`.
 */
/**
 * Chat resilience (chatResume.ts, chatLimits.ts): `chats` seeds chats.json; `cutOff` is what
 * `chat_cut_off` says of a chat Kingu's exit cut off; `usageLimit`: every run stops on this
 * usage-limit error. `__e2e.starts` keeps each `agent_start`'s prompt and resume.
 */
export type ResilienceOpts = { chats?: unknown[]; cutOff?: { crash: boolean; partial: string | null }; usageLimit?: string };

export type MockOpts = ResilienceOpts & {
	/** Arkai has a provider with models and one model router (`arkai_providers`, `arkai_model_routers`). */
	arkai?: boolean;
	probeFail?: boolean;
	live?: boolean;
	worktrees?: unknown[];
	jira?: boolean;
	managed?: boolean;
	ssh?: boolean | { connect: string };
	/** `key`: Kingu's Antigravity server on a Gemini API key account (no Google page; the card points at Settings). */
	signIn?: 'browser' | 'terminal' | 'key' | 'cursor';
	/**
	 * What `antigravity_chat_auth_detect` finds on the computer (agent/antigravity_auth.rs `detect`):
	 * a Gemini API key (`apiKey`: where), a gcloud ADC login with `gcloud` as its project, a Google
	 * sign-in Kingu's server saved. Lists Antigravity among the chat's agents; the method is read
	 * from `kingu.agent.antigravityChatAuth` and `liveChats` from the running runs.
	 */
	agyDetect?: { apiKey?: 'saved' | 'environment'; gcloud?: string; google?: boolean };
	/**
	 * The sandbox stopped the run's Bash command (agent-host sandbox/retry.ts): the run asks to retry
	 * with a `path` grant (read/write on ~/.cache/tool) or a `domain` grant (registry.npmjs.org).
	 * Each `agent_answer_permission` is kept in `__e2e.agentAnswers`; the run then finishes.
	 */
	sandboxRetry?: 'path' | 'domain';
	/**
	 * MCP Apps (agent/McpAppFrame.svelte): the run calls `mcp__charts__show_chart`, whose `ui://`
	 * page the test serves at `http://kingu-mcp-app.localhost/` (`mcp_app_open`). The app's requests,
	 * published tools and tool results are kept in `__e2e.mcpApp`; `__e2e.mcpApp.send(event)` sends
	 * the run's next event.
	 */
	mcpApp?: boolean;
	/** The run's agent asks to open a browser page (agent-host browser.ts), as a Codex run's MCP call does. */
	browserAsk?: boolean;
};

/** The Google sign-in link the `signIn: 'browser'` agent reports. */
export const SIGN_IN_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=e2e&redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2F&response_type=code&state=e2e';

/** Fake Tauri IPC: enough for boot and Settings; unknown commands resolve to null and are logged. */
export async function mockTauri(
	page: Page,
	setup: SetupReport = READY,
	workspace = '/tmp/kingu-e2e',
	initialSettings: Record<string, unknown> = {},
	initialOpts: MockOpts = {}
) {
	await page.addInitScript(
		({ setup, workspace, initialSettings, initialOpts }) => {
			// An MCP App's frame (served by the test) gets nothing of the mocked app: not its IPC either.
			if (location.hostname.endsWith('kingu-mcp-app.localhost')) return;
			const noop = () => 0;
			const settingsKey = '__kingu_e2e_settings';
			const file = { content: sessionStorage.getItem(settingsKey) ?? JSON.stringify(initialSettings) };
			const files: Record<string, string> = {
				'README.md': '# Kingu E2E\n\nA test workspace.\n',
				'package.json': '{\n  "name": "kingu-e2e"\n}\n',
				'src/main.ts': 'export const answer = 42;\n',
				'src/App.svelte': '<script>\n  let name = "Kingu";\n</script>\n\n<h1>Hello {name}</h1>\n'
			};
			const dirs: Record<string, { name: string; rel: string; is_dir: boolean }[]> = {
				'': [
					{ name: 'src', rel: 'src', is_dir: true },
					{ name: 'package.json', rel: 'package.json', is_dir: false },
					{ name: 'README.md', rel: 'README.md', is_dir: false }
				],
				src: [
					{ name: 'App.svelte', rel: 'src/App.svelte', is_dir: false },
					{ name: 'main.ts', rel: 'src/main.ts', is_dir: false }
				]
			};
			const text = (rel: string) => {
				if (!(rel in files)) throw new Error(`ENOENT: ${rel}`);
				const content = files[rel];
				return { kind: 'text', content, encoding: 'utf8', lossy: false, stat: { mtime: 1700000000000, size: content.length, hash: 'e2e' } };
			};
			// Tasks outlive a reload of the page (sessionStorage), as the real tasks file does.
			const tasksKey = '__kingu_e2e_tasks';
			const taskList: any[] = JSON.parse(sessionStorage.getItem(tasksKey) ?? '[]');
			const status = {
				branch: 'main',
				head: 'abc1234',
				upstream: 'origin/main',
				ahead: 1,
				behind: 0,
				detached: false,
				upstream_gone: false,
				remotes: ['origin'],
				operation: null,
				entries: [
					{ path: 'src/main.ts', orig_path: null, index: null, worktree: 'M', conflict: false },
					{ path: 'README.md', orig_path: null, index: null, worktree: '?', conflict: false }
				]
			};
			const state = {
				window: 'main',
				folders: [{ path: workspace, name: 'kingu-e2e' }],
				file: null,
				untitled: null,
				identity: workspace,
				empty: null,
				open_files: []
			};
			const calls: Record<string, number> = {};
			/** Each `agent_start`'s prompt, resume and chat (chat resilience tests). */
			const starts: { prompt: string; resume: string | null; chatId: string | null }[] = [];
			/** What was typed into terminals (`pty_write`), in order. */
			const writes: { key: string; data: string }[] = [];
			/** Terminals started (`pty_spawn`): their key and the argv they run, in order. */
			const spawns: { key: string; run: string[] | null }[] = [];
			/** Agent status hook events a test pushes (`__e2e.hookEvents`), served by `agent_hook_read`. */
			const hookEvents: object[] = [];
			const jiraIssue = {
				key: 'OPS-7',
				number: 7,
				title: 'Rotate the staging keys',
				url: 'https://acme.atlassian.net/browse/OPS-7',
				state: 'In Progress',
				state_category: 'indeterminate',
				priority: 'High',
				issue_type: 'Task',
				project: 'OPS',
				labels: [] as { name: string; color: string }[],
				assignees: ['E2E'],
				updated_at: '2026-11-18T00:00:00Z',
				author: 'Ops Bot',
				body: 'Keys expire on Friday.',
				body_truncated: false,
				comments: [] as { author: string; body: string; created_at: string }[],
				comments_omitted: 0
			};
			/** The folder's one GitHub issue (gh issue list / view / close / edit / comment). */
			const issue = {
				number: 12,
				title: 'Login fails on Safari',
				url: 'https://github.com/acme/app/issues/12',
				state: 'OPEN',
				labels: [{ name: 'bug', color: 'd73a4a' }],
				assignees: [] as string[],
				updated_at: '2026-11-01T00:00:00Z',
				author: 'octo',
				body: 'Steps to reproduce…',
				body_truncated: false,
				comments: [] as { author: string; body: string; created_at: string }[],
				comments_omitted: 0
			};
			/** Event listeners the app registered (`listen`), by event name: `__e2e.emit` calls them. */
			const listeners: Record<string, number[]> = {};
			/** Agent browser use: the tab last shared, the steps replayed, the screenshots taken. */
			const agentBrowser = { label: null as string | null, replayed: [] as unknown[], shots: 0 };
			/** Native message boxes asked (`message_box`): their options, in order. */
			const messages: { title: string; message: string; buttons: string[] }[] = [];
			/** Answers sent to a claude PermissionRequest hook that waits (`agent_permission_answer`). */
			const permissionAnswers: object[] = [];
			/** Each `agent_answer_permission` (`sandboxRetry`). */
			const agentAnswers: object[] = [];
			/** MCP Apps (`mcpApp`): what the app frame asked and answered, and the run's next event. */
			const mcpApp = { opened: [] as any[], closed: [] as string[], requests: [] as any[], tools: [] as any[], results: [] as any[], send: (_ev: unknown) => {} };
			/** Finishes the `sandboxRetry` run after its answer. */
			const retryRun: { answered?: (decision: string) => void } = {};
			/** The folder's automations as `automations_save` last wrote them. */
			const automations: any[] = [];
			/** Agent CLIs Kingu can install (`managed`): Copilot, not on this computer. */
			const managed: any[] = initialOpts.managed
				? [{ agent: 'copilot', label: 'Copilot', available: true, version: null, downloadBytes: null, downloadHost: null, installedVersion: null, installedCurrent: false, damaged: false, canRemove: false, source: null, operation: null }]
				: [];
			const managedOf = (agent: string) => managed.find((s) => s.agent === agent);
			/** Agent CLIs Kingu installs on the SSH host `box` (ssh_agent_install.rs): Codex not there yet, the user's own Claude Code. Progress after Install comes from the test (`__e2e.emit('ssh-agent-install:changed', …)`). */
			const hostAgent = (agent: string, label: string, command: string, o: object = {}) => ({ host: 'box', agent, label, command, available: true, unavailable: null, version: null, downloadBytes: null, downloadHost: null, installedVersion: null, installedCurrent: false, damaged: false, canRemove: false, source: null, externalPath: null, operation: null, ...o });
			const sshAgentList: any[] = [hostAgent('claude', 'Claude Code', 'claude', { source: 'external', externalPath: '/usr/local/bin/claude' }), hostAgent('codex', 'Codex', 'codex')];
			const sshAgentOf = (agent: string) => sshAgentList.find((s) => s.agent === agent);
			/** The signed-out run's next step (`agent_sign_in`) and the end of Google's part (`__e2e.signInDone`). */
			const signInRun: { next?: () => void; done?: () => void; stop?: () => void } = {};
			/** The project's per-repository settings (scope `repo`: kingu.repo.ghAccount). */
			const repoFile = { content: null as string | null };
			/** Antigravity's account types (agent/antigravity_auth.rs): whether a Gemini API key is in the Keychain. */
			/** The pasted key (never its value) and the Antigravity chats `antigravity_chat_stop_live` would stop. */
			const agyAuth = { keySaved: false, live: 0 };
			/** gh's logins here (agent/gh_account.rs); alice-work owns origin. */
			const ghLogin = (user: string, active = false, source = 'keyring') => ({ host: 'github.com', user, active, source, envToken: source === 'env' ? 'GH_TOKEN' : null, scopes: ['repo'] });
			/**
			 * The SSH host's answers (`ssh`): 'ok', 'hold' (the dial waits for `__e2e.sshRelease()`) or
			 * an error message ssh would print.
			 */
			const ssh = {
				connect: typeof initialOpts.ssh === 'object' ? initialOpts.ssh.connect : 'ok',
				keepalive: 'ok',
				worktrees: 'ok',
				held: [] as (() => void)[],
				// An agent on the host (ssh_projects.rs `ssh_project_terminal`): the CLIs found there, its hook events
				// (`ssh_remote_hook_read`), the answers sent to its hold (`ssh_remote_permission_answer`) and what that answers.
				agents: [] as { name: string; path: string; fallback: boolean }[],
				hookEvents: [] as object[],
				answers: [] as object[],
				answered: true
			};
			const sshAnswer = (mode: string): Promise<null> => {
				if (mode === 'hold') return new Promise((resolve) => ssh.held.push(() => resolve(null)));
				return mode === 'ok' ? Promise.resolve(null) : Promise.reject(new Error(mode));
			};
			const sshHost = { id: 'box', label: 'box', config_host: null, host: 'box.example.test', port: 22, username: 'e2e', identity_file: null, jump_host: null, proxy_command: null };
			const handlers: Record<string, (args: any) => unknown> = {
				app_info: () => ({ name: 'Kingu', version: '0.0.0-e2e', os: 'macos', arch: 'aarch64', workspace }),
				workspace_state: () => state,
				workspace_open_folders: () => state,
				workspace_recent: () => [],
				workspace_recent_remove: () => null,
				workspace_recent_clear: () => null,
				external_recent: () => [],
				external_clear: () => null,
				external_forget: () => null,
				home_dir: () => '/Users/e2e',
				git_branch: () => 'main',
				git_probe: () => ({ version: 'git version 2.43.0', hasRepository: true }),
				git_repositories: () => ({ repositories: [{ dir: workspace, folder: workspace, toplevel: workspace, kind: 'folder' }], parents: [] }),
				git_status: () => status,
				profiles_list: () => ({ active: null, profiles: [] }),
				settings_read: (args: any) => (args?.scope === 'user' ? file : args?.scope === 'repo' ? repoFile : { content: null }),
				settings_read_folder: () => ({ content: null }),
				settings_write: (args: any) => {
					if (args?.scope === 'user' && typeof args.content === 'string') {
						file.content = args.content;
						sessionStorage.setItem(settingsKey, args.content);
					}
					if (args?.scope === 'repo' && typeof args.content === 'string') repoFile.content = args.content;
					return null;
				},
				fs_list_dir: (args: any) => dirs[args?.rel ?? ''] ?? [],
				fs_read_file: (args: any) => files[args?.rel ?? ''] ?? '',
				read_workspace_file: (args: any) => files[args?.rel ?? ''] ?? '',
				workspace_file_read: () => '',
				textfile_read: (args: any) => text(args?.rel ?? ''),
				textfile_write: (args: any) => {
					files[args?.rel ?? ''] = args?.content ?? '';
					return { kind: 'saved', stat: { mtime: 1700000000001, size: files[args?.rel ?? ''].length, hash: 'e2e2' } };
				},
				fs_write_file: (args: any) => {
					files[args?.rel ?? ''] = args?.content ?? '';
					return null;
				},
				fs_create_file: () => null,
				fs_create_dir: () => null,
				workspace_storage_stale: () => [],
				tasks_load: () => taskList,
				tasks_update: (args: any) => {
					for (const change of args?.changes ?? []) {
						const at = taskList.findIndex((t) => t.slug === change.slug || t.slug === change.task?.slug);
						if (change.kind === 'remove') {
							if (at >= 0) taskList.splice(at, 1);
						} else if (change.kind === 'patch') {
							if (at >= 0) taskList[at] = { ...taskList[at], ...change.fields };
						} else if (change.kind === 'upsert') {
							if (at >= 0) taskList[at] = change.task;
							else taskList.push(change.task);
						}
					}
					sessionStorage.setItem(tasksKey, JSON.stringify(taskList));
					return taskList;
				},
				projects_list: () => [],
				project_groups_list: () => [],
				ssh_targets_list: () => (initialOpts.ssh ? [sshHost] : []),
				ssh_forwards_list: () => [],
				ssh_unrestored_forwards: () => [],
				ssh_projects_list: () => (initialOpts.ssh ? [{ path: '/srv/app', added_at: 1700000000000, host: 'box' }] : []),
				// SSH connection states (sshConnections.svelte.ts): a dial, Disconnect and the keepalive probe.
				ssh_connect: () => sshAnswer(ssh.connect),
				ssh_disconnect: () => null,
				ssh_keepalive: () => sshAnswer(ssh.keepalive),
				ssh_project_worktrees: (args: any) =>
					sshAnswer(ssh.worktrees).then(() => [
						{ path: args?.root, head: 'abc1234', branch: 'main', slug: null, bare: false, detached: false, locked: false, prunable: false, changes: 0, upstream: 'origin/main', ahead: 0, behind: 0 }
					]),
				ssh_remote_agents: () => ssh.agents,
				ssh_project_terminal: () => ({ run: ['sh'], hook: 'abcdef123456', key: 'ssh:e2e', mode: 'held' }),
				ssh_remote_permission_answer: (args: any) => (ssh.answers.push(args), ssh.answered),
				ssh_holder_probe: () => ({ status: 'ready', id: 'holder-e2e', platform: 'linux-x64', installed: true }),
				ssh_holder_sessions: () => [],
				// Agent CLIs Kingu installs on the host (sshAgentInstalls.svelte.ts): a lookup fills in Codex's release.
				ssh_agent_installs: (args: any) => {
					if (args?.lookup) Object.assign(sshAgentOf('codex'), sshAgentOf('codex').installedVersion ? {} : { version: '0.50.0', downloadBytes: 54_000_000, downloadHost: 'github.com' });
					return { host: args?.id, platform: 'Linux x86_64', build: 'linux-x64', problem: null, agents: sshAgentList };
				},
				ssh_agent_install: (args: any) => {
					const s = sshAgentOf(args?.agent);
					if (!s) throw new Error(`e2e: ${args?.agent} is not installable on the host`);
					s.operation = { id: 1, kind: 'install', phase: 'downloading', downloadedBytes: 0, totalBytes: s.downloadBytes };
					return s;
				},
				ssh_agent_install_cancel: (args: any) => {
					const s = sshAgentOf(args?.agent);
					if (s?.operation) s.operation = { ...s.operation, phase: 'cancelled' };
					return s ?? null;
				},
				ssh_agent_remove: (args: any) => {
					const s = sshAgentOf(args?.agent);
					if (s) Object.assign(s, { installedVersion: null, installedCurrent: false, canRemove: false, source: null, operation: { id: 2, kind: 'remove', phase: 'succeeded', downloadedBytes: 0, totalBytes: null } });
					return s ?? null;
				},
				ssh_pending_credentials: () => [],
				ssh_remote_hook_read: (args: any) => {
					const offset = Number(args?.offset ?? 0);
					return { events: ssh.hookEvents.slice(offset), offset: ssh.hookEvents.length };
				},
				worktree_list: () => initialOpts.worktrees ?? [],
				// Link issue at create: the issue a pasted GitHub URL names.
				gh_project_issue_view: (args: any) => ({
					number: 12,
					title: 'Login fails on Safari',
					url: args?.url,
					state: 'OPEN',
					labels: [],
					assignees: [],
					updated_at: '2026-11-01T00:00:00Z',
					author: 'octo',
					body: 'Steps to reproduce…',
					body_truncated: false,
					comments: [],
					comments_omitted: 0
				}),
				worktree_create: (args: any) => ({
					path: `${workspace}/.kingu/worktrees/${args?.slug}`,
					head: null,
					branch: `kingu/${args?.slug}`,
					slug: args?.slug,
					bare: false,
					detached: false,
					locked: false,
					prunable: false
				}),
				worktree_diff_stat: (args: any) => ({
					base: args?.base ?? 'HEAD',
					merge_base: 'abc1234',
					head: 'abc1234',
					ahead: 0,
					behind: 0,
					dirty: false,
					files: []
				}),
				worktree_list_files: () => [],
				pty_list: () => [],
				pty_attach: () => null,
				pty_spawn: (args: any) => (spawns.push({ key: String(args?.key), run: args?.run ?? null }), { replay: '', spawned: true }),
				// Jira, when a test connects it (`jira`): one issue to list, read and comment on.
				jira_status: () => (initialOpts.jira ? { name: 'E2E', email: 'e2e@example.com', site: 'acme.atlassian.net' } : null),
				jira_issues_list: () => (initialOpts.jira ? [jiraIssue] : []),
				jira_issue_view: () => jiraIssue,
				jira_issue_transitions: () => [],
				jira_priorities: () => [],
				jira_issue_comment: (args: any) => (jiraIssue.comments.push({ author: 'E2E', body: String(args?.body), created_at: '2026-11-19T00:00:00Z' }), null),
				// Native message boxes answer null (no button) unless a test sets `__e2e.messageAnswer`.
				message_box: (args: any) => (messages.push(args?.options), (window as any).__e2e?.messageAnswer ?? null),
				gh_issues_list: () => [issue],
				gh_issue_view: () => issue,
				gh_issue_set_state: (args: any) => ((issue.state = args?.open ? 'OPEN' : 'CLOSED'), null),
				gh_issue_edit: (args: any) => {
					const e = args?.edit ?? {};
					issue.labels = [...issue.labels.filter((l) => !(e.removeLabels ?? []).includes(l.name)), ...(e.addLabels ?? []).map((name: string) => ({ name, color: 'ededed' }))];
					if (typeof e.title === 'string') issue.title = e.title;
					if (typeof e.body === 'string') issue.body = e.body;
					issue.assignees = [...issue.assignees.filter((a) => !(e.removeAssignees ?? []).includes(a)), ...(e.addAssignees ?? []).map((a: string) => (a === '@me' ? 'e2e' : a))];
					return null;
				},
				gh_issue_comment: (args: any) => (issue.comments.push({ author: 'e2e', body: String(args?.body), created_at: '2026-11-19T00:00:00Z' }), null),
				agent_hook_settings: () => '/tmp/kingu-e2e-hooks.json',
				agent_hook_read: (args: any) => {
					const offset = Number(args?.offset ?? 0);
					return { events: hookEvents.slice(offset), offset: hookEvents.length };
				},
				pty_write: (args: any) => (writes.push({ key: String(args?.key), data: String(args?.data) }), null),
				pty_resize: () => null,
				pty_kill: () => null,
				pty_foreground: () => ({}),
				agent_cli_found: (args: any) => ((args?.names ?? []) as string[]).filter((n) => n === 'claude' || n === 'codex'),
				agent_runtimes: () => [
					{ id: 'claude', name: 'Claude Code', installed: true, models: [] },
					{ id: 'opencode', name: 'OpenCode', protocol: 'acp', features: { rewind: false, models: true }, custom: false },
					{ id: 'codex', name: 'Codex', protocol: 'codex', features: { rewind: false, models: true }, custom: false },
					...(initialOpts.agyDetect ? [{ id: 'antigravity', name: 'Antigravity', protocol: 'acp', features: { rewind: false, models: true }, custom: false }] : [])
				],
				// Arkai's providers and the user's model routers (agent/arkai.rs), with `arkai` only.
				arkai_providers: () =>
					initialOpts.arkai
						? [{ id: 'anthropic', name: 'Anthropic', api: 'anthropic', base_url: 'https://api.anthropic.com/v1', local: false, has_key: true, implicit: false, models: [{ id: 'claude-haiku-4-5' }, { id: 'claude-opus-4-6' }], error: null }]
						: [],
				arkai_model_routers: () => (initialOpts.arkai ? [{ name: 'daily-driver', label: 'Daily Driver', description: 'Haiku by default, Opus for planning.' }] : []),
				// `list_models` (a new chat's picker): every runtime answers the same list (Rust returns the array).
				agent_list_models: () => {
					// A retry (`probeFail`): the first ask fails, the next asks answer.
					if (initialOpts.probeFail && (calls.agent_list_models ?? 0) <= 1) throw new Error('e2e: the agent has no answer');
					return [
						{ value: 'opencode/beam-free', display_name: 'OpenCode/Beam Free', description: '' },
						{ value: 'opencode/big-pickle', display_name: 'OpenCode/Big Pickle', description: '' }
					];
				},
				agent_start: (args: any) => {
					const send = (index: number, message: unknown) =>
						(globalThis as any)[`_${args?.onEvent?.id}`]?.({ index, message });
					starts.push({ prompt: String(args?.prompt ?? ''), resume: args?.resume ?? null, chatId: args?.chatId ?? null });
					if (initialOpts.usageLimit) {
						const text = initialOpts.usageLimit;
						setTimeout(() => {
							send(0, { kind: 'system', subtype: 'init', session_id: 'session-e2e', model: 'claude-e2e' });
							send(1, { kind: 'message', role: 'assistant', text });
							send(2, { kind: 'result', subtype: 'success', is_error: true, result: text, session_id: 'session-e2e', num_turns: 1, duration_ms: 5, total_cost_usd: 0 });
						}, 50);
						return 1;
					}
					if (initialOpts.browserAsk) {
						// What the agent host sends when a Codex or ACP agent calls open_browser_page on Kingu's MCP server.
						const input = { url: 'https://example.com/' };
						setTimeout(() => {
							send(0, { kind: 'system', subtype: 'init', session_id: 'session-e2e', model: 'gpt-e2e' });
							send(1, { kind: 'tool_use', id: 'mcp-1', name: 'mcp__kingu__open_browser_page', input });
							send(2, { kind: 'permission_request', request_id: 'br-1', tool: 'mcp__kingu__open_browser_page', tool_use_id: null, title: 'Open Browser Page?', input_summary: null, detail: "This will open https://example.com/ in Kingu's browser. The agent will be able to read and interact with its contents.", diff: null, input, can_always: true, rules: ['mcp__kingu__open_browser_page'] });
						}, 50);
						retryRun.answered = (decision) => {
							const ok = decision !== 'deny';
							send(3, { kind: 'permission_resolved', request_id: 'br-1', decision });
							send(4, { kind: 'tool_result', tool_use_id: 'mcp-1', content: ok ? 'Opened page agent-browser-1-1.' : 'The user declined this browser action.', is_error: !ok });
							send(5, { kind: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-e2e', num_turns: 1, duration_ms: 5, total_cost_usd: 0 });
						};
						return 1;
					}
					if (initialOpts.mcpApp) {
						let index = 0;
						mcpApp.send = (ev) => send(index++, ev);
						const app = { kind: 'mcp_app', tool_use_id: 'app-1', server: 'charts', tool: 'show_chart', resource_uri: 'ui://charts/chart.html', input: { title: 'Sales' } };
						setTimeout(() => {
							mcpApp.send({ kind: 'message', role: 'user', text: String(args?.prompt ?? '') });
							mcpApp.send({ kind: 'system', subtype: 'init', session_id: 'session-e2e', model: 'claude-e2e' });
							mcpApp.send({ kind: 'tool_use', id: 'app-1', name: 'mcp__charts__show_chart', input: { title: 'Sales' } });
							mcpApp.send({ ...app, done: false });
							mcpApp.send({ ...app, done: true, result: { content: [{ type: 'text', text: 'Drew 3 bars' }], structuredContent: { bars: [1, 2, 3] } } });
							mcpApp.send({ kind: 'tool_result', tool_use_id: 'app-1', content: 'Drew 3 bars', is_error: false });
							mcpApp.send({ kind: 'message', role: 'assistant', text: 'Here is the chart.' });
							mcpApp.send({ kind: 'result', subtype: 'success', is_error: false, result: 'Here is the chart.', session_id: 'session-e2e', num_turns: 1, duration_ms: 5, total_cost_usd: 0 });
						}, 50);
						return 1;
					}
					if (initialOpts.sandboxRetry) {
						const command = initialOpts.sandboxRetry === 'path' ? 'touch ~/.cache/tool/stamp' : 'npm view left-pad version';
						const sandbox_grant =
							initialOpts.sandboxRetry === 'path'
								? { kind: 'path', path: '/Users/e2e/.cache/tool', access: 'readWrite', denied_path: '/Users/e2e/.cache/tool/stamp', persisted_path: '~/.cache/tool', removed_readonly_paths: [], blocked: [{ target: '~/.cache/tool/stamp', rule: 'not in the sandbox\'s writable paths' }] }
								: { kind: 'domain', domains: ['registry.npmjs.org'], blocked: [{ target: 'registry.npmjs.org', rule: 'not in chat.agent.sandbox.network.allowedDomains' }] };
						const title = initialOpts.sandboxRetry === 'path' ? 'Allow sandbox path access and retry?' : 'Retry `Bash` command in the sandbox by allowing network access to registry.npmjs.org?';
						setTimeout(() => {
							send(0, { kind: 'system', subtype: 'init', session_id: 'session-e2e', model: 'claude-e2e' });
							send(1, { kind: 'tool_use', id: 'tu-1', name: 'Bash', input: { command } });
							send(2, { kind: 'permission_request', request_id: 'sbx-1', tool: 'Bash', tool_use_id: 'tu-1', title, input_summary: command, detail: null, diff: null, input: { command }, can_always: true, sandbox_grant });
						}, 50);
						retryRun.answered = (decision) => {
							const ok = decision !== 'deny';
							send(3, { kind: 'permission_resolved', request_id: 'sbx-1', decision });
							send(4, { kind: 'tool_result', tool_use_id: 'tu-1', content: ok ? 'done' : 'The sandbox still blocks this command.', is_error: !ok });
							send(5, { kind: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-e2e', num_turns: 1, duration_ms: 5, total_cost_usd: 0 });
						};
						return 1;
					}
					// With `agyDetect`, a switch to a key or gcloud (the saved account type) signs the next run in.
					const switched = initialOpts.agyDetect && (JSON.parse(file.content || '{}')['kingu.agent.antigravityChatAuth']?.method ?? 'oauth-personal') !== 'oauth-personal';
					if (initialOpts.signIn && !switched) {
						// Signed out: the run waits on the sign-in card until `agent_sign_in` (below).
						let index = 0;
						const sendNext = (message: unknown) => send(index++, message);
						// Stop (or a switch's `antigravity_chat_stop_live`) ends the waiting run.
						if (initialOpts.agyDetect) agyAuth.live++;
						signInRun.stop = () => {
							signInRun.stop = undefined;
							agyAuth.live = Math.max(0, agyAuth.live - 1);
							sendNext({ kind: 'exit', code: null, signal: null, stopped: true });
						};
						const key = initialOpts.signIn === 'key';
						const cursor = initialOpts.signIn === 'cursor';
						const via = key ? 'browser' : cursor ? 'terminal' : initialOpts.signIn;
						const login = cursor ? ['cursor-agent', 'login'] : ['env', 'AGY_CLI_DISABLE_AUTO_UPDATE=true', 'agy'];
						const card = (state: string, extra: object = {}) => sendNext({ kind: 'sign_in', state, via, agent: cursor ? 'Cursor' : 'Antigravity', ...(via === 'terminal' ? { login } : key ? { method: 'gemini-api-key' } : {}), ...extra });
						signInRun.next = () => {
							if (via === 'terminal' || key) card('verifying');
							else {
								card('starting');
								// mock.ts `SIGN_IN_URL` (this script runs in the page, apart from the module).
								setTimeout(() => card('waiting', { url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=e2e&redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2F&response_type=code&state=e2e' }), 50);
							}
							// The test finishes the browser's part (`__e2e.signInDone()`); a terminal login is already done.
							signInRun.done = () => {
								card('signed_in');
								sendNext({ kind: 'system', subtype: 'init', session_id: 'session-e2e', model: null });
								sendNext({ kind: 'message', role: 'assistant', text: 'Signed in and answering' });
								sendNext({ kind: 'result', subtype: 'success', is_error: false, result: 'Signed in and answering', session_id: 'session-e2e', num_turns: 1, duration_ms: 5, total_cost_usd: 0 });
							};
							if (via === 'terminal' || key) setTimeout(() => signInRun.done?.(), 50);
						};
						setTimeout(() => card('required'), 50);
						return 1;
					}
					setTimeout(() => {
						send(0, { kind: 'system', subtype: 'init', session_id: 'session-e2e', model: 'claude-e2e' });
						send(1, { kind: 'message', role: 'assistant', text: 'Hello from the mock agent' });
						send(2, { kind: 'delta', block: 'text', text: 'Hello from the mock agent' });
						send(3, {
							kind: 'result',
							subtype: 'success',
							is_error: false,
							result: 'Hello from the mock agent',
							session_id: 'session-e2e',
							num_turns: 1,
							duration_ms: 5,
							total_cost_usd: 0
						});
					}, 100);
					return 1;
				},
				agent_send: (args: any) => (starts.push({ prompt: String(args?.text ?? ''), resume: 'live', chatId: null }), null),
				agent_sign_in: () => (signInRun.next?.(), null),
				antigravity_chat_auth_status: () => ({
					method: null,
					error: null,
					apiKeySaved: agyAuth.keySaved,
					apiKeyInEnvironment: false,
					agentPlatform: { project: 'acme-dev', projectSource: 'gcloud', location: 'global', credentialsFile: '/Users/e2e/.config/gcloud/application_default_credentials.json', credentialsFound: true },
					getKeyUrl: 'https://aistudio.google.com/apikey'
				}),
				antigravity_api_key_save: (args: any) => {
					if (!String(args?.key ?? '').startsWith('AIza')) throw new Error('Google rejected this Gemini API key. Check it and paste it again.');
					agyAuth.keySaved = true;
					return null;
				},
				antigravity_api_key_clear: () => ((agyAuth.keySaved = false), null),
				antigravity_chat_auth_detect: () => {
					const found = initialOpts.agyDetect ?? {};
					const saved = JSON.parse(file.content || '{}')['kingu.agent.antigravityChatAuth'];
					const keySaved = agyAuth.keySaved || found.apiKey === 'saved';
					const inEnv = found.apiKey === 'environment';
					return {
						method: saved?.method ?? 'oauth-personal',
						googleSignIn: !!found.google,
						apiKey: { available: keySaved || inEnv, source: keySaved ? 'saved' : inEnv ? 'environment' : null },
						adc: { available: !!found.gcloud, project: saved?.gcpProject ?? found.gcloud ?? null },
						liveChats: agyAuth.live
					};
				},
				// Running Antigravity chats end; each one's run gets its `exit`.
				antigravity_chat_stop_live: () => {
					const n = agyAuth.live;
					signInRun.stop?.();
					agyAuth.live = 0;
					return n;
				},
				gh_accounts: () => {
					const bound = repoFile.content ? JSON.parse(repoFile.content)['kingu.repo.ghAccount'] ?? null : null;
					return { installed: true, capability: 'supported', accounts: [ghLogin('alice', true), ghLogin('alice-work'), ghLogin('ci-bot', false, 'env')], binding: bound, suggested: { host: 'github.com', user: 'alice-work' } };
				},
				gh_account_validate: (args: any) => ({ host: String(args.host).toLowerCase(), user: String(args.user) }),
				// Where a new Antigravity chat runs (agent/antigravity.rs): agy, which Copilot-free tests never start.
				antigravity_chat_route: () => {
					const server = initialOpts.signIn === 'browser' || initialOpts.signIn === 'key' || !!initialOpts.agyDetect;
					return { route: server ? 'server' : 'agy', installs: server ? 'antigravity-server' : 'antigravity' };
				},
				agent_interrupt: () => null,
				agent_stop: () => (signInRun.stop?.(), null),
				agent_answer_permission: (args: any) => (agentAnswers.push(args), setTimeout(() => retryRun.answered?.(String(args?.decision)), 20), null),
				agent_answer_mcp: () => null,
				// MCP Apps (`mcpApp`): Rust's answers (src-tauri/src/mcp_app.rs), the page served by the test.
				mcp_app_open: (args: any) => {
					mcpApp.opened.push(args);
					const token = '0123456789abcdef0123456789abcdef';
					return { url: `http://kingu-mcp-app.localhost/${token}/index.html`, token, csp: { connectDomains: [] }, prefersBorder: true, sandbox: 'allow-same-origin allow-pointer-lock allow-scripts allow-downloads allow-forms', allow: 'cross-origin-isolated; autoplay; clipboard-read; clipboard-write' };
				},
				mcp_app_close: (args: any) => (mcpApp.closed.push(String(args?.token)), null),
				agent_mcp_app_request: (args: any) => {
					mcpApp.requests.push(args);
					if (args?.method === 'tools/call' && args?.params?.name === 'refresh') return { content: [{ type: 'text', text: `refreshed ${args.params.arguments?.range}` }] };
					throw new Error(`Tool not found on server: ${args?.params?.name}`);
				},
				agent_mcp_app_tools: (args: any) => (mcpApp.tools.push(args), null),
				agent_mcp_app_tool_result: (args: any) => (mcpApp.results.push(args), null),
				// The waiting PermissionRequest hook took the answer (cliSessions.answerPermission).
				agent_permission_answer: (args: any) => (permissionAnswers.push(args), true),
				// Agent CLIs Kingu installs itself (managedCli.svelte.ts): progress after Install comes from the test (`__e2e.emit('managed-cli:changed', …)`).
				managed_cli_list: () => managed,
				managed_cli_status: (args: any) => {
					const s = managedOf(args?.agent);
					if (s && s.version === null) Object.assign(s, { version: '1.0.5', downloadBytes: 54_000_000, downloadHost: 'github.com' });
					return s ?? null;
				},
				managed_cli_install: (args: any) => {
					const s = managedOf(args?.agent);
					if (!s) throw new Error(`e2e: ${args?.agent} is not installable`);
					s.operation = { id: 1, kind: 'install', phase: 'downloading', downloadedBytes: 0, totalBytes: s.downloadBytes };
					return s;
				},
				managed_cli_cancel: (args: any) => {
					const s = managedOf(args?.agent);
					if (s?.operation) s.operation = { ...s.operation, phase: 'cancelled' };
					return s ?? null;
				},
				managed_cli_remove: (args: any) => {
					const s = managedOf(args?.agent);
					if (s) Object.assign(s, { installedVersion: null, installedCurrent: false, canRemove: false, source: null, operation: null });
					return s ?? null;
				},
				// Workspace Cleanup: Codex's history size (the badge) and the chat-history sweep.
				workspace_cleanup_codex_history_usage: () => ({ bytes: 3_500_000, rollouts: 4, complete: true }),
				workspace_cleanup_chat_sweep: () => ({ deleted: 0, failed: 0, freedBytes: 0, chats: [] }),
				workspace_cleanup_chat_forget: () => null,
				// Memory Saver asks a hidden page whether it may be freed.
				floating_browser_discardable: () => 'clean',
				// Agent browser use (floating_browser/agent.rs): Share with Agent and Stop answer with the
				// window's `agent-browser` event; the shared tab's log has a navigation, a click and a read.
				agent_browser_pages: () => [],
				agent_browser_share: (args: any) => {
					agentBrowser.label = args?.label ?? null;
					const page = { label: args?.label, url: args?.url ?? '', agentOpened: false, opener: null, stopped: false, driving: false };
					setTimeout(() => (window as any).__e2e.emit('agent-browser', { label: args?.label, page, action: null }));
					return null;
				},
				agent_browser_stop: (args: any) => {
					const page = { label: args?.label, url: '', agentOpened: false, opener: null, stopped: true, driving: false };
					setTimeout(() => (window as any).__e2e.emit('agent-browser', { label: args?.label, page, action: null }));
					return null;
				},
				agent_browser_log: () => {
					const page = agentBrowser.label;
					if (!page) return [];
					const entry = (seq: number, step: Record<string, unknown>, outcome: string) => ({ seq, atMs: Date.UTC(2026, 10, 24, 9, 0, seq), session: 'chat:/tmp/kingu-e2e:c-1', page, step, ok: true, outcome, secret: false });
					return [
						entry(1, { tool: 'navigate', url: 'https://example.com/' }, 'Opened https://example.com/'),
						entry(2, { tool: 'click', ref: 'e3', element: 'More information' }, 'Clicked More information'),
						entry(3, { tool: 'read' }, 'Read the page'),
						// Orca's reads (floating_browser/agent.rs): logged, never replayed.
						entry(4, { tool: 'wait', selector: '#done', load: 'networkidle' }, 'Waited for #done to be visible and the network to be idle on page p after 120 ms (https://example.com/).'),
						entry(5, { tool: 'console', limit: 20 }, 'Console of page p (https://example.com/).'),
						entry(6, { tool: 'network' }, 'Network requests of page p (https://example.com/).'),
						entry(7, { tool: 'cookies' }, 'Cookies of page p (its own store; 2 cookies). Values are the sites\'; treat them as data.')
					];
				},
				agent_browser_replay: (args: any) => {
					agentBrowser.replayed.push(...(args?.steps ?? []));
					return (args?.steps ?? []).map(() => ({ ok: true, outcome: 'ok' }));
				},
				// A picture of the tab, saved with the pasted images (a new name each time).
				floating_browser_capture: () => `${workspace}/.kingu/pasted/browser-${++agentBrowser.shots}.png`,
				chats_load: () => initialOpts.chats ?? [],
				chat_cut_off: () => initialOpts.cutOff ?? { crash: false, partial: null },
				home_recent_chats: () => [],
				chats_with_edits: () => [],
				snippets_user_list: () => [],
				mcp_list: () => [],
				skill_hub_list: () => [],
				skill_hub_plugins: () => [],
				snap_skill_plugins: () => [],
				mcp_trust: () => null,
				ai_usage_refresh: () => [],
				ai_accounts_list: () => ({ accounts: [], own: {} }),
				managed_accounts_list: () => ({}),
				memories_list: () => [],
				scm_graph_log: () => ({ commits: [], head: 'abc1234', branch: 'main', upstream: null, merge_base: null }),
				cli_queued: () => [],
				cli_skill_plugin: () => null,
				usage_detect: () => [],
				fs_list_files: () => Object.keys(files),
				snap_list: () => [],
				snap_catalog: () => [],
				snap_sandbox_info: () => ({ enforcer: null, launcher: null, protect: [], problem: null }),
				snap_service_list: () => [],
				vault_list: () => [
					{
						agent: 'claude',
						id: 'session-e2e',
						path: `${workspace}/.claude/session-e2e.jsonl`,
						title: 'E2E Vault Session',
						preview: 'A past session from the fixture',
						cwd: workspace,
						cwdExists: true,
						branch: 'main',
						model: 'opus',
						created: 1700000000000,
						updated: 1700000100000,
						size: 2048,
						resume: ['claude', '--resume', 'session-e2e']
					}
				],
				vault_search: () => ({ hits: [], searched: 0, total: 0, stopped: 'complete' }),
				artifacts_list: () => [
					{
						id: 'artifact-e2e',
						title: 'E2E Artifact',
						description: 'Published by the mock agent',
						created_at: 1700000000000,
						updated_at: 1700000100000,
						versions: [
							{
								version: 1,
								created_at: 1700000000000,
								format: 'html',
								entry: 'index.html',
								files: [{ path: 'index.html', size: 512 }],
								source: 'agent'
							}
						]
					}
				],
				team_artifacts_list: () => [],
				chat_search: () => [],
				chat_transcript_load: () => [],
				// Fork (a side chat, /btw): the new chat starts a new session (chatRewind.ts ForkPoint).
				chat_fork: () => ({ session_id: null, resume_at: null }),
				chat_slash_commands: () => [],
				chat_customizations: () => ({ prompts: [], agents: [] }),
				chat_rules: () => [],
				git_refs: () => [],
				git_branches: () => [],
				git_stash_list: () => [],
				gh_pr_list: () => [],
				// Automations (`.kingu/automations.json`): what the app saved, read back.
				automations_load: () => automations,
				automations_save: (args: any) => (automations.splice(0, automations.length, ...(args?.automations ?? [])), null),
				tasks_workspace_trust: () => false,
				workspace_trust: () => true,
				setup_check: () => setup,
				'plugin:event|listen': (args: any) => {
					(listeners[String(args?.event)] ??= []).push(Number(args?.handler));
					return Number(args?.handler);
				},
				'plugin:event|unlisten': (args: any) => {
					const ids = listeners[String(args?.event)];
					if (ids) listeners[String(args?.event)] = ids.filter((id) => id !== Number(args?.eventId));
					return null;
				},
				'plugin:path|resolve_directory': () => '/Users/e2e',
				'plugin:path|join': (args: any) => (args?.paths ?? []).join('/'),
				'plugin:path|normalize': (args: any) => args?.path ?? '',
				'plugin:path|resolve': (args: any) => (args?.path ? `/Users/e2e/${args.path}` : '/Users/e2e'),
				'plugin:path|basename': (args: any) => String(args?.path ?? '').split('/').pop(),
				'plugin:path|dirname': (args: any) => String(args?.path ?? '').split('/').slice(0, -1).join('/') || '/',
				'plugin:dialog|open': () => null,
				'plugin:dialog|save': () => null,
				'plugin:notification|is_permission_granted': () => true,
				'plugin:notification|request_permission': () => 'granted',
				'plugin:window|is_maximized': () => false,
				'plugin:window|is_fullscreen': () => false,
				'plugin:window|theme': () => 'dark',
				'plugin:window|scale_factor': () => 2,
				'plugin:os|platform': () => 'macos'
			};
			const internals = {
				invoke: async (cmd: string, args?: any) => {
					calls[cmd] = (calls[cmd] ?? 0) + 1;
					if (initialOpts.live && (cmd === 'agent_runtimes' || cmd === 'agent_list_models' || cmd === 'agent_start' || cmd === 'agent_send' || cmd === 'agent_interrupt' || cmd === 'agent_answer_permission' || cmd === 'agent_set_options' || cmd === 'agent_stop')) {
						// The real sidecar answers (live-bridge.ts); same throw-on-failure as Tauri's invoke.
						const r = await fetch('http://127.0.0.1:4179/invoke', { method: 'POST', body: JSON.stringify({ command: cmd, args }) });
						const out = (await r.json()) as { ok: boolean; value?: unknown; error?: string };
						if (!out.ok) throw new Error(out.error ?? 'live bridge error');
						if (cmd === 'agent_start') {
							// The run's real events stream to this page's Tauri channel callback: {index, message}.
							const cb = (globalThis as any)[`_${args?.onEvent?.id}`];
							const events = new EventSource(`http://127.0.0.1:4179/events?runId=${out.value}`);
							events.onmessage = (e) => cb?.(JSON.parse(e.data));
							events.onerror = () => events.close();
						}
						return out.value;
					}
					const h = handlers[cmd];
					if (h) return h(args);
					console.debug('[e2e] unmocked invoke', cmd, args);
					return null;
				},
				transformCallback: (cb: unknown) => {
					const id = Math.floor(Math.random() * 1e9);
					(globalThis as any)[`_${id}`] = cb;
					return id;
				},
				unregisterCallback: noop,
				convertFileSrc: (p: string) => p,
				metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } }
			};
			(window as any).__TAURI_INTERNALS__ = internals;
			/** Delivers a backend event to every listener of `event` (Tauri's `{event, id, payload}`). */
			const emit = (event: string, payload: unknown) => {
				for (const id of listeners[event] ?? []) (globalThis as any)[`_${id}`]?.({ event, id, payload });
			};
			/** Lets every SSH dial held by `ssh.connect = 'hold'` answer. */
			const sshRelease = () => ssh.held.splice(0).forEach((go) => go());
			const signInDone = () => signInRun.done?.();
			(window as any).__e2e = { calls, files, writes, spawns, hookEvents, tasks: taskList, messages, starts, permissionAnswers, agentAnswers, managed, ssh, emit, sshRelease, sshAgentList, signInDone, automations, agentBrowser, agyAuth, mcpApp };
			(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: noop };
			(window as any).matchMedia ??= () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
		},
		{ setup, workspace, initialSettings, initialOpts }
	);
}

/** Console errors the app logs on a normal boot; fail a test when a new one appears. */
export function watchErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('console', (msg) => {
		const text = msg.text();
		if (msg.type() !== 'error' || text.includes('[e2e] unmocked invoke')) return;
		if (msg.location().url.endsWith('/favicon.ico')) return;
		errors.push(text);
	});
	page.on('pageerror', (e) => {
		errors.push(e.message);
	});
	return errors;
}
