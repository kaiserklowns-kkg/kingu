// MCP store: the servers of the user's and the folder's config files (`mcp_list`, Rust
// agent/mcp.rs), the on/off list (`kingu.mcp.disabled` in the user settings, which Rust also
// reads when a run starts) and the live status the folder's chat and task sessions report
// (`session_info`, then `mcp_status`). It composes what runs get (ade/mcp.ts `setMcpComposer`),
// asks before trusting a server that came with the folder, and owns the commands
// "MCP: List Servers", "MCP: Add Server…" and "MCP: Open User Configuration".

import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { setMcpComposer, snapMcpServers } from '#lib/ade/mcp.ts';
import { agents } from '#lib/agent/agents.svelte.ts';
import { chats } from '#lib/agent/chats.svelte.ts';
import type { AgentEvent } from '#lib/agent/events.ts';
import { t, type MessageKey } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { ask } from '#lib/workbench/messageBox.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import {
	composeServers,
	liveFromSessionInfo,
	mcpRows,
	mergeLive,
	newServer,
	rowState,
	suggestName,
	validServerName,
	withEnabled,
	type McpEntry,
	type McpLive,
	type McpRow,
	type McpState
} from './mcpModel.ts';

export const DISABLED_SETTING = 'kingu.mcp.disabled';
/** The editor key of the user's mcp.json (read and saved through `mcp_user_*`; settings/resources.ts). */
export const USER_MCP_KEY = 'mcp://user/mcp.json';
/** Files whose change re-lists the servers (paths relative to the folder, as the watcher reports them). */
const WATCHED = ['.mcp.json', '.vscode/mcp.json', '.cursor/mcp.json'];

export const STATE_LABEL = {
	running: 'mcp.state.running',
	starting: 'mcp.state.starting',
	failed: 'mcp.state.failed',
	needsAuth: 'mcp.state.needsAuth',
	off: 'mcp.state.off',
	untrusted: 'mcp.state.untrusted',
	invalid: 'mcp.state.invalid',
	idle: 'mcp.state.idle'
} as const satisfies Record<McpState, MessageKey>;

export const SOURCE_LABEL = {
	snap: 'mcp.source.snap',
	user: 'mcp.source.user',
	project: 'mcp.source.project',
	vscode: 'mcp.source.vscode',
	cursor: 'mcp.source.cursor',
	claude: 'mcp.source.claude'
} as const satisfies Record<McpRow['source'], MessageKey>;

class Mcp {
	entries = $state<McpEntry[]>([]);
	/** Latest status per server name from this folder's sessions. */
	live = $state<Record<string, McpLive>>({});
	loading = $state(false);
	error = $state<string | null>(null);

	/** Turned-off servers (`<source>:<name>`): the user settings only, which Rust reads too. */
	get disabled(): string[] {
		const v = settings.inspect(DISABLED_SETTING, 'user');
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
	}

	/** What the view lists, for the open folder. */
	get rows(): McpRow[] {
		return mcpRows(snapMcpServers(workspace.root), this.entries, new Set(this.disabled), this.live);
	}

	async load() {
		this.loading = true;
		try {
			this.entries = await invoke<McpEntry[]>('mcp_list');
			this.error = null;
		} catch (e) {
			this.error = String(e);
		} finally {
			this.loading = false;
		}
	}

	/** A session event of this folder: keeps the live status. */
	observe(ev: AgentEvent) {
		if (ev.kind === 'mcp_status') this.live = mergeLive(this.live, ev.servers);
		else if (ev.kind === 'session_info' && ev.mcp_servers.length) this.live = liveFromSessionInfo(this.live, ev.mcp_servers, ev.tools);
	}

	async setEnabled(row: McpRow, on: boolean) {
		const next = withEnabled(this.disabled, row.id, on);
		try {
			await settings.set(DISABLED_SETTING, next.length ? next : undefined, 'user');
			status.flash(t(on ? 'mcp.turnedOn' : 'mcp.turnedOff', { name: row.name }));
		} catch (e) {
			notifications.error(t('mcp.saveFailed', { error: String(e) }));
		}
	}

