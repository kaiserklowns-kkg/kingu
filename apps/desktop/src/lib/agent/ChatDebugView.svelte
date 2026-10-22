<script lang="ts">
	// The Agent Debug Log of a chat (VS Code's chat debug editor), in an editor tab
	// `chat-debug://<id>`: every run of the chat as rows from its transcript (Rust
	// `chat_debug_events`): what each run was given, messages, tool calls with their durations and
	// results, permission waits, safety checks, hook runs, turns with token usage and cost. Kind
	// chips and a filter (comma-separated terms, `!term` leaves rows out) narrow it; a row opens
	// its event. Export writes the log (the kinds shown) as JSON. It reloads while the chat runs.
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { save as saveDialog } from '@tauri-apps/plugin-dialog';
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { compactTokens, formatUsd } from '#lib/vault/vault.ts';
	import { chats } from './chats.svelte.ts';
	import { DEBUG_KINDS, filterDebugEvents, formatDuration, kindCounts, rowTime, type DebugKind, type DebugLog } from './chatDebug.ts';

	let { chatId }: { chatId: string } = $props();

	/** Rows drawn at first; Show more adds this many. */
	const PAGE = 500;
	let log = $state<DebugLog | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(false);
	let query = $state('');
	let errorsOnly = $state(false);
	/** Kinds turned off (all on at first; thinking is noisy, but VS Code shows it too). */
	let hidden = $state<ReadonlySet<DebugKind>>(new Set());
	let limit = $state(PAGE);
	let openRow = $state<number | null>(null);

	const kinds = $derived(new Set(DEBUG_KINDS.filter((k) => !hidden.has(k))));
	const rows = $derived(log ? filterDebugEvents(log.events, { kinds, query, errorsOnly }) : []);
	const counts = $derived(log ? kindCounts(log.events) : {});
	const first = $derived(log?.events[0]?.t ?? 0);
	const KIND_KEY = Object.fromEntries(DEBUG_KINDS.map((k) => [k, `chatDebug.kind.${k}`])) as Record<DebugKind, `chatDebug.kind.${DebugKind}`>;

	async function load() {
		loading = true;
		try {
			log = await invoke<DebugLog>('chat_debug_events', { chatId });
			error = null;
		} catch (e) {
			error = t('chatDebug.loadFailed', { error: String(e) });
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
		// Live: the chat's new events (debounced), as they reach its transcript.
		let timer: ReturnType<typeof setTimeout> | null = null;
		const off = chats.onEvent((id) => {
			if (id !== chatId) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => void load(), 600);
		});
		return () => {
			off();
			if (timer) clearTimeout(timer);
		};
	});

	function toggleKind(k: DebugKind) {
		const next = new Set(hidden);
		if (next.has(k)) next.delete(k);
		else next.add(k);
		hidden = next;
		limit = PAGE;
	}

	/** Only `k` shown (a second click on the only one shows all again). */
	function soloKind(k: DebugKind) {
		const only = hidden.size === DEBUG_KINDS.length - 1 && !hidden.has(k);
		hidden = only ? new Set() : new Set(DEBUG_KINDS.filter((x) => x !== k));
		limit = PAGE;
	}

	async function exportJson() {
		if (!log) return;
		const name = log.title.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat';
		const path = await saveDialog({ title: t('chatDebug.export'), defaultPath: `${name}-agent-debug-log.json`, filters: [{ name: t('chatDebug.title'), extensions: ['json'] }] }).catch(() => null);
		if (!path) return;
		try {
			await invoke('chat_debug_export', { chatId, path, kinds: hidden.size ? [...kinds] : null });
			status.flash(t('chatDebug.exported', { path }), 6000);
		} catch (e) {
			status.flash(t('chatDebug.exportFailed', { error: String(e) }), 10000);
		}
	}

	function pretty(v: unknown): string {
		try {
			return JSON.stringify(v, null, 2);
		} catch {
			return String(v);
		}
	}

	const KIND_COLOR: Partial<Record<DebugKind, string>> = {
		run: 'text-(--vscode-charts-purple,#b180d7)',
		user: 'text-(--vscode-charts-blue,#3794ff)',
		tool: 'text-(--vscode-charts-green,#89d185)',
		hook: 'text-(--vscode-charts-orange,#d18616)',
		turn: 'text-(--vscode-charts-yellow,#cca700)',
		guard: 'text-(--vscode-editorWarning-foreground)',
		permission: 'text-(--vscode-editorWarning-foreground)'
	};
</script>

