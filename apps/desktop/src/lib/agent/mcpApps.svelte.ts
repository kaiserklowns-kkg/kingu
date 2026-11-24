// The chat's live MCP Apps (VS Code's agentHostMcpAppToolsService.ts): each app frame
// (McpAppFrame.svelte) registers its host here, the tools it registers (`App.registerTool()`) go
// to the chat's run for the model's next request (`agent_mcp_app_tools`), and the model's call of
// one (`mcp_app_tool_call`) is sent to that app and answered (`agent_mcp_app_tool_result`). An app
// that goes (its row unmounts, it reloads) takes its tools back.
//
//   mcpApps.enabled()                     `chat.mcp.apps.enabled` (VS Code's id, default on)
//   mcpApps.register(chatId, appId, host) the frame's host; returns the unregister
//   mcpApps.publish(chatId, appId, tools) the app's tools now
//   mcpApps.hostInfo()                    Kingu's name and version for `ui/initialize`

import { invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { chats } from './chats.svelte.ts';
import type { AppTool, McpAppHost } from './mcpApp.ts';

export const APPS_SETTING = 'chat.mcp.apps.enabled';

const key = (chatId: string, appId: string) => `${chatId}\u0000${appId}`;

class McpApps {
	#hosts = new Map<string, McpAppHost>();
	#calls = new Map<string, AbortController>();
	#info: { name: string; version: string } = { name: 'Kingu', version: '' };

	constructor() {
		void invoke<{ name?: string; version?: string }>('app_info')
			.then((i) => (this.#info = { name: i?.name || 'Kingu', version: i?.version ?? '' }))
			.catch(() => {});
		chats.onEvent((chatId, ev) => {
			if (ev.kind === 'mcp_app_tool_call') void this.#call(chatId, ev.request_id, ev.app_id, ev.name, ev.arguments ?? {});
			else if (ev.kind === 'mcp_app_tool_cancel') this.#calls.get(ev.request_id)?.abort();
		});
	}

	/** VS Code's `chat.mcp.apps.enabled`: whether MCP servers may show their UI for tool calls. */
	enabled(): boolean {
		return settings.get<boolean>(APPS_SETTING) !== false;
	}

	hostInfo() {
		return this.#info;
	}

	#runId(chatId: string): number | null {
		const run = chats.run(chatId);
		return run && !run.ended && run.runId !== undefined ? run.runId : null;
	}

	register(chatId: string, appId: string, host: McpAppHost): () => void {
		this.#hosts.set(key(chatId, appId), host);
		return () => {
			if (this.#hosts.get(key(chatId, appId)) !== host) return;
			this.#hosts.delete(key(chatId, appId));
			void this.publish(chatId, appId, []);
		};
	}

	/** The app's tools to the run (VS Code publishes them as session tools for the next request). */
	async publish(chatId: string, appId: string, tools: AppTool[]) {
		const runId = this.#runId(chatId);
		if (runId === null) return;
		await invoke('agent_mcp_app_tools', { runId, appId, tools }).catch((e) => clientLog('info', `chat ${chatId}: MCP app tools not published: ${e}`));
	}

	async #call(chatId: string, requestId: string, appId: string, name: string, args: Record<string, unknown>) {
		const runId = this.#runId(chatId);
		if (runId === null) return;
		const host = this.#hosts.get(key(chatId, appId));
		const ctrl = new AbortController();
		this.#calls.set(requestId, ctrl);
		let result: Record<string, unknown> | null = null;
		let error: string | null = null;
		try {
			// VS Code's messages when the app is gone or fails.
			if (!host || !host.tools.some((t) => t.name === name)) throw new Error(`MCP app tool "${name}" is no longer available.`);
			result = await host.callTool(name, args, ctrl.signal);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			this.#calls.delete(requestId);
		}
		if (ctrl.signal.aborted) return;
		await invoke('agent_mcp_app_tool_result', { runId, requestId, result, error }).catch((e) => clientLog('info', `chat ${chatId}: MCP app tool result not sent: ${e}`));
	}
}

export const mcpApps = new McpApps();
