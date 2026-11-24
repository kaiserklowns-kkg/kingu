<script lang="ts">
	// An MCP App under its tool call (VS Code's ChatMcpAppSubPart / ChatMcpAppModel): the server's
	// `ui://` page in a sandboxed cross-origin frame served by Rust (src-tauri/src/mcp_app.rs: VS
	// Code's sandbox, `allow` and CSP, one origin per chat and server, no Tauri IPC), talking to
	// the chat only through the ext-apps postMessage bridge (mcpApp.ts). Messages from anything but
	// this frame are ignored. The app's tools are published while it is mounted (mcpApps.svelte.ts).
	import { invoke } from '@tauri-apps/api/core';
	import { onDestroy, untrack } from 'svelte';
	import { t, locale } from '#lib/i18n/index.ts';
	import { theme } from '#lib/theme/theme.svelte.ts';
	import { isDarkType } from '#lib/theme/themes.ts';
	import { openUrl } from '#lib/terminal/pty.ts';
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { chats } from './chats.svelte.ts';
	import type { McpAppEvent } from './events';
	import { clampHeight, hostContext, INITIAL_HEIGHT, MAX_HEIGHT_PCT, McpAppHost, MIN_HEIGHT, styleVariables } from './mcpApp.ts';
	import { mcpApps } from './mcpApps.svelte.ts';

	let { app, chatId, onmessage }: { app: McpAppEvent; chatId: string; onmessage?: (text: string) => boolean } = $props();

	type Opened = { url: string; token: string; csp: unknown; prefersBorder: boolean; sandbox: string; allow: string };

	let frame = $state<HTMLIFrameElement | null>(null);
	let box = $state<HTMLDivElement | null>(null);
	let opened = $state<Opened | null>(null);
	let error = $state<string | null>(null);
	let height = $state(INITIAL_HEIGHT);
	let width = $state(0);
	let winHeight = $state(typeof window === 'undefined' ? 800 : window.innerHeight);
	let attempt = $state(0);
	let host: McpAppHost | null = null;
	let unregister: (() => void) | null = null;
	// Theme changes (and the app reading `--vscode-*` values the frame cannot see) go through the context.
	const kind = $derived(isDarkType(theme.current.type) ? 'dark' : 'light');

	const runId = () => {
		const run = chats.run(chatId);
		return run && !run.ended && run.runId !== undefined ? run.runId : null;
	};

	const context = () => {
		const css = getComputedStyle(document.documentElement);
		return hostContext({
			theme: kind,
			variables: styleVariables((v) => css.getPropertyValue(v)),
			locale: locale() === 'th' ? 'th-TH' : 'en-US',
			width,
			maxHeight: winHeight * MAX_HEIGHT_PCT,
			toolCallId: app.tool_use_id,
			toolName: app.tool
		});
	};

	async function close() {
		unregister?.();
		unregister = null;
		host?.dispose();
		host = null;
		const token = opened?.token;
		opened = null;
		if (token) await invoke('mcp_app_close', { token }).catch(() => {});
	}

	// Opens (again) for this tool call; the run that rendered it must be live (VS Code: the server must be up).
	// A new event object for the same call (its result) must not load the app again.
	const callId = $derived(app.tool_use_id);
	$effect(() => {
		void attempt;
		void callId;
		let stale = false;
		untrack(() => open(() => stale));
		return () => (stale = true);
	});

	function open(isStale: () => boolean) {
		const id = runId();
		error = null;
		void close().then(() => {
			const stale = isStale();
			if (stale) return;
			if (id === null) return void (error = t('chatMcp.app.unavailable', { server: app.server }));
			invoke<Opened>('mcp_app_open', { runId: id, chatId, server: app.server, uri: app.resource_uri }).then(
				(o) => {
					if (isStale()) return void invoke('mcp_app_close', { token: o.token }).catch(() => {});
					const appId = `${app.tool_use_id}:${o.token.slice(0, 8)}`;
					host = new McpAppHost(
						{
							// Plain JSON only: the chat's state is reactive proxies, which postMessage cannot clone.
							post: (msg) => frame?.contentWindow?.postMessage(JSON.parse(JSON.stringify(msg)), '*'),
							serverRequest: (method, params) => {
								const run = runId();
								if (run === null) return Promise.reject(new Error(t('chatMcp.app.unavailable', { server: app.server })));
								return invoke('agent_mcp_app_request', { runId: run, server: app.server, method, params });
							},
							openLink: (url) => openUrl(url).then(() => true, () => false),
							message: (text) => onmessage?.(text) ?? false,
							setHeight: (h) => (height = clampHeight(h, winHeight)),
							wheel: (_dx, dy) => {
								const list = box?.closest<HTMLElement>('[data-chat-scroll]');
								if (list) list.scrollTop += dy;
							},
							toolsChanged: (tools) => void mcpApps.publish(chatId, appId, tools),
							hostInfo: mcpApps.hostInfo()
						},
						{ input: app.input ?? {}, csp: o.csp, context }
					);
					if (app.done) host.setResult(app.result);
					unregister = mcpApps.register(chatId, appId, host);
					opened = o;
				},
				(e) => !isStale() && (error = String(e))
			);
		});
	}

	// The result arrives with the second `mcp_app` event.
	$effect(() => {
		if (app.done) host?.setResult(app.result);
	});

	$effect(() => {
		void kind;
		void width;
		void winHeight;
		host?.contextChanged();
	});

	$effect(() => {
		if (!box) return;
		const ro = new ResizeObserver(() => (width = box?.clientWidth ?? width));
		ro.observe(box);
		return () => ro.disconnect();
	});

	function onMessage(e: MessageEvent) {
		// Only this app's frame, never another window, frame or chat.
		if (!frame || !host || e.source !== frame.contentWindow) return;
		void host.handle(e.data);
	}

	onDestroy(() => void close());
</script>

<svelte:window onmessage={onMessage} onresize={() => (winHeight = window.innerHeight)} />

<div bind:this={box} class="kg-mcp-app flex min-w-0 flex-col" data-testid="mcp-app">
	{#if error}
		<div class="flex items-start gap-1.5 rounded border border-(--vscode-widget-border) px-2 py-1.5 text-xs" role="alert">
			<span class="mt-px shrink-0 text-(--vscode-errorForeground)"><Codicon id="error" size={12} /></span>
			<span class="min-w-0 flex-1 break-words">{t('chatMcp.app.failed', { error })}</span>
			<button type="button" class="shrink-0 text-(--vscode-textLink-foreground) hover:underline" onclick={() => attempt++}>{t('chatMcp.app.retry')}</button>
		</div>
	{:else if !opened}
		<p class="py-1 text-xs text-(--vscode-descriptionForeground)">{t('chatMcp.app.loading')}</p>
	{:else}
		<iframe
			bind:this={frame}
			title={t('chatMcp.app.title', { server: app.server })}
			src={opened.url}
			sandbox={opened.sandbox}
			allow={opened.allow}
			referrerpolicy="no-referrer"
			class={['block w-full bg-transparent', opened.prefersBorder ? 'rounded border border-(--vscode-widget-border)' : 'border-0']}
			style:height="{height}px"
			style:min-height="{MIN_HEIGHT}px"
			style:max-height="{MAX_HEIGHT_PCT * 100}vh"
		></iframe>
	{/if}
</div>
