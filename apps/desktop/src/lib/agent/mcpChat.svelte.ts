// MCP client features of the chat (VS Code's MCP elicitation, sampling, resources and prompts in
// chat), the app side; the pure part is mcpChat.ts, the agent host's mcpAsks.ts / mcpQuery.ts do
// the protocol.
//
//   mcpChat.answer(chatId, req, …)   answers a server's form / sampling card (McpRequestCard);
//                                    url mode opens the page, Always / Never are saved in
//                                    chat.mcp.serverSampling
//   mcpChat.load(env)                every server's resources, templates and prompts (the servers
//                                    runs get, `mcpServers`), at most once a minute per folder
//   mcpChat.promptItems(cwd)         the `/mcp.<server>.<prompt>` commands
//   mcpChat.runPrompt(cmd, args, env) asks for missing arguments, renders the prompt
//   pickMcpResource(env)             Add Context's MCP Resources: a server, a resource or a
//                                    template (its variables asked), read and attached
//   mcpChat.status(chatId)           the chat's MCP servers as its run last reported them
//
// Queries go through `agent_mcp_query`: over the chat's live Arkai run when it has the server,
// else the agent host opens the server for the query and closes it after.

import { invoke } from '@tauri-apps/api/core';
import { mcpServers, prepareMcp, type McpServerConfig, type McpServers } from '#lib/ade/mcp.ts';
import { t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { openUrl } from '#lib/terminal/pty.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick, type PickItem } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import type { ContextText } from './chatPrompt.ts';
import { chats } from './chats.svelte.ts';
import type { McpAction, McpRequestEvent } from './events';
import {
	expandTemplate,
	missingArgs,
	parsePromptArgs,
	promptCommand,
	promptText,
	resourceContext,
	SAMPLING_SETTING,
	samplingWith,
	sizeLabel,
	templateVars,
	type McpCatalog,
	type McpContent,
	type McpPromptInfo,
	type McpPromptResult
} from './mcpChat.ts';
import type { SlashItem } from './slashCommands.ts';

/** Where the chat runs and which chat it is (chatContextSources' `ContextEnv`). */
type Env = { cwd: string | null; chatId: string | null };
type Pick = { kind: 'text'; text: ContextText };
type ServerLive = { name: string; status: string; error: string | null; source: string | null; tools: string[] };

/** A folder's lists are asked again after this. */
const CACHE_MS = 60_000;

/** A server's prompt as a `/` command. */
export type McpPromptCommand = { command: string; server: string; prompt: McpPromptInfo };

class McpChat {
	/** Per folder: when its lists were asked, and each server's lists (or why not). */
	catalogs = $state<Record<string, { at: number; servers: Record<string, McpCatalog | { error: string }> }>>({});
	/** Each chat's MCP servers as its run last reported them (`mcp_status`). */
	live = $state<Record<string, ServerLive[]>>({});
	#loading = new Map<string, Promise<void>>();

	constructor() {
		chats.onEvent((id, ev) => {
			if (ev.kind === 'mcp_status') this.live[id] = ev.servers;
			else if (ev.kind === 'exit') delete this.live[id];
		});
	}

	/** The chat's live run, if any (its connections are reused). */
	#runId(chatId: string | null): number | null {
		const run = chatId ? chats.run(chatId) : undefined;
		return run && !run.ended && run.runId !== undefined ? run.runId : null;
	}

	async #servers(cwd: string): Promise<McpServers> {
		await prepareMcp();
		return mcpServers(cwd);
	}

	#query<T>(env: Env & { cwd: string }, name: string, server: McpServerConfig, op: 'list' | 'read' | 'prompt', extra: { uri?: string; prompt?: string; arguments?: Record<string, string> } = {}): Promise<T> {
		return invoke<T>('agent_mcp_query', { runId: this.#runId(env.chatId), cwd: env.cwd, name, server, op, uri: extra.uri ?? null, prompt: extra.prompt ?? null, arguments: extra.arguments ?? null });
	}

	/** Every server's lists for `env.cwd` (asked in parallel; a failing server keeps its error). */
	load(env: Env, force = false): Promise<void> {
		const cwd = env.cwd;
		if (!cwd) return Promise.resolve();
		const known = this.catalogs[cwd];
		if (!force && known && Date.now() - known.at < CACHE_MS) return Promise.resolve();
		const running = this.#loading.get(cwd);
		if (running) return running;
		const p = (async () => {
			const servers = await this.#servers(cwd);
			const entries = await Promise.all(
				Object.entries(servers).map(async ([name, s]) => {
					try {
						return [name, await this.#query<McpCatalog>({ ...env, cwd }, name, s, 'list')] as const;
					} catch (e) {
						return [name, { error: String(e) }] as const;
					}
				})
			);
			this.catalogs[cwd] = { at: Date.now(), servers: Object.fromEntries(entries) };
		})().finally(() => this.#loading.delete(cwd));
		this.#loading.set(cwd, p);
		return p;
	}

	#lists(cwd: string | null): [string, McpCatalog][] {
		const known = cwd ? this.catalogs[cwd] : undefined;
		return known ? Object.entries(known.servers).filter((e): e is [string, McpCatalog] => !('error' in e[1])) : [];
	}

	/** The `/mcp.<server>.<prompt>` commands known for `cwd`. */
	prompts(cwd: string | null): McpPromptCommand[] {
		return this.#lists(cwd).flatMap(([server, c]) => c.prompts.map((prompt) => ({ command: promptCommand(server, prompt.name), server, prompt })));
	}

	/** The prompts as `/` menu items. */
	promptItems(cwd: string | null): SlashItem[] {
		return this.prompts(cwd).map((p) => ({
			name: p.command,
			description: p.prompt.description || p.prompt.title || t('chatMcp.prompt.description', { server: p.server }),
			argumentHint: p.prompt.arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' '),
			source: 'mcp' as const
		}));
	}

	/**
	 * `/mcp.<server>.<prompt> args`: the arguments typed (`name=value` or in order), the missing
	 * ones asked one by one (required ones must be given), then the prompt rendered by the server.
	 * Undefined when the user backed out or it failed (said in the status bar).
	 */
	async runPrompt(cmd: McpPromptCommand, typed: string, env: Env): Promise<{ text: string; context: ContextText[] } | undefined> {
		if (!env.cwd) return undefined;
		const args = parsePromptArgs(typed, cmd.prompt.arguments);
		for (const a of missingArgs(cmd.prompt.arguments, args)) {
			const value = await quick.input({
				placeholder: a.description ? `${t('chatMcp.prompt.arg', { name: a.name, command: cmd.command })} · ${a.description}` : t('chatMcp.prompt.arg', { name: a.name, command: cmd.command }),
				hint: (v) => (v ? t('chatMcp.prompt.argHint', { value: v }) : a.required ? t('chatMcp.prompt.argRequired') : t('chatMcp.prompt.argOptional'))
			});
			if (value === undefined) return undefined;
			if (!value && a.required) return undefined;
			if (value) args[a.name] = value;
		}
		const servers = await this.#servers(env.cwd);
		const server = servers[cmd.server];
		if (!server) return void status.flash(t('chatMcp.prompt.unknown', { command: cmd.command }), 6000);
		let r: McpPromptResult;
		try {
			r = await this.#query<McpPromptResult>({ ...env, cwd: env.cwd }, cmd.server, server, 'prompt', { prompt: cmd.prompt.name, arguments: args });
		} catch (e) {
			notifications.error(t('chatMcp.prompt.failed', { error: String(e) }));
			return undefined;
		}
		if (r.images) status.flash(t('chatMcp.prompt.images', { count: r.images }), 6000);
		return promptText(r, (uri) => `${uri} (${cmd.server})`);
	}

	/** Answers a card; url mode's accept opens the page, a kept sampling answer is saved first. */
	async answer(chatId: string, req: McpRequestEvent, action: McpAction, content?: Record<string, string | number | boolean>, remember?: 'session' | 'always' | 'never') {
		if (req.type === 'sampling' && (remember === 'always' || remember === 'never')) {
			try {
				await settings.set(SAMPLING_SETTING, samplingWith(settings.inspect(SAMPLING_SETTING, 'user'), req.server, remember === 'always'), 'user');
			} catch (e) {
				notifications.error(t('chatMcp.sampling.saveFailed', { error: String(e) }));
			}
		}
		await chats.answerMcp(chatId, req.request_id, action, content, remember);
		if (req.mode === 'url' && action === 'accept' && req.url) void openUrl(req.url);
	}

	/** The chat's servers that need the user: starting, signed out, failed. */
	status(chatId: string | null): ServerLive[] {
		return (chatId ? this.live[chatId] : undefined)?.filter((s) => s.status === 'pending' || s.status === 'needs-auth' || s.status === 'failed') ?? [];
	}

	/** A resource's content as context to attach (binary content is said, not attached). */
	contents(server: string, name: string, list: McpContent[]): Pick[] {
		const out: Pick[] = [];
		for (const c of list) {
			const ctx = resourceContext(c, `${name} (${server})`);
			if (ctx) out.push({ kind: 'text', text: ctx });
			else status.flash(t('chatMcp.binary', { uri: c.uri, type: c.mimeType ?? '?', size: sizeLabel(c.bytes) }), 8000);
		}
		return out;
	}

	/** Add Context's MCP Resources: a server (when several have any), then one of its resources or templates. */
	async pickResource(env: Env): Promise<Pick[]> {
		const cwd = env.cwd;
		if (!cwd) return [];
		const none = () => (status.flash(t('chatContext.none.mcpResources'), 5000), [] as Pick[]);
		if (!Object.keys(await this.#servers(cwd)).length) return none();
		status.flash(t('chatMcp.loading'), 3000);
		await this.load(env);
		for (const [name, c] of Object.entries(this.catalogs[cwd]?.servers ?? {})) if ('error' in c) status.flash(t('chatMcp.listFailed', { server: name, error: c.error }), 8000);
		const offering = this.#lists(cwd).filter(([, c]) => c.resources.length || c.templates.length);
		if (!offering.length) return none();
		let chosen = offering[0]!;
		if (offering.length > 1) {
			const item = await quick.choose({ placeholder: t('chatMcp.pickServer'), items: offering.map(([name, c]) => ({ id: name, label: name, description: t('chatMcp.counts', { resources: c.resources.length, templates: c.templates.length }) })) });
			const hit = offering.find(([name]) => name === item?.id);
			if (!hit) return [];
			chosen = hit;
		}
		const [server, catalog] = chosen;
		const items: PickItem[] = [
			...catalog.resources.map((r, i) => ({ id: `r:${i}`, label: r.name, description: [r.uri, r.description].filter(Boolean).join(' · '), ...(i === 0 ? { separator: t('chatMcp.resource') } : {}) })),
			...catalog.templates.map((r, i) => ({ id: `t:${i}`, label: r.name, description: [r.uriTemplate, r.description].filter(Boolean).join(' · '), ...(i === 0 ? { separator: t('chatMcp.template') } : {}) }))
		];
		const item = await quick.choose({ placeholder: t('chatMcp.pickResource', { server }), items });
		if (!item) return [];
		let uri: string;
		let name: string;
		if (item.id.startsWith('r:')) {
			const r = catalog.resources[Number(item.id.slice(2))]!;
			uri = r.uri;
			name = r.name;
		} else {
			const tpl = catalog.templates[Number(item.id.slice(2))]!;
			const values: Record<string, string> = {};
			for (const v of templateVars(tpl.uriTemplate)) {
				const value = await quick.input({ placeholder: t('chatMcp.templateVar', { name: v, template: tpl.uriTemplate }), hint: (x) => t('chatMcp.templateHint', { uri: expandTemplate(tpl.uriTemplate, { ...values, [v]: x }) }) });
				if (value === undefined) return [];
				values[v] = value;
			}
			uri = expandTemplate(tpl.uriTemplate, values);
			name = uri;
		}
		const config = (await this.#servers(cwd))[server];
		if (!config) return [];
		try {
			return this.contents(server, name, await this.#query<McpContent[]>({ ...env, cwd }, server, config, 'read', { uri }));
		} catch (e) {
			status.flash(t('chatMcp.readFailed', { uri, error: String(e) }), 8000);
			return [];
		}
	}
}

export const mcpChat = new McpChat();

/** Add Context's MCP Resources source (chatContextSources.svelte.ts). */
export const pickMcpResource = (env: Env) => mcpChat.pickResource(env);
