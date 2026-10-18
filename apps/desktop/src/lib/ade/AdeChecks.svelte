<script lang="ts">
	// Orca's Checks tab for the selected worktree's branch: its pull request (number, state, an
	// editable title, merge state and the actions for that state: merge with a method, mark ready,
	// close, reopen), an action strip (Fix failing checks with the task's agent), the CI checks
	// failures first with the failed log excerpt, then the comments with a composer. Polls every
	// 60 seconds while shown (doubling to 120 when nothing changes), and on window focus.
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '#lib/workbench/Icon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { ask } from '#lib/workbench/dialogService.svelte.ts';
	import { renderMarkdown } from '#lib/workbench/markdown.ts';
	import { adeTasks } from './tasks.svelte';
	import { checkKind, checkLabel, checkRank, fixPrompt, mergeLabel, reactionPills, REACTIONS, summarize, type Check, type Pr, type PrComment, type ReviewThread } from './checks';
	import { sessionAgo } from './agentsPanel';

	let { slug }: { slug: string } = $props();

	let pr = $state<Pr | null>(null);
	let loaded = $state(false);
	let loading = $state(false);
	let error = $state('');
	let updatedAt = $state<number | null>(null);
	let listOpen = $state(true);
	let busy = $state<string | null>(null);
	let actionError = $state('');

	let delay = 60_000;
	let signature = '';
	async function refresh() {
		if (loading) return;
		loading = true;
		try {
			const next = await invoke<Pr | null>('gh_pr_view', { slug: slug || null });
			const sig = (next?.statusCheckRollup ?? []).map((c) => `${c.name}:${c.status}:${c.conclusion}`).join('|');
			delay = sig === signature ? Math.min(delay * 2, 120_000) : 60_000;
			signature = sig;
			pr = next;
			error = '';
			updatedAt = Date.now();
			if (next) void loadComments();
		} catch (e) {
			error = String(e);
		}
		loaded = true;
		loading = false;
	}
	$effect(() => {
		void slug;
		let timer: ReturnType<typeof setTimeout>;
		const tick = async () => {
			if (document.visibilityState === 'visible') await refresh();
			timer = setTimeout(tick, delay);
		};
		void tick();
		window.addEventListener('focus', refresh);
		return () => (clearTimeout(timer), window.removeEventListener('focus', refresh));
	});

	/** The backend's "gh is not installed" error. */
	const ghMissing = $derived(error.includes('ติดตั้ง GitHub CLI'));
	const checks = $derived([...(pr?.statusCheckRollup ?? [])].sort((a, b) => checkRank(a) - checkRank(b)));
	const counts = $derived(summarize(checks));
	const failing = $derived(checks.filter((c) => ['failure', 'cancelled'].includes(checkKind(c))));
	const open = (url: string | undefined) => url && invoke('open_web_url', { url }).catch((e) => status.error(String(e)));

	// --- PR actions ---------------------------------------------------------------------------
	const METHODS = [
		{ id: 'squash', label: 'Squash and merge' },
		{ id: 'merge', label: 'Create merge commit' },
		{ id: 'rebase', label: 'Rebase and merge' }
	];
	let method = $state('squash');
	let actionMenu = $state<{ x: number; y: number } | null>(null);
	async function act(action: 'merge' | 'close' | 'reopen' | 'ready' | 'auto' | 'disableAuto') {
		if (!pr) return;
		if (action === 'close' || action === 'reopen') {
			const ok = await ask(`This will ${action} the pull request.`, { title: `${action === 'close' ? 'Close' : 'Reopen'} PR #${pr.number}?`, kind: 'warning', okLabel: action === 'close' ? 'Close' : 'Reopen', cancelLabel: 'Cancel' });
			if (!ok) return;
		}
		if (action === 'merge') {
			const label = METHODS.find((x) => x.id === method)?.label ?? 'Merge';
			if (!(await ask(`${label}: PR #${pr.number} into ${pr.baseRefName}?`, { title: 'Merge pull request', okLabel: 'Merge', cancelLabel: 'Cancel' }))) return;
		}
		busy = action;
		actionError = '';
		try {
			await invoke('gh_pr_action', { slug: slug || null, action, method });
			status.flash(
				{ merge: `PR #${pr.number} merged`, ready: 'PR marked ready for review', close: 'PR closed', reopen: 'PR reopened', auto: 'Auto-merge enabled', disableAuto: 'Auto-merge disabled' }[action],
				4000
			);
		} catch (e) {
			actionError = String(e);
		} finally {
			busy = null;
			await refresh();
		}
	}
	const actionItems = $derived.by((): MenuNode[] => {
		if (!pr) return [];
		if (pr.isDraft) return [menuItem('close', 'Close PR')];
		return [
			pr.autoMergeRequest ? menuItem('disableAuto', 'Disable auto-merge') : menuItem('auto', 'Enable auto-merge'),
			menuSeparator,
			...METHODS.map((x) => menuItem(`m:${x.id}`, x.label, { checked: method === x.id })),
			menuSeparator,
			menuItem('close', 'Close PR')
		];
	});
	function runAction(id: string) {
		if (id === 'close' || id === 'auto' || id === 'disableAuto') void act(id);
		else if (id.startsWith('m:')) method = id.slice(2);
	}

	// --- Title edit ---------------------------------------------------------------------------
	let editing = $state(false);
	let titleDraft = $state('');
	async function saveTitle() {
		const t = titleDraft.trim();
		editing = false;
		if (!pr || !t || t === pr.title) return;
		busy = 'title';
		try {
			await invoke('gh_pr_edit_title', { slug: slug || null, title: t });
		} catch (e) {
			actionError = String(e);
		}
		busy = null;
		await refresh();
	}

	// --- Check details (failed log excerpt) ---------------------------------------------------
	let expanded = $state<string | null>(null);
	let logs = $state<Record<string, string>>({});
	async function toggleCheck(key: string, c: Check) {
		expanded = expanded === key ? null : key;
		const url = c.detailsUrl ?? c.targetUrl;
		if (expanded !== key || !url || logs[key] !== undefined || checkKind(c) === 'success') return;
		logs[key] = '';
		try {
			logs[key] = (await invoke<string>('gh_check_log', { slug: slug || null, url })) || 'No inline details are available for this check.';
		} catch (e) {
			logs[key] = String(e).replace(/^gh run: /, '');
		}
	}

	// --- Fix with the task's agent ------------------------------------------------------------
	async function fix() {
		if (!pr || !slug || !failing.length) return;
		busy = 'fix';
		const withLogs = await Promise.all(
			failing.slice(0, 5).map(async (c) => {
				const url = c.detailsUrl ?? c.targetUrl;
				const log = url ? await invoke<string>('gh_check_log', { slug, url }).catch(() => '') : '';
				return { name: c.name ?? c.context ?? 'check', url, log };
			})
		);
		try {
			await adeTasks.followUp(slug, fixPrompt(pr, withLogs));
			status.flash('Started an AI agent for the broken checks.', 4000);
		} catch (e) {
			actionError = String(e);
		}
		busy = null;
	}

	// --- Comments -----------------------------------------------------------------------------
	let comments = $state<PrComment[]>([]);
	let audience = $state<'all' | 'humans' | 'bots'>('all');
	let draft = $state('');
	let composing = $state(false);
	async function loadComments() {
		try {
			const r = await invoke<{ comments: PrComment[]; reviews: PrComment[] }>('gh_pr_comments', { slug: slug || null });
			comments = [...(r.comments ?? []), ...(r.reviews ?? []).filter((x) => x.body?.trim())].sort((a, b) => Date.parse(a.createdAt ?? a.submittedAt ?? '') - Date.parse(b.createdAt ?? b.submittedAt ?? ''));
		} catch {
			// Checks still show without comments.
		}
	}
	const isBot = (c: PrComment) => /\[bot\]$|bot$|^github-actions|dependabot|renovate|codecov|coderabbit/i.test(c.author?.login ?? '');
	const shown = $derived(comments.filter((c) => audience === 'all' || (audience === 'bots') === isBot(c)));
	const countFor = (id: 'all' | 'humans' | 'bots') => comments.filter((c) => id === 'all' || (id === 'bots') === isBot(c)).length;
	async function send() {
		const body = draft.trim();
		if (!body) return;
		busy = 'comment';
		try {
			await invoke('gh_pr_comment', { slug: slug || null, body });
			draft = '';
			composing = false;
			await loadComments();
		} catch (e) {
			actionError = String(e).includes('too large') ? 'Comment is too large to submit safely.' : 'Failed to post comment.';
		}
		busy = null;
	}

	// --- Review threads and reactions -----------------------------------------------------------
	let threads = $state<ReviewThread[]>([]);
	let showResolved = $state(false);
	let replyTo = $state<string | null>(null);
	let replyDraft = $state('');
	async function loadThreads() {
		if (!pr) return;
		try {
			const r = await invoke<{ data?: { repository?: { pullRequest?: { reviewThreads?: { nodes: ReviewThread[] } } } } }>('gh_review_threads', { slug: slug || null, number: pr.number });
			threads = r.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
		} catch {
			threads = [];
		}
	}
	$effect(() => {
		if (pr?.number) void loadThreads();
	});
	const open_ = $derived(threads.filter((t) => !t.isResolved));
	const resolved = $derived(threads.filter((t) => t.isResolved));
	async function resolveThread(t: ReviewThread) {
		busy = `thread:${t.id}`;
		try {
			await invoke('gh_thread_resolve', { slug: slug || null, thread: t.id, resolve: !t.isResolved });
			t.isResolved = !t.isResolved;
		} catch {
			actionError = 'Could not update review thread. Check the GitHub API budget.';
		}
		busy = null;
	}
	async function reply(t: ReviewThread) {
		const body = replyDraft.trim();
		if (!body) return;
		busy = `reply:${t.id}`;
		try {
			await invoke('gh_reply_thread', { slug: slug || null, thread: t.id, body });
			replyDraft = '';
			replyTo = null;
			await loadThreads();
		} catch {
			actionError = 'Failed to post comment.';
		}
		busy = null;
	}
	let picker = $state<string | null>(null);
	async function react(c: PrComment, content: string, remove = false) {
		picker = null;
		if (!c.id) return;
		try {
			await invoke('gh_react', { slug: slug || null, subject: c.id, content, remove });
			await Promise.all([loadComments(), loadThreads()]);
		} catch {
			status.error('Failed to update reaction.');
		}
	}

	const ICON: Record<ReturnType<typeof checkKind>, { name: 'checkCircle' | 'error' | 'circleDashed' | 'warning' | 'minus'; cls: string; spin?: boolean }> = {
		success: { name: 'checkCircle', cls: 'text-emerald-500' },
		failure: { name: 'error', cls: 'text-rose-500' },
		cancelled: { name: 'error', cls: 'text-(--vscode-descriptionForeground)/60' },
		pending: { name: 'circleDashed', cls: 'text-amber-500', spin: true },
		skipped: { name: 'minus', cls: 'text-(--vscode-descriptionForeground)/60' },
		neutral: { name: 'circleDashed', cls: 'text-(--vscode-descriptionForeground)' },
		action: { name: 'warning', cls: 'text-amber-500' }
	};
	const STATE: Record<string, string> = {
		OPEN: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20',
		MERGED: 'bg-purple-500/15 text-purple-500 border-purple-500/20',
		CLOSED: 'bg-red-500/10 text-red-400 border-red-500/20',
		DRAFT: 'bg-(--vscode-list-inactiveSelectionBackground) text-(--vscode-descriptionForeground) border-(--vscode-widget-border)'
	};
	const MUTED = 'text-(--vscode-descriptionForeground)';
	const BTN = 'h-6 rounded-md border border-(--vscode-widget-border) px-2 text-[11px] hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50';
	const openMenu = (e: MouseEvent) => {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		actionMenu = { x: r.right - 248, y: r.bottom + 4 };
	};
