<script lang="ts">
	// Kingu's Agents home: unlike the workflow board, this is an outcome-first inbox. It answers
	// what needs a human decision, what is ready to review, and what is currently moving.
	import Icon from '#lib/workbench/Icon.svelte';
	import TaskCard from './TaskCard.svelte';
	import SetupBanner from '#lib/setup/SetupBanner.svelte';
	import { adeLayout, PRIMARY } from './adeLayout.svelte';
	import { adeTasks } from './tasks.svelte';
	import { BUTTON, BUTTON_SECONDARY } from './ui';
	import { t } from '#lib/i18n/index.ts';
	import { agentInbox } from './agentInbox.svelte.ts';
	import { activityFeed } from './agentInbox';
	import { projects } from './projects.svelte';
	import { timeAgo } from './model';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';

	const decisions = $derived(adeTasks.groups.attention.filter((v) => v.status === 'waiting' || v.status === 'failed'));
	const review = $derived(adeTasks.groups.attention.filter((v) => v.status === 'review'));
	const working = $derived(adeTasks.groups.active);
	const complete = $derived(!decisions.length && !review.length && !working.length);

	// Orca's Agents feed history: notices and created worktrees, newest first, with a filter.
	let filter = $state('');
	let filterBox: HTMLInputElement | undefined = $state();
	const feed = $derived(activityFeed(agentInbox.items, adeTasks.list, filter));
	function openEntry(slug: string, root: string | null) {
		if (root && root !== workspace.root) return void projects.open(root, slug);
		if (adeTasks.find(slug)) adeTasks.openTask(slug);
	}
	// ⌘F (Ctrl+F) focuses the feed filter while the page is shown (a terminal keeps its own).
	function onKey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !(e.target as HTMLElement | null)?.closest('.xterm')) {
			e.preventDefault();
			filterBox?.focus();
		}
	}

	function newTask() {
		adeTasks.composing = true;
		adeLayout.show(PRIMARY);
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="h-full overflow-y-auto bg-(--vscode-editor-background) text-(--vscode-foreground)">
	<header class="sticky top-0 z-10 border-b border-(--vscode-widget-border) bg-(--vscode-editor-background)/95 px-5 py-4 backdrop-blur">
		<div class="mx-auto flex max-w-6xl items-center gap-3">
			<div class="grid size-9 place-items-center rounded-xl bg-(--vscode-button-background)/15 text-(--vscode-button-background)"><Icon name="agent" size={21} /></div>
			<div class="min-w-0 flex-1">
				<h1 class="text-base font-semibold">Now</h1>
				<p class="text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.nowPage.subtitle')}</p>
			</div>
			<button class={BUTTON_SECONDARY} onclick={() => (adeLayout.page = 'board')}><Icon name="tasks" size={14} /> Board</button>
			<button class={BUTTON} onclick={newTask}><Icon name="plus" size={14} /> {t('legacyAde.nowPage.newTask')}</button>
		</div>
	</header>

	<main class="mx-auto max-w-6xl space-y-7 p-5">
		<SetupBanner />
		{#if complete}
			<section class="grid min-h-72 place-items-center rounded-xl border border-dashed border-(--vscode-widget-border) p-8 text-center">
				<div class="max-w-md space-y-3">
					<div class="mx-auto grid size-11 place-items-center rounded-full bg-(--vscode-button-background)/15 text-(--vscode-button-background)"><Icon name="check" size={24} /></div>
					<h2 class="font-semibold">{t('legacyAde.nowPage.emptyTitle')}</h2>
					<p class="text-sm text-(--vscode-descriptionForeground)">{t('legacyAde.nowPage.emptyText')}</p>
					<div class="flex justify-center gap-2"><button class={BUTTON} onclick={newTask}><Icon name="plus" size={14} /> {t('legacyAde.nowPage.createTask')}</button><button class={BUTTON_SECONDARY} onclick={() => (adeLayout.page = 'board')}>{t('legacyAde.nowPage.openBoard')}</button></div>
				</div>
			</section>
		{/if}

		{#if decisions.length}
			<section aria-labelledby="now-decisions">
				<div class="mb-2 flex items-center gap-2"><span class="size-2 rounded-full bg-(--vscode-editorWarning-foreground)"></span><h2 id="now-decisions" class="font-semibold">{t('legacyAde.nowPage.decisions')}</h2><span class="rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] text-(--vscode-badge-foreground)">{decisions.length}</span></div>
				<p class="mb-3 text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.nowPage.decisionsHint')}</p>
				<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{#each decisions as view (view.meta.slug)}<TaskCard {view} />{/each}</div>
			</section>
		{/if}

		{#if review.length}
			<section aria-labelledby="now-review">
				<div class="mb-2 flex items-center gap-2"><span class="size-2 rounded-full bg-(--vscode-textLink-foreground)"></span><h2 id="now-review" class="font-semibold">{t('legacyAde.nowPage.review')}</h2><span class="rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] text-(--vscode-badge-foreground)">{review.length}</span></div>
				<p class="mb-3 text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.nowPage.reviewHint')}</p>
				<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{#each review as view (view.meta.slug)}<TaskCard {view} />{/each}</div>
			</section>
		{/if}

		{#if working.length}
			<section aria-labelledby="now-working">
				<div class="mb-2 flex items-center gap-2"><span class="size-2 animate-pulse rounded-full bg-(--vscode-editorInfo-foreground)"></span><h2 id="now-working" class="font-semibold">{t('legacyAde.nowPage.working')}</h2><span class="rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] text-(--vscode-badge-foreground)">{working.length}</span></div>
				<p class="mb-3 text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.nowPage.workingHint')}</p>
				<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{#each working as view (view.meta.slug)}<TaskCard {view} />{/each}</div>
			</section>
		{/if}

		<section aria-labelledby="now-activity">
			<div class="mb-2 flex items-center gap-2">
				<Icon name="activity" size={14} />
				<h2 id="now-activity" class="font-semibold">{t('ade.activity.title')}</h2>
				<input bind:this={filterBox} class="ml-auto h-7 w-56 rounded border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) px-2 text-xs outline-none focus:border-(--vscode-focusBorder)" placeholder={t('ade.activity.filter')} aria-label={t('ade.activity.filter')} bind:value={filter} />
			</div>
			<ul class="divide-y divide-(--vscode-widget-border) rounded-lg border border-(--vscode-widget-border) text-xs">
				{#each feed as e (e.id)}
					<li>
						<button class="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-(--vscode-list-hoverBackground)" onclick={() => openEntry(e.slug, e.root)}>
							<span class="mt-0.5 text-(--vscode-descriptionForeground)"><Icon name={e.kind === 'created' ? 'plus' : 'bell'} size={13} /></span>
							<span class="min-w-0 flex-1">
								<span class="block truncate">{e.kind === 'created' ? t('ade.activity.created', { title: e.title }) : e.title}</span>
								{#if e.body}<span class="block truncate text-(--vscode-descriptionForeground)">{e.body}</span>{/if}
							</span>
							<span class="shrink-0 text-[10px] text-(--vscode-descriptionForeground)">{timeAgo(e.at, adeTasks.now)}</span>
						</button>
					</li>
				{:else}
					<li class="px-3 py-4 text-center text-(--vscode-descriptionForeground)">{t('ade.activity.empty')}</li>
				{/each}
			</ul>
		</section>
	</main>
</div>
