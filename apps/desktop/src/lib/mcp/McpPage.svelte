<script lang="ts">
	// Settings › MCP Servers (VS Code's MCP server list, Cursor's Tools & MCP): every server agents
	// of this folder can get, where it comes from, an on/off switch, trust for servers that came
	// with the folder, the live status and tools the latest session reported, "Add Server…" and
	// the user's mcp.json. The store (mcp.svelte.ts) does the work.
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { mcp, SOURCE_LABEL, STATE_LABEL } from './mcp.svelte.ts';
	import { rowState, type McpRow, type McpState } from './mcpModel.ts';

	const rows = $derived(mcp.rows);
	let openTools = $state<string | null>(null);

	const DOT: Record<McpState, string> = {
		running: 'bg-green-500',
		starting: 'bg-yellow-500 animate-pulse',
		failed: 'bg-red-500',
		needsAuth: 'bg-orange-500',
		off: 'bg-(--vscode-descriptionForeground)/40',
		untrusted: 'bg-orange-500',
		invalid: 'bg-red-500',
		idle: 'bg-(--vscode-descriptionForeground)'
	};
	const TRANSPORT: Record<NonNullable<McpRow['transport']>, string> = { stdio: 'stdio', http: 'HTTP', sse: 'SSE' };

	const SECTION = 'mt-7 mb-2 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase';
	const CARD = 'rounded-xl border border-(--vscode-widget-border)';
	const MUTED = 'text-(--vscode-descriptionForeground)';
	const BUTTON = 'flex h-8 items-center gap-1.5 rounded-md border border-(--vscode-widget-border) px-3 text-[13px] hover:bg-(--vscode-list-hoverBackground) disabled:opacity-50';
	const SMALL = 'h-6 rounded-md px-2 text-xs hover:bg-(--vscode-toolbar-hoverBackground)';
</script>

<div class="h-full overflow-y-auto">
	<div class="mx-auto max-w-4xl px-8 pt-10 pb-24">
		<div class="flex items-center gap-2">
			<h1 class="flex flex-1 items-center gap-2 text-2xl leading-tight font-semibold"><Icon name="sliders" size={20} />{t('mcp.title')}</h1>
			<button class={BUTTON} disabled={mcp.loading} onclick={() => mcp.load()} aria-label={t('mcp.refresh')} title={t('mcp.refresh')}>
				<span class={['grid place-items-center', mcp.loading && 'animate-spin']}><Icon name="refresh" size={14} /></span>
			</button>
			<button class={BUTTON} onclick={() => mcp.openConfig()}><Icon name="fileText" size={14} />{t('mcp.openConfig')}</button>
			<button class="{BUTTON} border-transparent bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)" onclick={() => mcp.addServer()}>
				<Icon name="plus" size={14} />{t('mcp.addServer')}
			</button>
		</div>
		<p class="mt-1 text-[13px] {MUTED}">{t('mcp.intro')}</p>
		{#if mcp.error}<p class="mt-3 text-[13px] text-(--vscode-errorForeground)">{mcp.error}</p>{/if}

		<h2 class={SECTION}>{t('mcp.servers')}</h2>
		{#if rows.length}
			<div class="{CARD} divide-y divide-(--vscode-widget-border)">
				{#each rows as row (row.id + row.file)}
					{@const state = rowState(row)}
					{@const tools = row.live?.tools ?? []}
					<div class="px-4 py-3">
						<div class="flex items-center gap-3">
							<span class={['size-2 shrink-0 rounded-full', DOT[state]]} title={t(STATE_LABEL[state])}></span>
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
									<span class="font-medium">{row.name || row.rel || row.file}</span>
									<span class="rounded bg-(--vscode-badge-background) px-1.5 text-[11px] text-(--vscode-badge-foreground)">{t(SOURCE_LABEL[row.source])}</span>
									{#if row.transport}<span class="text-[11px] {MUTED}">{TRANSPORT[row.transport]}</span>{/if}
									<span class="text-xs {MUTED}">· {t(STATE_LABEL[state])}</span>
									{#if row.shadowed}<span class="text-xs {MUTED}">· {t('mcp.shadowed')}</span>{/if}
									{#if tools.length}
										<button class="text-xs text-(--vscode-textLink-foreground) hover:underline" aria-expanded={openTools === row.id} onclick={() => (openTools = openTools === row.id ? null : row.id)}>
											{t('mcp.tools', { count: tools.length })}
										</button>
									{/if}
								</div>
								{#if row.detail}<div class="mt-0.5 truncate font-mono text-xs {MUTED}" title={row.detail}>{row.detail}</div>{/if}
								{#if row.error}<div class="mt-0.5 text-xs text-(--vscode-errorForeground)">{row.error}</div>{/if}
								{#if row.live?.error && state === 'failed'}<div class="mt-0.5 text-xs text-(--vscode-errorForeground)">{row.live.error}</div>{/if}
								{#if row.needsTrust}<div class="mt-0.5 text-xs {MUTED}">{t('mcp.needsTrust')}</div>{/if}
							</div>
							{#if row.needsTrust}
								<button class="{SMALL} border border-(--vscode-widget-border)" onclick={() => mcp.trust(row)}>{t('mcp.action.trust')}</button>
							{:else if row.source === 'project' || row.source === 'vscode' || row.source === 'cursor'}
								{#if !row.error}<button class="{SMALL} {MUTED}" onclick={() => mcp.untrust(row)}>{t('mcp.action.untrust')}</button>{/if}
							{/if}
							{#if mcp.canOpen(row)}
								<button class="grid size-7 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={t('mcp.action.openConfig')} title={row.rel ?? row.file ?? ''} onclick={() => mcp.openFile(row)}>
									<Icon name="goToFile" size={14} />
								</button>
							{/if}
							{#if row.source === 'user' && row.name}
								<button class="grid size-7 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={t('common.remove')} title={t('common.remove')} onclick={() => mcp.remove(row)}>
									<Icon name="trash" size={14} />
								</button>
							{/if}
							{#if row.name}
								<button
									role="switch"
									aria-checked={row.enabled}
									aria-label={t('mcp.toggle', { name: row.name })}
									class={['relative h-5 w-9 shrink-0 rounded-full transition-colors', row.enabled ? 'bg-(--vscode-button-background)' : 'bg-(--vscode-widget-border)']}
									onclick={() => mcp.setEnabled(row, !row.enabled)}
								>
									<span class={['absolute top-0.5 size-4 rounded-full bg-(--vscode-button-foreground) shadow transition-[left]', row.enabled ? 'left-[18px]' : 'left-0.5']}></span>
								</button>
							{/if}
						</div>
						{#if openTools === row.id && tools.length}
							<ul class="mt-2 ml-5 flex flex-wrap gap-1.5">
								{#each tools as tool (tool)}<li class="rounded border border-(--vscode-widget-border) px-1.5 py-0.5 font-mono text-[11px]">{tool}</li>{/each}
							</ul>
						{/if}
					</div>
				{/each}
			</div>
		{:else}
			<div class="{CARD} px-4 py-6 text-center text-[13px] {MUTED}">{t('mcp.empty')}</div>
		{/if}
		<p class="mt-3 text-xs {MUTED}">{t('mcp.footnote')}</p>
	</div>
</div>