</script>

{#snippet reactions(c: PrComment)}
	<div class="flex flex-wrap items-center gap-1 px-4 pb-2">
		{#each reactionPills(c) as r (r.content)}
			<button class={['h-6 rounded-full border px-2 text-[12px]', r.mine ? 'border-(--vscode-focusBorder) bg-(--vscode-list-inactiveSelectionBackground)' : 'border-(--vscode-widget-border)']} onclick={() => react(c, r.content, r.mine)}>{r.emoji} {r.count}</button>
		{/each}
		<span class="relative">
			<button class="grid h-6 w-7 place-items-center rounded-full border border-(--vscode-widget-border) text-[12px] opacity-60 hover:opacity-100" aria-label="Add reaction" title="Add reaction" onclick={() => (picker = picker === c.id ? null : (c.id ?? null))}>☺+</button>
			{#if picker && picker === c.id}
				<span class="absolute bottom-7 left-0 z-20 grid grid-cols-4 gap-1 rounded-md border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) p-1 shadow-lg">
					{#each REACTIONS as r (r.content)}<button class="grid size-7 place-items-center rounded hover:bg-(--vscode-list-hoverBackground)" aria-label={r.content} onclick={() => react(c, r.content)}>{r.emoji}</button>{/each}
				</span>
			{/if}
		</span>
	</div>
{/snippet}

{#snippet thread(t: ReviewThread)}
	<div class="overflow-clip rounded-lg border border-(--vscode-widget-border) bg-(--vscode-editor-background)">
		<div class="flex items-center gap-2 border-b border-(--vscode-widget-border)/60 px-3 py-1.5 text-[11px] {MUTED}">
			<span class="min-w-0 flex-1 truncate font-mono">{t.path}{t.line ? `:L${t.line}` : ''}</span>
			<button class="rounded px-1.5 py-0.5 text-[10px] hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50" disabled={busy === `thread:${t.id}`} onclick={() => resolveThread(t)}>{t.isResolved ? 'Unresolve' : 'Resolve'}</button>
			<button class="rounded px-1.5 py-0.5 text-[10px] hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => ((replyTo = t.id), (replyDraft = ''))}>Reply</button>
		</div>
		{#each t.comments.nodes as c, i (c.id ?? i)}
			<div class={[i > 0 && 'border-t border-(--vscode-widget-border)/50 bg-(--vscode-list-inactiveSelectionBackground)/20 pl-3']}>
				<div class="flex items-center gap-2 px-3 pt-2 text-[12px]"><span class="font-semibold">{c.author?.login ?? 'unknown'}</span><span class="text-[11px] {MUTED}">{sessionAgo(Date.parse(c.createdAt ?? ''), Date.now())}</span></div>
				<!-- Safe: renderMarkdown escapes raw HTML and drops images and hrefs. -->
				<div class="markdown-body px-4 py-1.5 text-[12px] leading-relaxed [overflow-wrap:anywhere]">{@html renderMarkdown(c.body ?? '')}</div>
				{@render reactions(c)}
			</div>
		{/each}
		{#if replyTo === t.id}
			<div class="border-t border-(--vscode-widget-border) p-2">
				<!-- svelte-ignore a11y_autofocus -->
				<textarea class="min-h-16 w-full resize-none rounded-md border border-(--vscode-widget-border) bg-transparent px-2 py-1.5 text-[12px] outline-none" placeholder="Reply to {t.comments.nodes[0]?.author?.login ?? 'thread'}" aria-label="Reply" autofocus bind:value={replyDraft} onkeydown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && (e.preventDefault(), void reply(t))}></textarea>
				<div class="mt-1 flex justify-end gap-1">
					<button class="h-6 rounded px-2 text-[11px] hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => (replyTo = null)}>Cancel</button>
					<button class="h-6 rounded bg-(--vscode-button-background) px-2 text-[11px] text-(--vscode-button-foreground) disabled:opacity-50" disabled={!replyDraft.trim() || busy === `reply:${t.id}`} onclick={() => reply(t)}>Reply</button>
				</div>
			</div>
		{/if}
	</div>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col overflow-auto">
	{#if !workspace.root}
		<div class="px-4 py-6"><div class="text-sm font-medium">No workspace selected</div><div class="mt-1 text-xs {MUTED}">Select a workspace to view checks</div></div>
	{:else if !loaded}
		<div class="px-4 py-6"><div class="text-sm font-medium">Checking pull request status</div><div class="mt-1 text-xs {MUTED}">Kingu is checking GitHub for a pull request on this branch.</div></div>
	{:else if error && !pr}
		<div class="px-4 py-6">
			<div class="text-sm font-medium">{ghMissing ? 'GitHub CLI unavailable' : 'Pull request status unavailable'}</div>
			<div class="mt-1 text-xs break-words {MUTED}">{ghMissing ? 'Kingu could not run GitHub CLI in this environment. Install gh (brew install gh), sign in with gh auth login, then retry.' : error}</div>
			<div class="mt-3"><button class={BTN} disabled={loading} onclick={refresh}>{loading ? 'Refreshing…' : 'Retry'}</button></div>
		</div>
	{:else if !pr}
		<div class="px-4 py-6">
			<div class="text-sm font-medium">No pull request found</div>
			<div class="mt-1 text-xs {MUTED}">Create a pull request to start checks and review.</div>
			<div class="mt-3"><button class={BTN} disabled={loading} onclick={refresh}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>
		</div>
	{:else}
		{@const state = pr.isDraft && pr.state === 'OPEN' ? 'DRAFT' : pr.state}
		<div class="space-y-2.5 border-b border-(--vscode-widget-border) px-3 py-3">
			<div class="flex items-center gap-2">
				<span class={MUTED}><Icon name="pullRequest" size={16} /></span>
				<button class="rounded px-0.5 text-[12px] font-semibold underline decoration-(--vscode-widget-border) underline-offset-2 hover:decoration-current" title="Open on GitHub" onclick={() => open(pr?.url)}>#{pr.number}</button>
				<span class={['rounded border px-1.5 py-0.5 text-[9px] font-semibold tracking-wider uppercase', STATE[state] ?? STATE.DRAFT]}>{state.toLowerCase()}</span>
				<span class="flex-1"></span>
				<button class="rounded p-1 {MUTED} hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:opacity-50" title="Refresh" aria-label="Refresh" disabled={loading} onclick={refresh}>
					<span class={['grid place-items-center', loading && 'animate-spin']}><Icon name="refresh" size={14} /></span>
				</button>
			</div>
			{#if editing}
				<div class="flex items-center gap-1">
					<!-- svelte-ignore a11y_autofocus -->
					<input class="min-w-0 flex-1 rounded border border-(--vscode-widget-border) bg-(--vscode-input-background) px-2 py-1 text-[12px] outline-none focus:border-(--vscode-focusBorder)" aria-label="Pull request title" autofocus bind:value={titleDraft} onkeydown={(e) => (e.key === 'Enter' ? void saveTitle() : e.key === 'Escape' && (editing = false))} />
					<button class="grid size-6 place-items-center rounded text-emerald-500 hover:bg-(--vscode-toolbar-hoverBackground)" title="Save" aria-label="Save" onclick={saveTitle}><Icon name="check" size={14} /></button>
					<button class="grid size-6 place-items-center rounded {MUTED} hover:bg-(--vscode-toolbar-hoverBackground)" title="Cancel" aria-label="Cancel" onclick={() => (editing = false)}><Icon name="close" size={14} /></button>
				</div>
			{:else}
				<button class="group/title -mx-1 flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left hover:bg-(--vscode-list-hoverBackground)/40" title="Edit title" onclick={() => ((titleDraft = pr?.title ?? ''), (editing = true))}>
					<span class="flex-1 text-[12px] leading-snug">{pr.title}</span>
					<span class="opacity-0 group-hover/title:opacity-40"><Icon name="replace" size={12} /></span>
				</button>
			{/if}
			<div class="flex flex-wrap items-center gap-x-2 text-[10px] {MUTED}">
				<span>{pr.headRefName} → {pr.baseRefName}</span>
				{#if pr.additions || pr.deletions}<span><span class="text-[#81b88b]">+{pr.additions}</span> <span class="text-[#c74e39]">-{pr.deletions}</span></span>{/if}
				{#if updatedAt}<span>PR updated {new Date(updatedAt).toLocaleTimeString()}</span>{/if}
			</div>

			<!-- Actions for the PR's state (Orca): merge split button, mark ready, reopen. -->
			{#if state === 'OPEN'}
				<div class="flex items-stretch">
					<button class="flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-l-md bg-green-600 px-3 text-[11px] text-white hover:bg-green-700 disabled:opacity-50" title={mergeLabel(pr, counts)} disabled={!!busy || pr.mergeable === 'CONFLICTING'} onclick={() => act('merge')}>
						{#if busy === 'merge'}<span class="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"></span>Working...{:else}<Icon name="merge" size={13} />{METHODS.find((m) => m.id === method)?.label}{/if}
					</button>
					<button class="grid h-7 w-7 place-items-center rounded-r-md border-l border-green-700/50 bg-green-600 text-white hover:bg-green-700" aria-label="More pull request actions" title="More actions" onclick={openMenu}><Icon name="chevronDown" size={13} /></button>
				</div>
				<div class="text-[11px] {MUTED}">{mergeLabel(pr, counts)}</div>
			{:else if state === 'DRAFT'}
				<div class="flex items-stretch">
					<button class="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-l-md bg-(--vscode-button-background) px-3 text-[11px] text-(--vscode-button-foreground) disabled:opacity-50" disabled={!!busy} onclick={() => act('ready')}>
						<Icon name="pullRequest" size={13} />{busy === 'ready' ? 'Marking ready...' : 'Mark ready for review'}
					</button>
					<button class="grid h-7 w-7 place-items-center rounded-r-md border-l border-white/20 bg-(--vscode-button-background) text-(--vscode-button-foreground)" aria-label="More pull request actions" onclick={openMenu}><Icon name="chevronDown" size={13} /></button>
				</div>
			{:else if state === 'CLOSED'}
				<button class={BTN} disabled={!!busy} onclick={() => act('reopen')}>{busy === 'reopen' ? 'Reopening...' : 'Reopen PR'}</button>
			{/if}
			{#if actionError}<p class="text-[10px] break-words text-rose-500" role="alert">{actionError}</p>{/if}
			{#if error}<p class="text-[10px] break-words text-rose-500" role="alert">Couldn't refresh from GitHub. Showing the last known status.</p>{/if}
		</div>

		<!-- Action strip -->
		<div class="flex min-w-0 items-center gap-2 border-b border-(--vscode-widget-border) px-3 py-2">
			{#if pr.mergeable === 'CONFLICTING'}
				<span class="text-amber-500"><Icon name="warning" size={14} /></span>
				<span class="min-w-0 flex-1"><span class="block truncate text-[11px] font-medium">Conflicts block this PR</span><span class="block truncate text-[10px] {MUTED}">Resolve conflicts before checks and merge can complete.</span></span>
			{:else if counts.failed}
				<span class="text-rose-500"><Icon name="error" size={14} /></span>
				<span class="min-w-0 flex-1"><span class="block truncate text-[11px] font-medium">{counts.failed} failing check{counts.failed === 1 ? '' : 's'}</span><span class="block truncate text-[10px] {MUTED}">Inspect details or start an AI fix pass.</span></span>
				<button class={BTN} disabled={!slug || !!busy} title={slug ? "Send the failing checks and their logs to this task's agent" : 'Open a task worktree to fix checks with its agent.'} onclick={fix}>{busy === 'fix' ? 'Starting…' : 'Fix'}</button>
			{:else if counts.pending}
				<span class="animate-spin text-amber-500"><Icon name="circleDashed" size={14} /></span>
				<span class="min-w-0 flex-1"><span class="block truncate text-[11px] font-medium">{counts.pending} check{counts.pending === 1 ? '' : 's'} pending</span><span class="block truncate text-[10px] {MUTED}">Kingu will refresh checks while this panel stays open.</span></span>
			{:else}
				<span class="text-emerald-500"><Icon name="checkCircle" size={14} /></span>
				<span class="min-w-0 flex-1"><span class="block truncate text-[11px] font-medium">No blocking PR action</span><span class="block truncate text-[10px] {MUTED}">Checks and comments below show the current fetched context.</span></span>
			{/if}
		</div>

		{#if pr.mergeable === 'CONFLICTING'}
			<div class="border-b border-(--vscode-widget-border) px-3 py-3 text-[11px]">
				<div class="font-medium">This branch has conflicts that must be resolved</div>
				<div class="mt-1 {MUTED}">Update the branch from its base, resolve the conflicts, then push.</div>
			</div>
		{/if}

		{#if checks.length}
			<button class="flex w-full items-center gap-3 border-b border-(--vscode-widget-border) px-3 py-2 text-left text-[10px] {MUTED} hover:bg-(--vscode-list-hoverBackground)" aria-expanded={listOpen} onclick={() => (listOpen = !listOpen)}>
				<span class={['transition-transform', !listOpen && '-rotate-90']}><Icon name="chevronDown" size={12} /></span>
				{#if counts.passed}<span class="flex items-center gap-1"><span class="text-emerald-500"><Icon name="checkCircle" size={12} /></span>{counts.passed} passing</span>{/if}
				{#if counts.failed}<span class="flex items-center gap-1"><span class="text-rose-500"><Icon name="error" size={12} /></span>{counts.failed} failing</span>{/if}
				{#if counts.pending}<span class="flex items-center gap-1"><span class="text-amber-500"><Icon name="circleDashed" size={12} /></span>{counts.pending} pending</span>{/if}
				{#if counts.neutral}<span class="flex items-center gap-1"><Icon name="circleDashed" size={12} />{counts.neutral} unresolved</span>{/if}
			</button>
			{#if listOpen}
				<div class={expanded ? '' : 'max-h-[260px] overflow-y-auto'}>
					{#each checks as c, i (`${c.name ?? c.context}:${i}`)}
						{@const kind = checkKind(c)}
						{@const ic = ICON[kind]}
						{@const key = `${c.name ?? c.context}:${i}`}
						<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
						<div class={['group flex min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-(--vscode-list-hoverBackground)', expanded === key && 'bg-(--vscode-list-hoverBackground)/60']} onclick={() => toggleCheck(key, c)}>
							<span class={['transition-transform', expanded === key && 'rotate-90']}><Icon name="chevronRight" size={12} /></span>
							<span class={[ic.cls, ic.spin && 'animate-spin']}><Icon name={ic.name} size={14} /></span>
							<span class="min-w-0 flex-1 truncate text-[12px]" title={c.name ?? c.context}>{c.name ?? c.context}</span>
							<span class="shrink-0 text-[11px] {MUTED}">{checkLabel(c)}</span>
							{#if c.detailsUrl ?? c.targetUrl}
								<button class="grid size-6 place-items-center rounded opacity-0 group-hover:opacity-100 hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="Open check details" title="Open check details" onclick={(e) => (e.stopPropagation(), open(c.detailsUrl ?? c.targetUrl))}><Icon name="openExternal" size={12} /></button>
							{/if}
						</div>
						{#if expanded === key}
							<div class="mr-3 mb-1 ml-[26px] min-w-0 border-l border-(--vscode-widget-border) pl-3 text-[11px]">
								<div class="py-1 {MUTED}">Status: {checkLabel(c)}</div>
								{#if kind === 'success'}
									<p class={MUTED}>No inline details are available for this check.</p>
								{:else if logs[key] === ''}
									<p class={MUTED}>Loading check details…</p>
								{:else if logs[key]}
									<div class="mt-1 text-[10px] font-semibold uppercase">Log excerpt</div>
									<pre class="mt-1 max-h-72 overflow-auto rounded bg-(--vscode-list-inactiveSelectionBackground)/40 p-3 font-mono text-xs whitespace-pre-wrap {MUTED}">{logs[key]}</pre>
								{/if}
							</div>
						{/if}
					{/each}
				</div>
			{/if}
		{:else}
			<p class="px-4 py-8 text-[11px] {MUTED}">No checks configured</p>
		{/if}

		<!-- Comments -->
		<div class="border-t border-(--vscode-widget-border)">
			<div class="sticky top-0 z-10 flex flex-col gap-2.5 border-b border-(--vscode-widget-border) bg-(--vscode-sideBar-background)/95 px-3 py-2.5 backdrop-blur-sm">
				<div class="flex items-center gap-1.5">
					<span class={MUTED}><Icon name="question" size={14} /></span>
					<span class="text-[11px] font-semibold tracking-wider uppercase {MUTED}">Comments</span>
					<span class="rounded-full border border-(--vscode-widget-border) bg-(--vscode-list-inactiveSelectionBackground) px-1.5 py-px text-[10px] font-semibold tabular-nums">{comments.length + threads.length}</span>
					<span class="flex-1"></span>
					<button class="grid size-6 place-items-center rounded {MUTED} hover:bg-(--vscode-toolbar-hoverBackground)" title={comments.length ? 'Add comment' : 'Start conversation'} aria-label="Add comment" onclick={() => (composing = true)}><Icon name="plus" size={13} /></button>
				</div>
				{#if comments.length}
					<div class="grid grid-cols-3 rounded-md border border-(--vscode-widget-border) bg-(--vscode-editor-background) p-0.5" role="radiogroup" aria-label="Comment authors">
						{#each [['all', 'All'], ['humans', 'Humans'], ['bots', 'Bots']] as const as [id, label] (id)}
							<button role="radio" aria-checked={audience === id} class={['flex h-7 items-center justify-center gap-1 rounded-md text-[11px] font-medium', audience === id ? 'bg-(--vscode-list-inactiveSelectionBackground) text-(--vscode-foreground) shadow-xs' : MUTED]} onclick={() => (audience = id)}>{label} {countFor(id)}</button>
						{/each}
					</div>
				{/if}
			</div>
			<div class="flex flex-col gap-2 px-3 py-2">
				{#if open_.length}
					<div class="pt-1 text-[11px] font-semibold tracking-wider uppercase {MUTED}">Needs review · {open_.length}</div>
					{#each open_ as t (t.id)}{@render thread(t)}{/each}
				{/if}
				{#if resolved.length}
					<button class="flex items-center gap-1 py-1 text-left text-[11px] font-semibold tracking-wider uppercase {MUTED}" aria-expanded={showResolved} onclick={() => (showResolved = !showResolved)}>
						<span class={['transition-transform', !showResolved && '-rotate-90']}><Icon name="chevronDown" size={12} /></span>Resolved · {resolved.length}
					</button>
					{#if showResolved}{#each resolved as t (t.id)}<div class="opacity-70">{@render thread(t)}</div>{/each}{/if}
				{/if}
				{#each shown as c, i (i)}
					<div class="overflow-clip rounded-lg border border-(--vscode-widget-border) bg-(--vscode-editor-background)">
						<div class="flex items-center gap-2 border-b border-(--vscode-widget-border)/60 px-3 py-2">
							<span class="grid size-5 place-items-center rounded-full border border-(--vscode-widget-border) text-[10px] font-semibold uppercase">{c.author?.login?.[0] ?? '?'}</span>
							<span class="min-w-0 flex-1 truncate text-[13px] font-semibold">{c.author?.login ?? 'unknown'}</span>
							{#if isBot(c)}<span class="rounded border border-(--vscode-widget-border) px-1 text-[10px] {MUTED}">bot</span>{/if}
							{#if c.state && c.state !== 'COMMENTED'}<span class="rounded border border-(--vscode-widget-border) px-1 text-[10px] font-semibold uppercase {MUTED}">{c.state.replace('_', ' ').toLowerCase()}</span>{/if}
							<span class="shrink-0 text-[11px] {MUTED}">{sessionAgo(Date.parse(c.createdAt ?? c.submittedAt ?? ''), Date.now())}</span>
						</div>
						<!-- Safe: renderMarkdown escapes raw HTML and drops images and hrefs. -->
						<div class="markdown-body px-4 py-2.5 text-[13px] leading-relaxed [overflow-wrap:anywhere]">{@html renderMarkdown(c.body ?? '')}</div>
						{@render reactions(c)}
					</div>
				{:else}
					{#if !composing}<p class="py-5 text-center text-[11px] {MUTED}">{audience === 'bots' ? 'No bot comments.' : audience === 'humans' ? 'No human comments.' : 'No comments yet.'}</p>{/if}
				{/each}
				{#if composing}
					<div class="rounded-md border border-(--vscode-widget-border) bg-(--vscode-editor-background)">
						<!-- svelte-ignore a11y_autofocus -->
						<textarea
							class="max-h-44 min-h-20 w-full resize-none bg-transparent px-2.5 py-2 text-[12px] leading-relaxed outline-none placeholder:text-(--vscode-input-placeholderForeground)"
							placeholder={comments.length ? 'Add a PR comment' : 'Start conversation...'}
							aria-label="Comment"
							autofocus
							bind:value={draft}
							onkeydown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && (e.preventDefault(), void send())}
						></textarea>
						<div class="flex justify-end gap-1 border-t border-(--vscode-widget-border) px-2 py-1.5">
							<button class="h-6 rounded px-2 text-[11px] hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => ((composing = false), (draft = ''))}>Cancel</button>
							<button class="h-6 rounded bg-(--vscode-button-background) px-2 text-[11px] text-(--vscode-button-foreground) disabled:opacity-50" title="Send (⌘↵)" disabled={!draft.trim() || busy === 'comment'} onclick={send}>{busy === 'comment' ? 'Sending...' : 'Send'}</button>
						</div>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

{#if actionMenu}
	<PopupMenu items={actionItems} label="Pull request actions" x={actionMenu.x} y={actionMenu.y} onRun={(n) => n.type === 'item' && runAction(n.id)} onClose={() => (actionMenu = null)} />
{/if}
