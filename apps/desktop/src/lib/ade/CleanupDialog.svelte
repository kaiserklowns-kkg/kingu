<script lang="ts">
	// Removes several tasks at once. Finished tasks start checked; a task whose agent is working can't
	// be picked. One confirmation for all (this dialog); a worktree with uncommitted work still asks.
	// Offered with only some tasks (Pick winner's other attempts), those start checked, and the
	// branch checkbox deletes their branches even though they were never merged.
	import Icon from '#lib/workbench/Icon.svelte';
	import { untrack } from 'svelte';
	import { t } from '#lib/i18n/index.ts';
	import { adeTasks } from './tasks.svelte';
	import { runtime } from './runtime.svelte';
	import { cleanup } from './cleanup.svelte';
	import { STATUS_LABEL, timeAgo } from './model';
	import { STATUS_DOT } from './ui';

	const ORDER = { done: 0, review: 1, failed: 2, waiting: 3, running: 4 } as const;
	const only = untrack(() => cleanup.only);
	const rows = $derived([...adeTasks.views].filter((v) => !only || only.includes(v.meta.slug)).sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.meta.updated_at - a.meta.updated_at));
	let picked = $state<Record<string, boolean>>(untrack(() => Object.fromEntries(adeTasks.views.filter((v) => (only ? only.includes(v.meta.slug) : v.status === 'done')).map((v) => [v.meta.slug, true]))));
	let deleteBranch = $state(false);
	let progress = $state<{ done: number; total: number } | null>(null);

	const busy = (slug: string) => runtime.isWorking(slug);
	const chosen = $derived(rows.filter((v) => picked[v.meta.slug] && !busy(v.meta.slug)).map((v) => v.meta.slug));

	async function run() {
		progress = { done: 0, total: chosen.length };
		for (const slug of chosen) {
			// This dialog is the confirmation; the checkbox deletes merged branches (git branch -d), never
			// unmerged work, except for the losing attempts the user chose to throw away.
			await adeTasks.removeConfirmed(slug, { deleteBranch: deleteBranch ? (only ? 'force' : 'safe') : 'keep', force: false });
			progress = { done: progress.done + 1, total: progress.total };
		}
		cleanup.close();
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && !progress) {
			e.preventDefault();
			cleanup.close();
		}
	}
</script>

<svelte:window {onkeydown} />

<div class="fixed inset-0 z-[65] grid place-items-center bg-black/40 p-6" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && !progress && cleanup.close()}>
	<div role="dialog" aria-modal="true" aria-labelledby="kg-cleanup-title" class="flex max-h-[80vh] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) text-(--vscode-foreground) shadow-2xl shadow-black/50">
		<header class="flex items-center gap-2.5 px-5 pt-5 pb-3">
			<Icon name="trash" size={18} />
			<h2 id="kg-cleanup-title" class="flex-1 text-[14px] font-semibold">{only ? t('adeAttempts.cleanup.titleLosers') : t('adeAttempts.cleanup.title')}</h2>
			{#if !only}
				<button class="rounded-md px-2 text-xs text-(--vscode-textLink-foreground) hover:underline" onclick={() => (picked = Object.fromEntries(rows.map((v) => [v.meta.slug, v.status === 'done'])))}>{t('adeAttempts.cleanup.onlyDone')}</button>
			{/if}
		</header>
		<p class="px-5 pb-3 text-[13px] text-(--vscode-descriptionForeground)">{only ? t('adeAttempts.cleanup.hintLosers') : t('adeAttempts.cleanup.hint')}</p>
		<ul class="min-h-0 flex-1 overflow-y-auto border-y border-(--vscode-widget-border) py-1">
			{#each rows as v (v.meta.slug)}
				{@const slug = v.meta.slug}
				<li>
					<label class={['mx-1.5 flex items-center gap-3 rounded-md px-3 py-2', busy(slug) ? 'opacity-50' : 'cursor-pointer hover:bg-(--vscode-list-hoverBackground)']}>
						<input type="checkbox" class="size-4 accent-(--vscode-focusBorder)" disabled={busy(slug) || !!progress} bind:checked={picked[slug]} />
						<span class={['size-2 shrink-0 rounded-full', STATUS_DOT[v.status]]} title={STATUS_LABEL[v.status]}></span>
						<span class="min-w-0 flex-1">
							<span class="block truncate text-[13px]">{v.meta.title}</span>
							<span class="block truncate font-mono text-[11px] text-(--vscode-descriptionForeground)">{adeTasks.branchOf(slug)} · {STATUS_LABEL[v.status]}</span>
						</span>
						<span class="shrink-0 text-[11px] text-(--vscode-descriptionForeground)">{timeAgo(v.meta.updated_at, adeTasks.now)}</span>
					</label>
				</li>
			{:else}
				<li class="px-5 py-8 text-center text-[13px] text-(--vscode-descriptionForeground)">{t('adeAttempts.cleanup.empty')}</li>
			{/each}
		</ul>
		<footer class="flex items-center gap-3 px-5 py-3">
			<label class="flex flex-1 items-center gap-2 text-[13px]">
				<input type="checkbox" class="size-4 accent-(--vscode-focusBorder)" bind:checked={deleteBranch} disabled={!!progress} />
				{only ? t('adeAttempts.cleanup.deleteBranchesLosers') : t('adeAttempts.cleanup.deleteBranches')}
			</label>
			{#if progress}
				<span class="text-[13px] text-(--vscode-descriptionForeground)">{t('adeAttempts.cleanup.progress', { done: progress.done, total: progress.total })}</span>
			{:else}
				<button class="h-8 rounded-md px-3.5 text-[13px] hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => cleanup.close()}>{t('common.cancel')}</button>
				<button class="h-8 rounded-md bg-[#C42B1C] px-3.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40" disabled={!chosen.length} onclick={run}>{t('adeAttempts.cleanup.remove', { count: chosen.length })}</button>
			{/if}
		</footer>
	</div>
</div>