	/** Trusts exactly the definition the user is shown (Rust refuses it when the file changed since). */
	async trust(row: McpRow) {
		if (row.source === 'snap' || row.source === 'user' || row.source === 'claude' || !row.hash) return;
		const where = row.rel ?? row.file ?? '';
		const sure = await ask(t('mcp.trust.ask', { name: row.name, file: where, detail: row.detail }), {
			title: t('mcp.trust.title', { name: row.name }),
			kind: 'warning',
			okLabel: t('mcp.trust.ok'),
			cancelLabel: t('common.cancel')
		});
		if (!sure) return;
		try {
			await invoke('mcp_trust', { source: row.source, name: row.name, hash: row.hash });
			status.flash(t('mcp.trust.done', { name: row.name }));
		} catch (e) {
			notifications.error(t('mcp.trust.failed', { error: String(e) }));
		}
		await this.load();
	}

	async untrust(row: McpRow) {
		if (row.source === 'snap' || row.source === 'user' || row.source === 'claude') return;
		try {
			await invoke('mcp_trust', { source: row.source, name: row.name, hash: null });
		} catch (e) {
			notifications.error(t('mcp.trust.failed', { error: String(e) }));
		}
		await this.load();
	}

	/** VS Code's "MCP: Add Server…": the kind, the command or URL, then a name; written to the user's mcp.json. */
	async addServer() {
		const kind = await quick.choose({
			placeholder: t('mcp.add.pickType'),
			items: [
				{ id: 'stdio', label: t('mcp.add.stdio'), description: t('mcp.add.stdioHint') },
				{ id: 'http', label: t('mcp.add.http'), description: t('mcp.add.httpHint') },
				{ id: 'sse', label: t('mcp.add.sse'), description: t('mcp.add.sseHint') }
			]
		});
		if (!kind) return;
		const type = kind.id as 'stdio' | 'http' | 'sse';
		const check = (value: string) => {
			const r = newServer(type, value);
			return 'error' in r ? t(r.error) : t('mcp.add.continue');
		};
		const input = await quick.input({ placeholder: type === 'stdio' ? t('mcp.add.commandPlaceholder') : t('mcp.add.urlPlaceholder'), hint: check });
		if (input === undefined) return;
		const made = newServer(type, input);
		if ('error' in made) {
			notifications.warn(t(made.error));
			return;
		}
		const taken = new Set(this.rows.map((r) => r.name));
		const suggested = suggestName(input, taken);
		const typed = await quick.input({
			placeholder: t('mcp.add.namePlaceholder', { name: suggested }),
			hint: (v) => {
				const name = v.trim() || suggested;
				if (!validServerName(name)) return t('mcp.add.badName');
				return taken.has(name) ? t('mcp.add.nameTaken', { name }) : t('mcp.add.saveAs', { name });
			}
		});
		if (typed === undefined) return;
		const name = typed.trim() || suggested;
		if (!validServerName(name)) {
			notifications.warn(t('mcp.add.badName'));
			return;
		}
		try {
			await invoke('mcp_add_server', { name, server: made.server });
			status.flash(t('mcp.add.added', { name }));
		} catch (e) {
			notifications.error(t('mcp.add.failed', { error: String(e) }));
		}
		await this.load();
	}

	async remove(row: McpRow) {
		if (row.source !== 'user') return;
		const sure = await ask(t('mcp.remove.ask', { name: row.name }), { title: t('mcp.remove.title'), kind: 'warning', okLabel: t('common.remove'), cancelLabel: t('common.cancel') });
		if (!sure) return;
		try {
			await invoke('mcp_remove_server', { name: row.name });
		} catch (e) {
			notifications.error(t('mcp.saveFailed', { error: String(e) }));
		}
		await this.load();
	}

	/** Kingu's own mcp.json in the editor (created from a template on first save). */
	openConfig() {
		systemSettings.close();
		editors.open(USER_MCP_KEY, { preview: false });
	}

	/** The file a row comes from, when the editor can open it. */
	canOpen = (row: McpRow) => row.source === 'user' || !!row.rel;