<div class="flex h-full min-w-0 flex-col overflow-hidden bg-(--vscode-editor-background) text-[13px] text-(--vscode-foreground)">
	<header class="shrink-0 border-b border-(--vscode-panel-border) px-4 pt-3 pb-2">
		<div class="flex items-center gap-2">
			<Codicon id="debug" size={16} />
			<h1 class="min-w-0 flex-1 truncate text-sm font-semibold">{log ? t('chatDebug.tab', { title: log.title }) : t('chatDebug.title')}</h1>
			<button class="grid size-[24px] place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={t('chatDebug.refresh')} title={t('chatDebug.refresh')} onclick={() => void load()}>
				<Codicon id="refresh" size={14} />
			</button>
			<button class="flex h-[24px] items-center gap-1 rounded px-2 hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40" disabled={!log} onclick={() => void exportJson()}>
				<Codicon id="cloud-download" size={14} />{t('chatDebug.export')}
			</button>
		</div>
		{#if log}
			{@const s = log.totals}
			<div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-(--vscode-descriptionForeground)">
				<span>{log.runtime}{log.model ? ` · ${log.model}` : ''}</span>
				<span>{t('chatDebug.totals.requests', { count: s.requests })}</span>
				<span>{t('chatDebug.totals.turns', { count: s.turns })}</span>
				<span>{t('chatDebug.totals.tools', { count: s.tool_calls })}{s.tool_errors ? ` (${t('chatDebug.totals.failed', { count: s.tool_errors })})` : ''}</span>
				{#if s.hooks}<span>{t('chatDebug.totals.hooks', { count: s.hooks })}</span>{/if}
				{#if s.errors}<span class="text-(--vscode-errorForeground)">{t('chatDebug.totals.errors', { count: s.errors })}</span>{/if}
				<span>{t('chatDebug.totals.tokens', { input: compactTokens(s.input_tokens), output: compactTokens(s.output_tokens), cached: compactTokens(s.cache_read_tokens) })}</span>
				{#if s.cost_usd}<span>{t('chatDebug.totals.cost', { cost: formatUsd(s.cost_usd) })}</span>{/if}
				{#if s.duration_ms}<span>{t('chatDebug.totals.time', { time: formatDuration(s.duration_ms) })}</span>{/if}
			</div>
		{/if}
		<div class="mt-2 flex items-center gap-2">
			<input
				class="h-[24px] min-w-0 flex-1 rounded-sm border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) px-2 text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
				placeholder={t('chatDebug.filter.placeholder')}
				aria-label={t('chatDebug.filter.placeholder')}
				bind:value={query}
				oninput={() => (limit = PAGE)}
			/>
			<label class="flex shrink-0 items-center gap-1 text-xs"><input type="checkbox" bind:checked={errorsOnly} />{t('chatDebug.filter.errors')}</label>
		</div>
		<div class="mt-1.5 flex flex-wrap gap-1" role="group" aria-label={t('chatDebug.filter.kinds')}>
			{#each DEBUG_KINDS.filter((k) => counts[k]) as k (k)}
				<button
					class={['h-[20px] rounded-full border px-2 text-[11px]', hidden.has(k) ? 'border-(--vscode-widget-border) opacity-50' : 'border-(--vscode-focusBorder) bg-(--vscode-toolbar-hoverBackground)']}
					aria-pressed={!hidden.has(k)}
					title={t('chatDebug.filter.kindHint')}
					onclick={(e) => (e.altKey ? soloKind(k) : toggleKind(k))}
					ondblclick={() => soloKind(k)}>{t(KIND_KEY[k])} {counts[k]}</button
				>
			{/each}
		</div>
	</header>

	<div class="min-h-0 flex-1 overflow-auto">
		{#if error}
			<p class="p-4 text-(--vscode-errorForeground)">{error}</p>
		{:else if !log}
			<p class="p-4 text-(--vscode-descriptionForeground)">{loading ? t('chatDebug.loading') : ''}</p>
		{:else if !log.events.length}
			<p class="p-4 text-(--vscode-descriptionForeground)">{t('chatDebug.empty')}</p>
		{:else if !rows.length}
			<p class="p-4 text-(--vscode-descriptionForeground)">{t('chatDebug.noMatch')}</p>
		{:else}
			<ul class="font-mono text-xs" aria-label={t('chatDebug.title')}>
				{#each rows.slice(0, limit) as r (r.seq)}
					{@const time = rowTime(r.t, first)}
					<li class="border-b border-(--vscode-panel-border)/40">
						<button
							class={['flex w-full items-baseline gap-2 px-4 py-1 text-left hover:bg-(--vscode-list-hoverBackground)', r.is_error && 'text-(--vscode-errorForeground)', openRow === r.seq && 'bg-(--vscode-list-inactiveSelectionBackground)']}
							aria-expanded={openRow === r.seq}
							title={time.clock}
							onclick={() => (openRow = openRow === r.seq ? null : r.seq)}
						>
							<span class="w-[64px] shrink-0 text-right text-(--vscode-descriptionForeground)">{time.offset}</span>
							<span class={['w-[84px] shrink-0 truncate', !r.is_error && KIND_COLOR[r.kind]]}>{t(KIND_KEY[r.kind])}</span>
							<span class="max-w-[30%] shrink-0 truncate font-semibold">{r.name}</span>
							{#if r.subagent}<span class="shrink-0 rounded bg-(--vscode-badge-background) px-1 text-(--vscode-badge-foreground)">{t('chatDebug.subagent')}</span>{/if}
							<span class="min-w-0 flex-1 truncate font-sans text-(--vscode-descriptionForeground)">{r.detail}</span>
							{#if r.request !== undefined}<span class="shrink-0 text-(--vscode-descriptionForeground)">{t('chatDebug.request', { n: r.request + 1 })}</span>{/if}
							{#if r.duration_ms !== undefined}<span class="w-[64px] shrink-0 text-right">{formatDuration(r.duration_ms)}</span>{/if}
						</button>
						{#if openRow === r.seq}
							<pre class="max-h-[360px] overflow-auto bg-(--vscode-textCodeBlock-background) px-4 py-2 whitespace-pre-wrap select-text">{pretty(r.data)}</pre>
						{/if}
					</li>
				{/each}
			</ul>
			{#if rows.length > limit}
				<button class="m-3 rounded px-3 py-1 text-(--vscode-textLink-foreground) hover:underline" onclick={() => (limit += PAGE)}>{t('chatDebug.showMore', { count: Math.min(PAGE, rows.length - limit) })}</button>
			{/if}
		{/if}
	</div>
</div>
