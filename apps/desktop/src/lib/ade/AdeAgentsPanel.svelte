<script lang="ts">
	// Orca's Agents tab (Agent Session History): Kingu's task sessions plus Claude Code's own
	// sessions run in this folder or its worktrees. Scope Workspace (the selected worktree) or All, a search over title / prompt / branch / model /
	// last message, sort by Last updated or Created, rows with the latest message and metadata, a
	// click shows the prompt and the latest summary; actions jump to the worktree, resume it, or
	// copy its session id.
	import Icon from '#lib/workbench/Icon.svelte';
	import AgentIcon from '#lib/agent/AgentIcon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { adeLayout } from './adeLayout.svelte';
	import { adeTasks } from './tasks.svelte';
	import { STATUS_LABEL, type TaskView } from './model';
	import { invoke } from '@tauri-apps/api/core';
	import { ask } from '#lib/workbench/messageBox.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { PRIMARY } from './adeLayout.svelte';
	import { sessionAgo } from './agentsPanel';

	let { slug }: { slug: string } = $props();

	let scope = $state<'workspace' | 'all'>('workspace');
	const effectiveScope = $derived(scope);
	let query = $state('');
	let sort = $state<'updated' | 'created'>('updated');
	let expanded = $state<string | null>(null);

	/** Claude Code's own transcripts for this folder and its worktrees (read locally). */
	type CliSession = { id: string; title: string; preview: string | null; cwd: string | null; branch: string | null; model: string | null; messages: number; created: number; updated: number; path: string };
	let cli = $state<CliSession[]>([]);
	let loading = $state(false);
	let loadError = $state('');
	/** The folder the last read was for: an answer for a folder we left is dropped. */
	let reading: string | null = null;
	async function loadCli() {
		const root = workspace.root;
		reading = root;
		loading = true;
		try {
			const next = await invoke<CliSession[]>('claude_sessions', { limit: 250 });
			if (reading !== root) return;
			cli = next;
			loadError = '';
		} catch (e) {
			if (reading !== root) return;
			cli = [];
			loadError = String(e);
		} finally {
			if (reading === root) loading = false;
		}
	}
	// Claude Code writes its transcripts outside the folder, so the watcher never sees them: read
	// again when the folder changes, when the window comes back, and when a task's run ends.
	$effect(() => {
		void workspace.root;
		void loadCli();
		const onFocus = () => void loadCli();
		window.addEventListener('focus', onFocus);
		return () => window.removeEventListener('focus', onFocus);
	});
	const running = $derived(adeTasks.views.filter((v) => v.status === 'running').length);
	let wasRunning = 0;
	$effect(() => {
		const now = running;
		if (now < wasRunning) void loadCli();
		wasRunning = now;
	});

	/** One row: a Kingu task's session or a Claude Code session run in this folder. */
	type Item = { id: string; title: string; preview: string | null; agent: string; count: string | null; created: number; updated: number; model: string | null; status: string | null; worktree: string; sessionId: string | null; prompt: string | null; logPath: string | null; task: boolean };
	const keyOfCwd = (cwd: string | null) => cwd?.match(/\/\.kingu\/worktrees\/([^/]+)/)?.[1] ?? PRIMARY;
	const updatedOf = (v: TaskView) => Math.max(v.meta.updated_at, v.runtime?.updatedAt ?? 0, v.meta.last_run?.at ?? 0);
	const items = $derived.by((): Item[] => {
		const taskSessions = new Set(adeTasks.views.map((v) => v.meta.session_id).filter(Boolean));
		const tasks: Item[] = adeTasks.views.map((v) => ({
			id: `task:${v.meta.slug}`,
			title: v.meta.title,
			preview: (() => {
				const t = v.runtime?.lastEvent ?? v.meta.last_run?.summary;
				return t ? `Agent: ${t}` : null;
			})(),
			agent: v.meta.agent || 'agent',
			count: v.meta.last_run?.num_turns ? `${v.meta.last_run.num_turns} turns` : null,
			created: v.meta.created_at,
			updated: updatedOf(v),
			model: v.runtime?.model ?? v.meta.model,
			status: STATUS_LABEL[v.status],
			worktree: v.meta.slug,
			sessionId: v.meta.session_id,
			prompt: v.meta.prompt,
			logPath: null,
			task: true
		}));
		const own: Item[] = cli
			.filter((c) => !taskSessions.has(c.id))
			.map((c) => ({
				id: `cli:${c.id}`,
				title: c.title,
				preview: c.preview,
				agent: 'claude',
				count: `${c.messages} msgs`,
				created: c.created,
				updated: c.updated,
				model: c.model,
				status: null,
				worktree: keyOfCwd(c.cwd),
				sessionId: c.id,
				prompt: null,
				logPath: c.path,
				task: false
			}));
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		return [...tasks, ...own]
			.filter((x) => effectiveScope === 'all' || x.worktree === (adeLayout.key ?? PRIMARY))
			.filter((x) => {
				const hay = [x.title, x.prompt ?? '', x.worktree, x.agent, x.model ?? '', x.sessionId ?? '', x.preview ?? ''].join(' ').toLowerCase();
				return terms.every((t) => hay.includes(t));
			})
			.sort((a, b) => (sort === 'created' ? b.created - a.created : b.updated - a.updated));
	});
	const total = $derived(adeTasks.views.length + cli.length);

	let menu = $state<{ x: Item; px: number; py: number } | null>(null);
	const menuItems = $derived(
		menu
			? [
					menuItem('jump', menu.x.worktree === PRIMARY ? 'Jump to Folder' : 'Jump to Worktree', { enabled: menu.x.worktree !== adeLayout.key }),
					menuItem('resume', menu.x.task ? 'Resume in Worktree' : 'Resume in New Tab', { enabled: menu.x.task || !!menu.x.sessionId }),
					menuItem('copyResume', 'Copy Resume Command', { enabled: !!menu.x.sessionId }),
					menuSeparator,
					menuItem('handoff', 'Hand Off to Another Agent'),
					menuSeparator,
					menuItem('copyId', 'Copy Session ID', { enabled: !!menu.x.sessionId }),
					...(menu.x.logPath ? [menuItem('copyLog', 'Copy Log Path')] : []),
					...(menu.x.prompt ? [menuItem('copyPrompt', 'Copy Prompt')] : []),
					menuSeparator,
					menuItem('delete', 'Delete', { enabled: !menu.x.task && !!menu.x.logPath })
				]
			: []
	);
	async function run(id: string, x: Item) {
		if (id === 'jump') return adeLayout.show(x.worktree);
		if (id === 'resume') {
			adeLayout.show(x.worktree);
			if (x.task) return adeLayout.select(x.worktree, 'main');
			// A Claude Code session opens in a new terminal of its worktree with `claude --resume`.
			adeLayout.newTerminal(x.worktree, { title: 'claude', run: ['claude', '--resume', x.sessionId ?? ''] });
			return status.flash('claude session queued', 2000);
		}
		if (id === 'delete') {
			const ok = await ask(`"${x.title}" will be deleted. Once deleted, it will no longer be resumable from Claude's own command line either.`, { title: 'Delete this session?', kind: 'warning', okLabel: 'Delete', cancelLabel: 'Cancel' });
			if (!ok || !x.logPath) return;
			try {
				await invoke('delete_claude_session', { path: x.logPath });
				status.flash('Session deleted', 2000);
			} catch (e) {
				status.error(`Couldn't delete the session. ${e}`);
			}
			return void loadCli();
		}
		if (id === 'handoff') {
			// A new task whose agent picks up from this session's title, prompt and latest message.
			const brief = [`Continue the work of the earlier agent session "${x.title}".`, x.prompt ? `Its original request:\n${x.prompt}` : '', x.preview ? `Where it left off:\n${x.preview}` : '', x.logPath ? `Its full transcript is at ${x.logPath} (read it for detail).` : '']
				.filter(Boolean)
				.join('\n\n');
			const slug = await adeTasks.create({ title: `Continue: ${x.title}`.slice(0, 80), prompt: brief, base: '' });
			if (slug) adeLayout.show(slug);
			return;
		}
		const text = id === 'copyResume' ? `claude --resume ${x.sessionId}` : id === 'copyId' ? (x.sessionId ?? '') : id === 'copyLog' ? (x.logPath ?? '') : (x.prompt ?? '');
		await navigator.clipboard.writeText(text);
		status.flash({ copyResume: 'Resume command copied', copyId: 'Session ID copied', copyLog: 'Log path copied', copyPrompt: 'Prompt copied' }[id] ?? 'Copied', 2000);
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
			<button class={ICON_BTN} aria-label="Refresh Session History" title="Refresh" disabled={loading} onclick={() => (adeTasks.load(), loadCli())}><span class={['grid place-items-center', loading && 'animate-spin']}><Icon name="refresh" size={12} /></span></button>
		</div>
		<div class="mt-2 grid h-7 grid-cols-2 rounded-md border border-(--vscode-widget-border) bg-(--vscode-list-inactiveSelectionBackground)/35 p-px" role="radiogroup" aria-label="Session History scope">
			{#each [['workspace', 'Workspace'], ['all', 'All']] as const as [id, label] (id)}
				<button
					role="radio"
					aria-checked={effectiveScope === id}
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
			<span class="min-w-0 flex-1 truncate text-xs font-semibold tabular-nums">{items.length === total ? `${total} session${total === 1 ? '' : 's'}` : `${items.length} of ${total} sessions`}</span>
			<button class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="Sort sessions: {sort === 'updated' ? 'Last updated' : 'Created'}" onclick={() => (sort = sort === 'updated' ? 'created' : 'updated')}>
				{sort === 'updated' ? 'Last updated' : 'Created'}<span class={MUTED}><Icon name="chevronDown" size={12} /></span>
			</button>
		</div>
	{/if}

	<div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
		{#each items as v (v.id)}
			{@const open = expanded === v.id}
			{@const p = v.preview}
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			<div
				class={['group/session-row flex w-full min-w-0 cursor-pointer flex-col border-b border-(--vscode-widget-border) px-3 py-2 text-left transition-colors hover:bg-(--vscode-list-hoverBackground)/55', !open && 'min-h-[98px]']}
				onclick={() => (expanded = open ? null : v.id)}
				oncontextmenu={(e) => (e.preventDefault(), (menu = { x: v, px: e.clientX, py: e.clientY }))}
			>
				<div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1">
					<span class={['min-w-0 text-[13px] leading-5 font-medium', open ? 'line-clamp-2 [overflow-wrap:anywhere]' : 'line-clamp-1']}>{v.title}</span>
					<span class="flex shrink-0 items-center gap-1" role="presentation" onclick={(e) => e.stopPropagation()}>
						<span class="flex max-w-0 -ml-1 items-center gap-1 overflow-hidden opacity-0 transition-all group-hover/session-row:ml-0 group-hover/session-row:max-w-20 group-hover/session-row:opacity-100">
							{#if v.worktree !== adeLayout.key}<button class={ICON_BTN} title={v.worktree === PRIMARY ? 'Jump to Folder' : 'Jump to Worktree'} aria-label="Jump to Worktree" onclick={() => run('jump', v)}><Icon name="agentsLayout" size={14} /></button>{/if}
							<button class={ICON_BTN} title={v.task ? 'Resume in Worktree' : 'Resume in New Tab'} aria-label="Resume" onclick={() => run('resume', v)}><Icon name="play" size={14} /></button>
						</span>
						<button class={ICON_BTN} title={open ? 'Hide Details' : 'Show Details'} aria-label="{v.agent} session details" onclick={() => (expanded = open ? null : v.id)}>
							<span class={['transition-transform', open && 'rotate-180']}><Icon name="chevronDown" size={14} /></span>
						</button>
						<button class={ICON_BTN} title="More Actions" aria-label="More Session Actions" onclick={(e) => (menu = { x: v, px: e.clientX, py: e.clientY })}><Icon name="more" size={14} /></button>
					</span>
				</div>
				{#if !open}
					<p class="mt-0.5 line-clamp-2 min-w-0 text-[12px] leading-4 {MUTED}">{p ?? 'No conversation preview available'}</p>
				{/if}
				<div class="mt-1 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 gap-y-0.5 text-[11px] leading-4 {MUTED}">
					<span class="flex size-4 items-center justify-center"><AgentIcon agent={v.agent || 'claude'} size={14} /></span>
					<span class="flex min-w-0 items-center gap-1.5">
						<span class="min-w-0 shrink-[2] truncate">{v.agent}</span>
						{#if v.count}<span class="opacity-55">·</span><span class="tabular-nums">{v.count}</span>{/if}
						<span class="opacity-55">·</span><time datetime={v.updated ? new Date(v.updated).toISOString() : undefined}>{sessionAgo(v.updated, adeTasks.now)}</time>
						{#if v.model}<span class="opacity-55">·</span><span class="truncate" title={v.model}>{v.model}</span>{/if}
					</span>
					<span class="col-span-2 flex min-w-0 items-center gap-1.5">
						{#if v.status}<span class="rounded-sm border border-(--vscode-widget-border) bg-(--vscode-list-inactiveSelectionBackground)/45 px-1.5 py-0.5 text-[10px] leading-none">{v.status}</span>{/if}
						<span class="truncate rounded border border-(--vscode-widget-border) px-1.5 font-mono text-[10px] leading-4">{v.worktree === PRIMARY ? (workspace.name ?? 'folder') : `kingu/${v.worktree}`}</span>
					</span>
				</div>
				{#if open}
					<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
					<div class="mt-2 overflow-hidden rounded-lg border border-(--vscode-widget-border) bg-(--vscode-editor-background)/50" onclick={(e) => e.stopPropagation()}>
						<div class="flex flex-wrap gap-1.5 border-b border-(--vscode-widget-border) px-3 py-2">
							<button class="flex h-7 items-center gap-1 rounded-md bg-(--vscode-button-background) px-2.5 text-[11px] text-(--vscode-button-foreground)" onclick={() => run('resume', v)}><Icon name="play" size={13} />{v.task ? 'Resume in Worktree' : 'Resume in New Tab'}</button>
						</div>
						<div class="space-y-3 p-3">
							<div>
								<div class="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.05em] uppercase {MUTED}">Prompt</div>
								<div class="mt-1 rounded-md border border-(--vscode-widget-border) bg-(--vscode-foreground)/[0.04] px-2.5 py-2">
									<div class="flex items-center justify-between text-[10px] font-semibold tracking-[0.05em] uppercase">You<button class="h-6 rounded px-1.5 text-[10px] font-normal normal-case {MUTED} hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="Copy prompt" onclick={() => run('copyPrompt', v)}>Copy</button></div>
									<p class="max-h-48 overflow-y-auto text-[12px] leading-[1.35] whitespace-pre-wrap select-text [overflow-wrap:anywhere]">{v.prompt ?? v.title}</p>
								</div>
							</div>
							<div>
								<div class="text-[11px] font-semibold tracking-[0.05em] uppercase {MUTED}">Latest turns</div>
								{#if p}
									<div class="mt-1 rounded-md border border-(--vscode-widget-border) bg-(--vscode-list-inactiveSelectionBackground)/25 px-2.5 py-2">
										<div class="mb-1 text-[10px] font-semibold tracking-[0.05em] uppercase">{p.startsWith('You:') ? 'You' : 'Agent'}</div>
										<p class="line-clamp-4 text-[12px] leading-[1.35] select-text">{p.replace(/^(Agent|You): /, '')}</p>
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
				{#if loadError}<p class="mt-1 text-[11px] break-words text-(--vscode-errorForeground)" title={loadError}>Couldn't read Claude Code's sessions.</p>{/if}
			</div>
		{/each}
	</div>
</div>

{#if menu}
	{@const v = menu.x}
	<PopupMenu items={menuItems} label="Session" x={menu.px} y={menu.py} onRun={(n) => n.type === 'item' && void run(n.id, v)} onClose={() => (menu = null)} />
{/if}