	openFile(row: McpRow) {
		if (row.source === 'user') return this.openConfig();
		if (!row.rel) return;
		systemSettings.close();
		editors.open(row.rel, { preview: false });
	}

	/** "MCP: List Servers": pick a server, then what to do with it (VS Code's server actions). */
	async listServers() {
		await this.load();
		const rows = this.rows;
		if (!rows.length) {
			const add = await quick.choose({ placeholder: t('mcp.list.none'), items: [{ id: 'add', label: t('mcp.addServer') }] });
			if (add) await this.addServer();
			return;
		}
		const picked = await quick.choose({
			placeholder: t('mcp.list.placeholder'),
			items: rows.map((r) => ({ id: r.id, label: r.name, description: `${t(STATE_LABEL[rowState(r)])} · ${t(SOURCE_LABEL[r.source])}${r.live?.tools.length ? ` · ${t('mcp.tools', { count: r.live.tools.length })}` : ''}` }))
		});
		const row = rows.find((r) => r.id === picked?.id);
		if (!row) return;
		const items = [
			...(row.needsTrust ? [{ id: 'trust', label: t('mcp.action.trust') }] : []),
			{ id: 'toggle', label: row.enabled ? t('mcp.action.turnOff') : t('mcp.action.turnOn') },
			...(this.canOpen(row) ? [{ id: 'open', label: t('mcp.action.openConfig') }] : []),
			...(row.live?.tools.length ? [{ id: 'tools', label: t('mcp.action.tools') }] : []),
			{ id: 'view', label: t('mcp.action.view') }
		];
		const action = await quick.choose({ placeholder: row.name, items });
		if (action?.id === 'trust') await this.trust(row);
		else if (action?.id === 'toggle') await this.setEnabled(row, !row.enabled);
		else if (action?.id === 'open') this.openFile(row);
		else if (action?.id === 'view') systemSettings.showPage('mcp');
		else if (action?.id === 'tools') await quick.choose({ placeholder: t('mcp.toolsOf', { name: row.name }), items: row.live!.tools.map((tool) => ({ id: tool, label: tool })) });
	}
}

export const mcp = new Mcp();

const RELOAD_DEBOUNCE_MS = 300;

/** Workbench wiring: what runs get, live status from sessions, reloads and the commands. */
export function installMcp(): () => void {
	setMcpComposer((snapServers) => composeServers(snapServers, mcp.entries, new Set(mcp.disabled)));
	const observe = (_id: string, ev: AgentEvent) => mcp.observe(ev);
	const stopChats = chats.onEvent(observe);
	const stopAgents = agents.onEvent(observe);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const reloadSoon = () => {
		clearTimeout(timer);
		timer = setTimeout(() => void mcp.load(), RELOAD_DEBOUNCE_MS);
	};
	const stopWatching = workspace.onFilesChanged((paths) => {
		if (paths.some((p) => p === '' || WATCHED.includes(p) || p === '.vscode' || p === '.cursor')) reloadSoon();
	});
	// The user's mcp.json and folders above the open one are not watched: re-listed on focus.
	window.addEventListener('focus', reloadSoon);
	const stopEffects = $effect.root(() => {
		$effect(() => {
			void workspace.root;
			untrack(() => {
				mcp.live = {};
				void mcp.load();
			});
		});
	});
	const unregister = [
		commands.register({ id: 'workbench.mcp.listServer', title: 'List Servers', category: 'MCP', run: () => mcp.listServers() }),
		commands.register({ id: 'workbench.mcp.addConfiguration', title: 'Add Server…', category: 'MCP', run: () => mcp.addServer() }),
		commands.register({ id: 'workbench.mcp.openUserMcpJson', title: 'Open User Configuration', category: 'MCP', run: () => mcp.openConfig() }),
		commands.register({ id: 'workbench.mcp.showServers', title: 'Show MCP Servers', category: 'MCP', run: () => systemSettings.showPage('mcp') })
	];
	return () => {
		clearTimeout(timer);
		stopChats();
		stopAgents();
		stopWatching();
		window.removeEventListener('focus', reloadSoon);
		stopEffects();
		unregister.forEach((u) => u());
		setMcpComposer((s) => s);
	};
}
