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

/** Fake Tauri IPC: enough for boot and Settings; unknown commands resolve to null and are logged. */
export async function mockTauri(
	page: Page,
	setup: SetupReport = READY,
	workspace = '/tmp/kingu-e2e',
	initialSettings: Record<string, unknown> = {},
	initialOpts: { probeFail?: boolean; live?: boolean } = {}
) {
	await page.addInitScript(
		({ setup, workspace, initialSettings, initialOpts }) => {
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
			const taskList: any[] = [];
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
				settings_read: (args: any) => (args?.scope === 'user' ? file : { content: null }),
				settings_read_folder: () => ({ content: null }),
				settings_write: (args: any) => {
					if (args?.scope === 'user' && typeof args.content === 'string') {
						file.content = args.content;
						sessionStorage.setItem(settingsKey, args.content);
					}
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
					return taskList;
				},
				projects_list: () => [],
				worktree_list: () => [],
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
				pty_spawn: () => ({ replay: '', spawned: true }),
				pty_write: () => null,
				pty_resize: () => null,
				pty_kill: () => null,
				pty_foreground: () => ({}),
				agent_cli_found: () => [],
				agent_runtimes: () => [
					{ id: 'claude', name: 'Claude Code', installed: true, models: [] },
					{ id: 'opencode', name: 'OpenCode', protocol: 'acp', features: { rewind: false, models: true }, custom: false },
					{ id: 'codex', name: 'Codex', protocol: 'codex', features: { rewind: false, models: true }, custom: false }
				],
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
				agent_send: () => null,
				agent_interrupt: () => null,
				agent_stop: () => null,
				agent_answer_permission: () => null,
				agent_answer_mcp: () => null,
				chats_load: () => [],
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
				chat_slash_commands: () => [],
				chat_customizations: () => ({ prompts: [], agents: [] }),
				chat_rules: () => [],
				git_refs: () => [],
				git_branches: () => [],
				git_stash_list: () => [],
				gh_pr_list: () => [],
				automations_load: () => [],
				tasks_workspace_trust: () => false,
				workspace_trust: () => true,
				setup_check: () => setup,
				'plugin:event|listen': noop,
				'plugin:event|unlisten': noop,
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
					if (initialOpts.live && (cmd === 'agent_list_models' || cmd === 'agent_start' || cmd === 'agent_send' || cmd === 'agent_interrupt' || cmd === 'agent_answer_permission')) {
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
			(window as any).__e2e = { calls, files };
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
