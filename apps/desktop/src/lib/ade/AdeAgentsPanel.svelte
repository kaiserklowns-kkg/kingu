<script lang="ts">
	// Orca's Agents tab (Agent Session History) for Kingu's agent sessions: one per task. Scope
	// Workspace (the selected worktree) or All, a search over title / prompt / branch / model /
	// last message, sort by Last updated or Created, rows with the latest message and metadata, a
	// click shows the prompt and the latest summary; actions jump to the worktree, resume it, or
	// copy its session id.
	import Icon from '#lib/workbench/Icon.svelte';
	import ProviderIcon from '#lib/workbench/ProviderIcon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { adeLayout } from './adeLayout.svelte';
	import { adeTasks } from './tasks.svelte';
	import { STATUS_LABEL, type TaskView } from './model';
	import { sessionAgo } from './agentsPanel';

	let { slug }: { slug: string } = $props();

	let scope = $state<'workspace' | 'all'>('workspace');
	const effectiveScope = $derived(slug ? scope : 'all');
	let query = $state('');
	let sort = $state<'updated' | 'created'>('updated');
	let expanded = $state<string | null>(null);

	const updated = (v: TaskView) => Math.max(v.meta.updated_at, v.runtime?.updatedAt ?? 0, v.meta.last_run?.at ?? 0);
	const preview = (v: TaskView) => v.runtime?.lastEvent ?? v.meta.last_run?.summary ?? null;
	const sessions = $derived.by(() => {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		return adeTasks.views
			.filter((v) => effectiveScope === 'all' || v.meta.slug === slug)
			.filter((v) => {
				const hay = [v.meta.title, v.meta.prompt, v.meta.slug, v.meta.agent, v.meta.model ?? '', v.meta.session_id ?? '', preview(v) ?? ''].join(' ').toLowerCase();
				return terms.every((t) => hay.includes(t));
			})
			.sort((a, b) => (sort === 'created' ? b.meta.created_at - a.meta.created_at : updated(b) - updated(a)));
	});
	const total = $derived(adeTasks.views.filter((v) => effectiveScope === 'all' || v.meta.slug === slug).length);

	let menu = $state<{ v: TaskView; x: number; y: number } | null>(null);
	const items = $derived(
		menu
			? [
					menuItem('jump', 'Jump to Worktree', { enabled: menu.v.meta.slug !== adeLayout.key }),
					menuItem('resume', 'Resume in Worktree'),
					menuSeparator,
					menuItem('copyId', 'Copy Session ID', { enabled: !!menu.v.meta.session_id }),
					menuItem('copyPrompt', 'Copy Prompt')
				]
			: []
	);
	async function run(id: string, v: TaskView) {
		if (id === 'jump' || id === 'resume') {
			adeLayout.show(v.meta.slug);
			adeLayout.select(v.meta.slug, 'main');
			return;
		}
		const text = id === 'copyId' ? (v.meta.session_id ?? '') : v.meta.prompt;
		await navigator.clipboard.writeText(text);
		status.flash(id === 'copyId' ? 'Session ID copied' : 'Prompt copied', 2000);
	}

	const MUTED = 'text-(--vscode-descriptionForeground)';
	const ICON_BTN = 'grid size-6 shrink-0 place-items-center rounded text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)';
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="shrink-0 border-b border-(--vscode-widget-border) px-2.5 py-2">
		<div class="flex items-center gap-1.5">
			<div class="min-w-0 flex-1">
				<div class="truncate text-xs font-semibold">Agent Session History</div>
				<div class="truncate text-[11px] {MUTED}">Resume past sessions</div>
			</div>
			<button class={ICON_BTN} aria-label="Refresh Session History" title="Refresh" onclick={() => adeTasks.load()}><Icon name="refresh" size={12} /></button>
		</div>
		<div class="mt-2 grid h-7 grid-cols-2 rounded-md border border-(--vscode-widget-border) bg-(--vscode-list-inactiveSelectionBackground)/35 p-px" role="radiogroup" aria-label="Session History scope">
			{#each [['workspace', 'Workspace'], ['all', 'All']] as const as [id, label] (id)}
				<button
					role="radio"
					aria-checked={effectiveScope === id}
					disabled={id === 'workspace' && !slug}
					class={['rounded-[5px] text-[11px] font-medium disabled:opacity-40', effectiveScope === id ? 'border border-(--vscode-foreground)/20 bg-(--vscode-foreground)/10' : 'hover:bg-(--vscode-list-hoverBackground)']}
					onclick={() => (scope = id)}>{label}</button
				>
			{/each}
		</div>
		<label class="mt-2 flex h-8 items-center gap-1.5 rounded-md border border-(--vscode-widget-border) bg-(--vscode-input-background)/50 px-2 focus-within:border-(--vscode-focusBorder)">
			<span class={MUTED}><Icon name="search" size={14} /></span>
			<input class="min-w-0 flex-1 bg-transparent py-1.5 text-xs outline-none placeholder:text-(--vscode-input-placeholderForeground)/50" placeholder="Search sessions" aria-label="Search sessions" spellcheck="false" bind:value={query} onkeydown={(e) => e.key === 'Escape' && (e.stopPropagation(), (query = ''))} />
			{#if query}<button class="grid size-5 place-items-center rounded-sm {MUTED} hover:text-(--vscode-foreground)" aria-label="Clear search" onclick={() => (query = '')}><Icon name="close" size={12} /></button>{/if}
		</label>
	</div>

	{#if total}
		<div class="flex h-8 shrink-0 items-center gap-2 border-b border-(--vscode-widget-border) bg-(--vscode-list-inactiveSelectionBackground)/60 pr-1.5 pl-3">
			<span class="min-w-0 flex-1 truncate text-xs font-semibold tabular-nums">{sessions.length === total ? `${total} session${total === 1 ? '' : 's'}` : `${sessions.length} of ${total} sessions`}</span>
			<button class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="Sort sessions: {sort === 'updated' ? 'Last updated' : 'Created'}" onclick={() => (sort = sort === 'updated' ? 'created' : 'updated')}>
				{sort === 'updated' ? 'Last updated' : 'Created'}<span class={MUTED}><Icon name="chevronDown" size={12} /></span>
			</button>
		</div>
	{/if}

	<div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
		{#each sessions as v (v.meta.slug)}
			{@const open = expanded === v.meta.slug}
			{@const p = preview(v)}
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			<div
				class={['group/session-row flex w-full min-w-0 cursor-pointer flex-col border-b border-(--vscode-widget-border) px-3 py-2 text-left transition-colors hover:bg-(--vscode-list-hoverBackground)/55', !open && 'min-h-[98px]']}
				onclick={() => (expanded = open ? null : v.meta.slug)}
				oncontextmenu={(e) => (e.preventDefault(), (menu = { v, x: e.clientX, y: e.clientY }))}
			>
				<div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1">
					<span class={['min-w-0 text-[13px] leading-5 font-medium', open ? 'line-clamp-2 [overflow-wrap:anywhere]' : 'line-clamp-1']}>{v.meta.title}</span>
					<span class="flex shrink-0 items-center gap-1" role="presentation" onclick={(e) => e.stopPropagation()}>
						<span class="flex max-w-0 -ml-1 items-center gap-1 overflow-hidden opacity-0 transition-all group-hover/session-row:ml-0 group-hover/session-row:max-w-20 group-hover/session-row:opacity-100">
							{#if v.meta.slug !== adeLayout.key}<button class={ICON_BTN} title="Jump to Worktree" aria-label="Jump to Worktree" onclick={() => run('jump', v)}><Icon name="agentsLayout" size={14} /></button>{/if}
							<button class={ICON_BTN} title="Resume in Worktree" aria-label="Resume in Worktree" onclick={() => run('resume', v)}><Icon name="play" size={14} /></button>
						</span>
						<button class={ICON_BTN} title={open ? 'Hide Details' : 'Show Details'} aria-label="{v.meta.agent} session details" onclick={() => (expanded = open ? null : v.meta.slug)}>
							<span class={['transition-transform', open && 'rotate-180']}><Icon name="chevronDown" size={14} /></span>
						</button>
						<button class={ICON_BTN} title="More Actions" aria-label="More Session Actions" onclick={(e) => (menu = { v, x: e.clientX, y: e.clientY })}><Icon name="more" size={14} /></button>
					</span>
				</div>
				{#if !open}
					<p class="mt-0.5 line-clamp-2 min-w-0 text-[12px] leading-4 {MUTED}">{p ? `Agent: ${p}` : 'No conversation preview available'}</p>
				{/if}
				<div class="mt-1 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 gap-y-0.5 text-[11px] leading-4 {MUTED}">
					<span class="flex size-4 items-center justify-center">{#if v.meta.agent === 'codex'}<ProviderIcon provider="codex" size={14} />{:else}<ProviderIcon provider="claude" size={14} />{/if}</span>
					<span class="flex min-w-0 items-center gap-1.5">
						<span class="min-w-0 shrink-[2] truncate">{v.meta.agent || 'agent'}</span>
						{#if v.meta.last_run?.num_turns}<span class="opacity-55">·</span><span class="tabular-nums">{v.meta.last_run.num_turns} turns</span>{/if}
						<span class="opacity-55">·</span><time datetime={new Date(updated(v)).toISOString()}>{sessionAgo(updated(v), adeTasks.now)}</time>
						{#if v.runtime?.model ?? v.meta.model}<span class="opacity-55">·</span><span class="truncate" title={v.runtime?.model ?? v.meta.model ?? ''}>{v.runtime?.model ?? v.meta.model}</span>{/if}
					</span>
					<span class="col-span-2 flex min-w-0 items-center gap-1.5">
						<span class="rounded-sm border border-(--vscode-widget-border) bg-(--vscode-list-inactiveSelectionBackground)/45 px-1.5 py-0.5 text-[10px] leading-none">{STATUS_LABEL[v.status]}</span>
						<span class="truncate rounded border border-(--vscode-widget-border) px-1.5 font-mono text-[10px] leading-4">kingu/{v.meta.slug}</span>
					</span>
				</div>
				{#if open}
					<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
					<div class="mt-2 overflow-hidden rounded-lg border border-(--vscode-widget-border) bg-(--vscode-editor-background)/50" onclick={(e) => e.stopPropagation()}>
						<div class="flex flex-wrap gap-1.5 border-b border-(--vscode-widget-border) px-3 py-2">
							<button class="flex h-7 items-center gap-1 rounded-md bg-(--vscode-button-background) px-2.5 text-[11px] text-(--vscode-button-foreground)" onclick={() => run('resume', v)}><Icon name="play" size={13} />Resume in Worktree</button>
						</div>
						<div class="space-y-3 p-3">
							<div>
								<div class="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.05em] uppercase {MUTED}">Prompt</div>
								<div class="mt-1 rounded-md border border-(--vscode-widget-border) bg-(--vscode-foreground)/[0.04] px-2.5 py-2">
									<div class="flex items-center justify-between text-[10px] font-semibold tracking-[0.05em] uppercase">You<button class="h-6 rounded px-1.5 text-[10px] font-normal normal-case {MUTED} hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="Copy prompt" onclick={() => run('copyPrompt', v)}>Copy</button></div>
									<p class="max-h-48 overflow-y-auto text-[12px] leading-[1.35] whitespace-pre-wrap select-text [overflow-wrap:anywhere]">{v.meta.prompt || '—'}</p>
								</div>
							</div>
							<div>
								<div class="text-[11px] font-semibold tracking-[0.05em] uppercase {MUTED}">Latest turns</div>
								{#if p}
									<div class="mt-1 rounded-md border border-(--vscode-widget-border) bg-(--vscode-list-inactiveSelectionBackground)/25 px-2.5 py-2">
										<div class="mb-1 text-[10px] font-semibold tracking-[0.05em] uppercase">Agent</div>
										<p class="line-clamp-4 text-[12px] leading-[1.35] select-text">{p}</p>
									</div>
								{:else}
									<p class="mt-1 rounded-md border border-dashed border-(--vscode-widget-border) px-2.5 py-2 text-[11px] {MUTED}">No conversation preview available</p>
								{/if}
							</div>
						</div>
					</div>
				{/if}
			</div>
		{:else}
			<div class="flex h-full flex-col items-center justify-center px-4 text-center {MUTED}">
				<span class="mb-3 opacity-50"><Icon name="agentsLayout" size={28} /></span>
				<p class="text-sm font-medium">{total ? 'No sessions match the current filters' : 'No agent sessions found'}</p>
			</div>
		{/each}
	</div>
</div>

{#if menu}
	{@const v = menu.v}
	<PopupMenu {items} label="Session" x={menu.x} y={menu.y} onRun={(n) => n.type === 'item' && void run(n.id, v)} onClose={() => (menu = null)} />
{/if}
