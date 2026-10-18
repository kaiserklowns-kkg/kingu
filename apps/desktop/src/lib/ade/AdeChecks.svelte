<script lang="ts">
	// Orca's Checks tab for the selected worktree's branch: its pull request (number, state, title,
	// merge state) and CI checks sorted failures first, each opening its page on GitHub. Polls every
	// 60 seconds while shown (doubling to 120 when nothing changes), and on window focus.
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '#lib/workbench/Icon.svelte';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { checkKind, checkLabel, checkRank, mergeLabel, summarize, type Pr } from './checks';

	let { slug }: { slug: string } = $props();

	let pr = $state<Pr | null>(null);
	let loaded = $state(false);
	let loading = $state(false);
	let error = $state('');
	let updatedAt = $state<number | null>(null);
	let listOpen = $state(true);

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
	const open = (url: string | undefined) => url && invoke('open_web_url', { url }).catch((e) => status.error(String(e)));

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
</script>

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
			<div class="text-[12px] leading-snug">{pr.title}</div>
			<div class="flex flex-wrap items-center gap-x-2 text-[10px] {MUTED}">
				<span>{pr.headRefName} → {pr.baseRefName}</span>
				{#if pr.additions || pr.deletions}<span><span class="text-[#81b88b]">+{pr.additions}</span> <span class="text-[#c74e39]">-{pr.deletions}</span></span>{/if}
				{#if updatedAt}<span>PR updated {new Date(updatedAt).toLocaleTimeString()}</span>{/if}
			</div>
			<div class="flex items-center gap-2">
				<span class="rounded-md bg-(--vscode-list-inactiveSelectionBackground) px-2 py-1 text-[11px]">{mergeLabel(pr, counts)}</span>
				<button class={BTN} onclick={() => open(pr?.url)}>Open on GitHub</button>
			</div>
			{#if error}<p class="text-[10px] break-words text-rose-500" role="alert">Couldn't refresh from GitHub. Showing the last known status.</p>{/if}
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
				<div class="max-h-[260px] overflow-y-auto">
					{#each checks as c, i (`${c.name ?? c.context}:${i}`)}
						{@const kind = checkKind(c)}
						{@const ic = ICON[kind]}
						<div class="group flex min-w-0 items-center gap-2 px-3 py-1.5 hover:bg-(--vscode-list-hoverBackground)">
							<span class={[ic.cls, ic.spin && 'animate-spin']}><Icon name={ic.name} size={14} /></span>
							<span class="min-w-0 flex-1 truncate text-[12px]" title={c.name ?? c.context}>{c.name ?? c.context}</span>
							<span class="shrink-0 text-[11px] {MUTED}">{checkLabel(c)}</span>
							{#if c.detailsUrl ?? c.targetUrl}
								<button class="grid size-6 place-items-center rounded opacity-0 group-hover:opacity-100 hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="Open check details" title="Open check details" onclick={() => open(c.detailsUrl ?? c.targetUrl)}><Icon name="openExternal" size={12} /></button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		{:else}
			<p class="px-4 py-8 text-[11px] {MUTED}">No checks configured</p>
		{/if}
	{/if}
</div>
