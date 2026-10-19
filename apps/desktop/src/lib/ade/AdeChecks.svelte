<script lang="ts">
	import { untrack } from 'svelte';
	import { prStatuses } from './prStatus.svelte.ts';
	// Orca's Checks tab for the selected worktree's branch: its pull request (number, state, an
	// editable title, merge state and the actions for that state: merge with a method, mark ready,
	// close, reopen), an action strip (Fix failing checks with the task's agent), the CI checks
	// failures first with the failed log excerpt, then the comments with a composer. Polls every
	// 60 seconds while shown (doubling to 120 when nothing changes), and on window focus. On a
	// GitLab folder the same `forge_*` commands act on the merge request (reactions stay GitHub's).
	import { invoke } from '@tauri-apps/api/core';
	import { isRustError } from '#lib/i18n/rustErrors.ts';
	import { t as tr } from '#lib/i18n/index.ts';
	import { forgeFor, ft } from './forge.ts';
	import Icon from '#lib/workbench/Icon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { ask } from '#lib/workbench/messageBox.ts';
	import { renderMarkdown } from '#lib/workbench/markdown.ts';
	import { adeTasks } from './tasks.svelte';
	import { checkKind, checkLabel, checkRank, mergeLabel, reactionPills, REACTIONS, summarize, type Check, type Pr, type PrComment, type ReviewThread } from './checks';
	import { sessionAgo } from './agentsPanel';
	import { methodLabel, type MergeMethod } from './prChecks.ts';

	let { slug }: { slug: string } = $props();

	// The PR comes from the store every view of this worktree shares (one `gh` read, one poll).
	const entry = $derived(prStatuses.bySlug[slug]);
	const pr = $derived(entry?.raw ?? null);
	const loaded = $derived(!!entry && (entry.at > 0 || !entry.loading));
	const loading = $derived(!!entry?.loading);
	const error = $derived(entry?.error ?? '');
	const updatedAt = $derived(entry?.at || null);
	const forge = $derived(forgeFor(pr?.url, adeTasks.gh));
	let listOpen = $state(true);
	let busy = $state<string | null>(null);
	let actionError = $state('');

	const refresh = () => prStatuses.refresh(slug);
	$effect(() => {
		const s = slug;
		return untrack(() => prStatuses.watch(s));
	});
	// Comments and review threads follow each fresh read of an open PR.
	$effect(() => {
		if (!entry?.at || !entry.raw) return;
		untrack(() => void (loadComments(), loadThreads()));
	});

	/** The backend's "gh is not installed" error. */
	const ghMissing = $derived(isRustError(error, 'ghMissing'));
	const checks = $derived([...(pr?.statusCheckRollup ?? [])].sort((a, b) => checkRank(a) - checkRank(b)));
	const counts = $derived(summarize(checks));
	const failing = $derived(checks.filter((c) => ['failure', 'cancelled'].includes(checkKind(c))));
	const open = (url: string | undefined) => url && invoke('open_web_url', { url }).catch((e) => status.error(String(e)));

	// --- PR actions ---------------------------------------------------------------------------
	const METHODS: MergeMethod[] = ['squash', 'merge', 'rebase'];
	let method = $state<MergeMethod>('squash');
	let deleteBranch = $state(false);
	let actionMenu = $state<{ x: number; y: number } | null>(null);
	async function act(action: 'merge' | 'close' | 'reopen' | 'ready' | 'auto' | 'disableAuto') {
		if (!pr) return;
		if (action === 'close' || action === 'reopen') {
			const close = action === 'close';
			const ok = await ask(close ? ft('forge.checks.closeAsk', forge) : ft('forge.checks.reopenAsk', forge), {
				title: close ? ft('forge.checks.closeTitle', forge, { number: pr.number }) : ft('forge.checks.reopenTitle', forge, { number: pr.number }),
				kind: 'warning',
				okLabel: close ? tr('forge.checks.closeOk') : tr('forge.checks.reopenOk'),
				cancelLabel: tr('forge.checks.cancel')
			});
			if (!ok) return;
		}
		if (action === 'merge') {
			// The task's merge (adeTasks.mergePr): it confirms, can delete the branch, and marks the task done.
			busy = action;
			actionError = '';
			try {
				await adeTasks.mergePr(slug, method, deleteBranch);
			} finally {
				busy = null;
				await refresh();
			}
			return;
		}
		busy = action;
		actionError = '';
		try {
			await invoke('forge_pr_action', { slug: slug || null, number: pr.number, action, method });
			const done = {
				ready: ft('forge.checks.flash.ready', forge),
				close: ft('forge.checks.flash.closed', forge),
				reopen: ft('forge.checks.flash.reopened', forge),
				auto: tr('forge.checks.flash.autoOn'),
				disableAuto: tr('forge.checks.flash.autoOff')
			};
			status.flash(done[action], 4000);
		} catch (e) {
			actionError = String(e);
		} finally {
			busy = null;
			await refresh();
		}
	}
	const actionItems = $derived.by((): MenuNode[] => {
		if (!pr) return [];
		if (pr.isDraft) return [menuItem('close', ft('forge.checks.close', forge))];
		return [
			pr.autoMergeRequest ? menuItem('disableAuto', tr('forge.checks.disableAuto')) : menuItem('auto', tr('forge.checks.enableAuto')),
			menuSeparator,
			...METHODS.map((m) => menuItem(`m:${m}`, methodLabel(m), { checked: method === m })),
			menuItem('deleteBranch', tr('forge.checks.deleteBranchAfter'), { checked: deleteBranch }),
			menuSeparator,
			menuItem('close', ft('forge.checks.close', forge))
		];
	});
	function runAction(id: string) {
		if (id === 'close' || id === 'auto' || id === 'disableAuto') void act(id);
		else if (id.startsWith('m:')) method = id.slice(2) as MergeMethod;
		else if (id === 'deleteBranch') deleteBranch = !deleteBranch;
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
			await invoke('forge_pr_edit_title', { slug: slug || null, number: pr.number, title: t });
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
			logs[key] = (await invoke<string>('forge_check_log', { slug: slug || null, url })) || tr('forge.checks.noDetails');
		} catch (e) {
			logs[key] = String(e).replace(/^gh run: /, '');
		}
	}

	// --- Fix with the task's agent ------------------------------------------------------------
	async function fix() {
		if (!pr || !slug || !failing.length) return;
		busy = 'fix';
		actionError = '';
		try {
			// adeTasks.fixChecks: the failed jobs' log tails in Orca's prompt, sent to the task's agent.
			await adeTasks.fixChecks(slug);
		} catch (e) {
			actionError = String(e);
		}
		busy = null;
	}

	// --- Comments -----------------------------------------------------------------------------
	let comments = $state<PrComment[]>([]);
	let commentsError = $state('');
	let audience = $state<'all' | 'humans' | 'bots'>('all');
	let draft = $state('');
	let composing = $state(false);
	async function loadComments() {
		try {
			const r = await invoke<{ comments: PrComment[]; reviews: PrComment[] }>('forge_pr_comments', { slug: slug || null, number: pr?.number ?? null });
			comments = [...(r.comments ?? []), ...(r.reviews ?? []).filter((x) => x.body?.trim())].sort((a, b) => Date.parse(a.createdAt ?? a.submittedAt ?? '') - Date.parse(b.createdAt ?? b.submittedAt ?? ''));
			commentsError = '';
		} catch (e) {
			// Checks still show without comments; say why the comments are missing.
			commentsError = String(e);
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
			await invoke('forge_pr_comment', { slug: slug || null, number: pr?.number ?? null, body });
			draft = '';
			composing = false;
			await loadComments();
		} catch (e) {
			actionError = body.length > 60_000 ? tr('forge.checks.tooLarge') : `${tr('forge.checks.postFailed')} ${String(e)}`;
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
			threads = await invoke<ReviewThread[]>('forge_review_threads', { slug: slug || null, number: pr.number });
		} catch {
			threads = [];
		}
	}
	const open_ = $derived(threads.filter((t) => !t.isResolved));
	const resolved = $derived(threads.filter((t) => t.isResolved));
	async function resolveThread(t: ReviewThread) {
		busy = `thread:${t.id}`;
		try {
			await adeTasks.resolveThread(slug, t.id, !t.isResolved);
			await loadThreads();
		} catch {
			actionError = ft('forge.checks.threadFailed', forge);
		}
		busy = null;
	}
	async function reply(t: ReviewThread) {
		const body = replyDraft.trim();
		if (!body) return;
		busy = `reply:${t.id}`;
		try {
			await invoke('forge_reply_thread', { slug: slug || null, number: pr?.number ?? null, thread: t.id, body });
			replyDraft = '';
			replyTo = null;
			await loadThreads();
		} catch (e) {
			actionError = `${tr('forge.checks.postFailed')} ${String(e)}`;
		}
		busy = null;
	}
	let picker = $state<string | null>(null);
	async function react(c: PrComment, content: string, remove = false) {
		picker = null;
		if (!c.id) return;
		try {
			await invoke('forge_react', { slug: slug || null, subject: c.id, content, remove });
			await Promise.all([loadComments(), loadThreads()]);
		} catch {
			status.error(tr('forge.checks.reactionFailed'));
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
	<!-- GitLab's award emoji are not wired up yet: its comments show no reaction bar. -->
	{#if forge !== 'gitlab'}
	<div class="flex flex-wrap items-center gap-1 px-4 pb-2">
		{#each reactionPills(c) as r (r.content)}
			<button class={['h-6 rounded-full border px-2 text-[12px]', r.mine ? 'border-(--vscode-focusBorder) bg-(--vscode-list-inactiveSelectionBackground)' : 'border-(--vscode-widget-border)']} onclick={() => react(c, r.content, r.mine)}>{r.emoji} {r.count}</button>
		{/each}
		<span class="relative">
			<button class="grid h-6 w-7 place-items-center rounded-full border border-(--vscode-widget-border) text-[12px] opacity-60 hover:opacity-100" aria-label={tr('forge.checks.addReaction')} title={tr('forge.checks.addReaction')} onclick={() => (picker = picker === c.id ? null : (c.id ?? null))}>☺+</button>
			{#if picker && picker === c.id}
				<span class="absolute bottom-7 left-0 z-20 grid grid-cols-4 gap-1 rounded-md border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) p-1 shadow-lg">
					{#each REACTIONS as r (r.content)}<button class="grid size-7 place-items-center rounded hover:bg-(--vscode-list-hoverBackground)" aria-label={r.content} onclick={() => react(c, r.content)}>{r.emoji}</button>{/each}
				</span>
			{/if}
		</span>
	</div>
	{/if}
{/snippet}

{#snippet thread(t: ReviewThread)}
	<div class="overflow-clip rounded-lg border border-(--vscode-widget-border) bg-(--vscode-editor-background)">
		<div class="flex items-center gap-2 border-b border-(--vscode-widget-border)/60 px-3 py-1.5 text-[11px] {MUTED}">
			<span class="min-w-0 flex-1 truncate font-mono">{t.path}{t.line ? `:L${t.line}` : ''}</span>
			<button class="rounded px-1.5 py-0.5 text-[10px] hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50" disabled={busy === `thread:${t.id}`} onclick={() => resolveThread(t)}>{t.isResolved ? tr('forge.checks.unresolve') : tr('forge.checks.resolve')}</button>
			<button class="rounded px-1.5 py-0.5 text-[10px] hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => ((replyTo = t.id), (replyDraft = ''))}>{tr('forge.checks.reply')}</button>
		</div>
		{#each t.comments.nodes as c, i (c.id ?? i)}
			<div class={[i > 0 && 'border-t border-(--vscode-widget-border)/50 bg-(--vscode-list-inactiveSelectionBackground)/20 pl-3']}>
				<div class="flex items-center gap-2 px-3 pt-2 text-[12px]"><span class="font-semibold">{c.author?.login ?? tr('forge.checks.unknownAuthor')}</span><span class="text-[11px] {MUTED}">{sessionAgo(Date.parse(c.createdAt ?? ''), Date.now())}</span></div>
				<!-- Safe: renderMarkdown escapes raw HTML and drops images and hrefs. -->
				<div class="markdown-body px-4 py-1.5 text-[12px] leading-relaxed [overflow-wrap:anywhere]">{@html renderMarkdown(c.body ?? '')}</div>
				{@render reactions(c)}
			</div>
		{/each}
		{#if replyTo === t.id}
			<div class="border-t border-(--vscode-widget-border) p-2">
				<!-- svelte-ignore a11y_autofocus -->
				<textarea class="min-h-16 w-full resize-none rounded-md border border-(--vscode-widget-border) bg-transparent px-2 py-1.5 text-[12px] outline-none" placeholder={tr('forge.checks.replyTo', { name: t.comments.nodes[0]?.author?.login ?? tr('forge.checks.replyThread') })} aria-label={tr('forge.checks.reply')} autofocus bind:value={replyDraft} onkeydown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && (e.preventDefault(), void reply(t))}></textarea>
				<div class="mt-1 flex justify-end gap-1">
					<button class="h-6 rounded px-2 text-[11px] hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => (replyTo = null)}>{tr('forge.checks.cancel')}</button>
					<button class="h-6 rounded bg-(--vscode-button-background) px-2 text-[11px] text-(--vscode-button-foreground) disabled:opacity-50" disabled={!replyDraft.trim() || busy === `reply:${t.id}`} onclick={() => reply(t)}>{tr('forge.checks.reply')}</button>
				</div>
			</div>
		{/if}
	</div>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col overflow-auto">
	{#if !workspace.root}
		<div class="px-4 py-6"><div class="text-sm font-medium">{tr('forge.checks.noWorkspace')}</div><div class="mt-1 text-xs {MUTED}">{tr('forge.checks.noWorkspaceHint')}</div></div>
	{:else if !loaded}
		<div class="px-4 py-6"><div class="text-sm font-medium">{ft('forge.checks.checking', forge)}</div><div class="mt-1 text-xs {MUTED}">{ft('forge.checks.checkingHint', forge)}</div></div>
	{:else if error && !pr}
		<div class="px-4 py-6">
			<div class="text-sm font-medium">{ghMissing ? tr('forge.checks.ghUnavailable') : ft('forge.checks.unavailable', forge)}</div>
			<div class="mt-1 text-xs break-words {MUTED}">{ghMissing ? tr('forge.checks.ghUnavailableHint') : error}</div>
			<div class="mt-3"><button class={BTN} disabled={loading} onclick={refresh}>{loading ? tr('forge.checks.refreshing') : tr('forge.checks.retry')}</button></div>
		</div>
	{:else if !pr}
		<div class="px-4 py-6">
			<div class="text-sm font-medium">{ft('forge.checks.noneTitle', forge)}</div>
			<div class="mt-1 text-xs {MUTED}">{ft('forge.checks.noneHint', forge)}</div>
			<div class="mt-3"><button class={BTN} disabled={loading} onclick={refresh}>{loading ? tr('forge.checks.refreshing') : tr('forge.checks.refresh')}</button></div>
		</div>
	{:else}
		{@const state = pr.isDraft && pr.state === 'OPEN' ? 'DRAFT' : pr.state}
		<div class="space-y-2.5 border-b border-(--vscode-widget-border) px-3 py-3">
			<div class="flex items-center gap-2">
				<span class={MUTED}><Icon name="pullRequest" size={16} /></span>
				<button class="rounded px-0.5 text-[12px] font-semibold underline decoration-(--vscode-widget-border) underline-offset-2 hover:decoration-current" title={ft('forge.openOnHost', forge)} onclick={() => open(pr?.url)}>{ft('forge.ref', forge, { number: pr.number })}</button>
				<span class={['rounded border px-1.5 py-0.5 text-[9px] font-semibold tracking-wider uppercase', STATE[state] ?? STATE.DRAFT]}>{state.toLowerCase()}</span>
				<span class="flex-1"></span>
				<button class="rounded p-1 {MUTED} hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:opacity-50" title={tr('forge.checks.refresh')} aria-label={tr('forge.checks.refresh')} disabled={loading} onclick={refresh}>
					<span class={['grid place-items-center', loading && 'animate-spin']}><Icon name="refresh" size={14} /></span>
				</button>
			</div>
			{#if editing}
				<div class="flex items-center gap-1">
					<!-- svelte-ignore a11y_autofocus -->
					<input class="min-w-0 flex-1 rounded border border-(--vscode-widget-border) bg-(--vscode-input-background) px-2 py-1 text-[12px] outline-none focus:border-(--vscode-focusBorder)" aria-label={ft('forge.create.titleLabel', forge)} autofocus bind:value={titleDraft} onkeydown={(e) => (e.key === 'Enter' ? void saveTitle() : e.key === 'Escape' && (editing = false))} />
					<button class="grid size-6 place-items-center rounded text-emerald-500 hover:bg-(--vscode-toolbar-hoverBackground)" title={tr('forge.checks.save')} aria-label={tr('forge.checks.save')} onclick={saveTitle}><Icon name="check" size={14} /></button>
					<button class="grid size-6 place-items-center rounded {MUTED} hover:bg-(--vscode-toolbar-hoverBackground)" title={tr('forge.checks.cancel')} aria-label={tr('forge.checks.cancel')} onclick={() => (editing = false)}><Icon name="close" size={14} /></button>
				</div>
			{:else}
				<button class="group/title -mx-1 flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left hover:bg-(--vscode-list-hoverBackground)/40" title={tr('forge.checks.editTitle')} onclick={() => ((titleDraft = pr?.title ?? ''), (editing = true))}>
					<span class="flex-1 text-[12px] leading-snug">{pr.title}</span>
					<span class="opacity-0 group-hover/title:opacity-40"><Icon name="replace" size={12} /></span>
				</button>
			{/if}
			<div class="flex flex-wrap items-center gap-x-2 text-[10px] {MUTED}">
				<span>{pr.headRefName} → {pr.baseRefName}</span>
				{#if pr.additions || pr.deletions}<span><span class="text-[#81b88b]">+{pr.additions}</span> <span class="text-[#c74e39]">-{pr.deletions}</span></span>{/if}
				{#if updatedAt}<span>{ft('forge.checks.updated', forge, { time: new Date(updatedAt).toLocaleTimeString() })}</span>{/if}
			</div>

			<!-- Actions for the PR's state (Orca): merge split button, mark ready, reopen. -->
			{#if state === 'OPEN'}
				<div class="flex items-stretch">
					<button class="flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-l-md bg-green-600 px-3 text-[11px] text-white hover:bg-green-700 disabled:opacity-50" title={mergeLabel(pr, counts)} disabled={!!busy || pr.mergeable === 'CONFLICTING'} onclick={() => act('merge')}>
						{#if busy === 'merge'}<span class="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"></span>{tr('forge.checks.working')}{:else}<Icon name="merge" size={13} />{methodLabel(method)}{/if}
					</button>
					<button class="grid h-7 w-7 place-items-center rounded-r-md border-l border-green-700/50 bg-green-600 text-white hover:bg-green-700" aria-label={ft('forge.checks.moreActions', forge)} title={tr('forge.checks.moreActionsTip')} onclick={openMenu}><Icon name="chevronDown" size={13} /></button>
				</div>
				<div class="text-[11px] {MUTED}">{mergeLabel(pr, counts)}</div>
			{:else if state === 'DRAFT'}
				<div class="flex items-stretch">
					<button class="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-l-md bg-(--vscode-button-background) px-3 text-[11px] text-(--vscode-button-foreground) disabled:opacity-50" disabled={!!busy} onclick={() => act('ready')}>
						<Icon name="pullRequest" size={13} />{busy === 'ready' ? tr('forge.checks.markingReady') : tr('forge.checks.markReady')}
					</button>
					<button class="grid h-7 w-7 place-items-center rounded-r-md border-l border-white/20 bg-(--vscode-button-background) text-(--vscode-button-foreground)" aria-label={ft('forge.checks.moreActions', forge)} onclick={openMenu}><Icon name="chevronDown" size={13} /></button>
				</div>
			{:else if state === 'CLOSED'}
				<button class={BTN} disabled={!!busy} onclick={() => act('reopen')}>{busy === 'reopen' ? tr('forge.checks.reopening') : ft('forge.checks.reopen', forge)}</button>
			{/if}
			{#if actionError}<p class="text-[10px] break-words text-rose-500" role="alert">{actionError}</p>{/if}
			{#if error}<p class="text-[10px] break-words text-rose-500" role="alert">{ft('forge.checks.refreshFailed', forge)}</p>{/if}
		</div>

		<!-- Action strip -->
		<div class="flex min-w-0 items-center gap-2 border-b border-(--vscode-widget-border) px-3 py-2">
			{#if pr.mergeable === 'CONFLICTING'}
				<span class="text-amber-500"><Icon name="warning" size={14} /></span>
				<span class="min-w-0 flex-1"><span class="block truncate text-[11px] font-medium">{ft('forge.checks.conflictsBlock', forge)}</span><span class="block truncate text-[10px] {MUTED}">{tr('forge.checks.conflictsBlockHint')}</span></span>
			{:else if counts.failed}
				<span class="text-rose-500"><Icon name="error" size={14} /></span>
				<span class="min-w-0 flex-1"><span class="block truncate text-[11px] font-medium">{tr('forge.checks.failing', { count: counts.failed })}</span><span class="block truncate text-[10px] {MUTED}">{tr('forge.checks.failingHint')}</span></span>
				<button class={BTN} disabled={!slug || !!busy} title={slug ? tr('forge.checks.fixTip') : tr('forge.checks.fixNeedsTask')} onclick={fix}>{busy === 'fix' ? tr('forge.checks.starting') : tr('forge.checks.fix')}</button>
			{:else if counts.pending}
				<span class="animate-spin text-amber-500"><Icon name="circleDashed" size={14} /></span>
				<span class="min-w-0 flex-1"><span class="block truncate text-[11px] font-medium">{tr('forge.checks.pending', { count: counts.pending })}</span><span class="block truncate text-[10px] {MUTED}">{tr('forge.checks.pendingHint')}</span></span>
			{:else}
				<span class="text-emerald-500"><Icon name="checkCircle" size={14} /></span>
				<span class="min-w-0 flex-1"><span class="block truncate text-[11px] font-medium">{ft('forge.checks.noBlocking', forge)}</span><span class="block truncate text-[10px] {MUTED}">{tr('forge.checks.noBlockingHint')}</span></span>
			{/if}
		</div>

		{#if pr.mergeable === 'CONFLICTING'}
			<div class="border-b border-(--vscode-widget-border) px-3 py-3 text-[11px]">
				<div class="font-medium">{tr('forge.checks.conflictsTitle')}</div>
				<div class="mt-1 {MUTED}">{tr('forge.checks.conflictsHint')}</div>
			</div>
		{/if}

		{#if checks.length}
			<button class="flex w-full items-center gap-3 border-b border-(--vscode-widget-border) px-3 py-2 text-left text-[10px] {MUTED} hover:bg-(--vscode-list-hoverBackground)" aria-expanded={listOpen} onclick={() => (listOpen = !listOpen)}>
				<span class={['transition-transform', !listOpen && '-rotate-90']}><Icon name="chevronDown" size={12} /></span>
				{#if counts.passed}<span class="flex items-center gap-1"><span class="text-emerald-500"><Icon name="checkCircle" size={12} /></span>{tr('forge.checks.passing', { count: counts.passed })}</span>{/if}
				{#if counts.failed}<span class="flex items-center gap-1"><span class="text-rose-500"><Icon name="error" size={12} /></span>{tr('forge.checks.failingCount', { count: counts.failed })}</span>{/if}
				{#if counts.pending}<span class="flex items-center gap-1"><span class="text-amber-500"><Icon name="circleDashed" size={12} /></span>{tr('forge.checks.pendingCount', { count: counts.pending })}</span>{/if}
				{#if counts.neutral}<span class="flex items-center gap-1"><Icon name="circleDashed" size={12} />{tr('forge.checks.unresolvedCount', { count: counts.neutral })}</span>{/if}
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
								<button class="grid size-6 place-items-center rounded opacity-0 group-hover:opacity-100 hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={tr('forge.checks.openDetails')} title={tr('forge.checks.openDetails')} onclick={(e) => (e.stopPropagation(), open(c.detailsUrl ?? c.targetUrl))}><Icon name="openExternal" size={12} /></button>
							{/if}
						</div>
						{#if expanded === key}
							<div class="mr-3 mb-1 ml-[26px] min-w-0 border-l border-(--vscode-widget-border) pl-3 text-[11px]">
								<div class="py-1 {MUTED}">{tr('forge.checks.statusLine', { status: checkLabel(c) })}</div>
								{#if kind === 'success'}
									<p class={MUTED}>{tr('forge.checks.noDetails')}</p>
								{:else if logs[key] === ''}
									<p class={MUTED}>{tr('forge.checks.loadingDetails')}</p>
								{:else if logs[key]}
									<div class="mt-1 text-[10px] font-semibold uppercase">{tr('forge.checks.logExcerpt')}</div>
									<pre class="mt-1 max-h-72 overflow-auto rounded bg-(--vscode-list-inactiveSelectionBackground)/40 p-3 font-mono text-xs whitespace-pre-wrap {MUTED}">{logs[key]}</pre>
								{/if}
							</div>
						{/if}
					{/each}
				</div>
			{/if}
		{:else}
			<p class="px-4 py-8 text-[11px] {MUTED}">{tr('forge.checks.noChecks')}</p>
		{/if}

		<!-- Comments -->
		<div class="border-t border-(--vscode-widget-border)">
			<div class="sticky top-0 z-10 flex flex-col gap-2.5 border-b border-(--vscode-widget-border) bg-(--vscode-sideBar-background)/95 px-3 py-2.5 backdrop-blur-sm">
				<div class="flex items-center gap-1.5">
					<span class={MUTED}><Icon name="question" size={14} /></span>
					<span class="text-[11px] font-semibold tracking-wider uppercase {MUTED}">{tr('forge.checks.comments')}</span>
					<span class="rounded-full border border-(--vscode-widget-border) bg-(--vscode-list-inactiveSelectionBackground) px-1.5 py-px text-[10px] font-semibold tabular-nums">{comments.length + threads.length}</span>
					<span class="flex-1"></span>
					<button class="grid size-6 place-items-center rounded {MUTED} hover:bg-(--vscode-toolbar-hoverBackground)" title={comments.length ? tr('forge.checks.addComment') : tr('forge.checks.startConversation')} aria-label={tr('forge.checks.addComment')} onclick={() => (composing = true)}><Icon name="plus" size={13} /></button>
				</div>
				{#if comments.length}
					<div class="grid grid-cols-3 rounded-md border border-(--vscode-widget-border) bg-(--vscode-editor-background) p-0.5" role="radiogroup" aria-label={tr('forge.checks.commentAuthors')}>
						{#each [['all', tr('forge.checks.all')], ['humans', tr('forge.checks.humans')], ['bots', tr('forge.checks.bots')]] as const as [id, label] (id)}
							<button role="radio" aria-checked={audience === id} class={['flex h-7 items-center justify-center gap-1 rounded-md text-[11px] font-medium', audience === id ? 'bg-(--vscode-list-inactiveSelectionBackground) text-(--vscode-foreground) shadow-xs' : MUTED]} onclick={() => (audience = id)}>{label} {countFor(id)}</button>
						{/each}
					</div>
				{/if}
			</div>
			<div class="flex flex-col gap-2 px-3 py-2">
				{#if open_.length}
					<div class="pt-1 text-[11px] font-semibold tracking-wider uppercase {MUTED}">{tr('forge.checks.needsReview', { count: open_.length })}</div>
					{#each open_ as t (t.id)}{@render thread(t)}{/each}
				{/if}
				{#if resolved.length}
					<button class="flex items-center gap-1 py-1 text-left text-[11px] font-semibold tracking-wider uppercase {MUTED}" aria-expanded={showResolved} onclick={() => (showResolved = !showResolved)}>
						<span class={['transition-transform', !showResolved && '-rotate-90']}><Icon name="chevronDown" size={12} /></span>{tr('forge.checks.resolved', { count: resolved.length })}
					</button>
					{#if showResolved}{#each resolved as t (t.id)}<div class="opacity-70">{@render thread(t)}</div>{/each}{/if}
				{/if}
				{#each shown as c, i (i)}
					<div class="overflow-clip rounded-lg border border-(--vscode-widget-border) bg-(--vscode-editor-background)">
						<div class="flex items-center gap-2 border-b border-(--vscode-widget-border)/60 px-3 py-2">
							<span class="grid size-5 place-items-center rounded-full border border-(--vscode-widget-border) text-[10px] font-semibold uppercase">{c.author?.login?.[0] ?? '?'}</span>
							<span class="min-w-0 flex-1 truncate text-[13px] font-semibold">{c.author?.login ?? tr('forge.checks.unknownAuthor')}</span>
							{#if isBot(c)}<span class="rounded border border-(--vscode-widget-border) px-1 text-[10px] {MUTED}">{tr('forge.checks.bot')}</span>{/if}
							{#if c.state && c.state !== 'COMMENTED'}<span class="rounded border border-(--vscode-widget-border) px-1 text-[10px] font-semibold uppercase {MUTED}">{c.state.replace('_', ' ').toLowerCase()}</span>{/if}
							<span class="shrink-0 text-[11px] {MUTED}">{sessionAgo(Date.parse(c.createdAt ?? c.submittedAt ?? ''), Date.now())}</span>
						</div>
						<!-- Safe: renderMarkdown escapes raw HTML and drops images and hrefs. -->
						<div class="markdown-body px-4 py-2.5 text-[13px] leading-relaxed [overflow-wrap:anywhere]">{@html renderMarkdown(c.body ?? '')}</div>
						{@render reactions(c)}
					</div>
				{:else}
					{#if commentsError}<p class="py-5 text-center text-[11px] text-(--vscode-errorForeground)" title={commentsError}>{tr('forge.checks.commentsFailed')}</p>{:else if !composing}<p class="py-5 text-center text-[11px] {MUTED}">{audience === 'bots' ? tr('forge.checks.noBotComments') : audience === 'humans' ? tr('forge.checks.noHumanComments') : tr('forge.checks.noComments')}</p>{/if}
				{/each}
				{#if composing}
					<div class="rounded-md border border-(--vscode-widget-border) bg-(--vscode-editor-background)">
						<!-- svelte-ignore a11y_autofocus -->
						<textarea
							class="max-h-44 min-h-20 w-full resize-none bg-transparent px-2.5 py-2 text-[12px] leading-relaxed outline-none placeholder:text-(--vscode-input-placeholderForeground)"
							placeholder={comments.length ? ft('forge.checks.commentPlaceholder', forge) : tr('forge.checks.startPlaceholder')}
							aria-label={tr('forge.checks.comment')}
							autofocus
							bind:value={draft}
							onkeydown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && (e.preventDefault(), void send())}
						></textarea>
						<div class="flex justify-end gap-1 border-t border-(--vscode-widget-border) px-2 py-1.5">
							<button class="h-6 rounded px-2 text-[11px] hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => ((composing = false), (draft = ''))}>{tr('forge.checks.cancel')}</button>
							<button class="h-6 rounded bg-(--vscode-button-background) px-2 text-[11px] text-(--vscode-button-foreground) disabled:opacity-50" title={tr('forge.checks.sendTip')} disabled={!draft.trim() || busy === 'comment'} onclick={send}>{busy === 'comment' ? tr('forge.checks.sending') : tr('forge.checks.send')}</button>
						</div>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

{#if actionMenu}
	<PopupMenu items={actionItems} label={ft('forge.checks.actionsMenu', forge)} x={actionMenu.x} y={actionMenu.y} onRun={(n) => n.type === 'item' && runAction(n.id)} onClose={() => (actionMenu = null)} />
{/if}
