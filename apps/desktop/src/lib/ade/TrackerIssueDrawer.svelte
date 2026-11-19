<script lang="ts">
	// A Linear, Jira or GitLab issue beside the Issues list (Orca's linear-item-drawer and Jira /
	// GitLab item views): its state, labels, assignees, description and latest comments, a comment
	// box, and Open in the browser for what the drawer does not change. Read and comment only; the
	// folder's GitHub issues have IssueDrawer.svelte with editing.
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { BUTTON, BUTTON_SECONDARY, ICON_BUTTON, INPUT } from './ui';
	import type { IssueLink } from './model';
	import { commentOnLink, gitlabHost, openLink } from './trackerApi';
	import { trackerDetail, viewCall, type TrackerDetail } from './trackerDetail';
	import { isoTime, sourceName } from './taskSources';
	import { timeAgo } from './model';
	import { adeTasks } from './tasks.svelte';

	let { link, ref, onclose }: { link: IssueLink; ref: string; onclose: () => void } = $props();

	let detail = $state<TrackerDetail | null>(null);
	let error = $state('');
	let busy = $state(false);
	let comment = $state('');
	const service = $derived(sourceName(link));

	async function load() {
		error = '';
		const call = viewCall(link, gitlabHost());
		if (!call) return void (error = t('adeSources.drawer.cannotRead', { service }));
		try {
			detail = trackerDetail(await invoke(call.cmd, call.args));
		} catch (e) {
			error = String(e);
		}
	}
	$effect(() => {
		void link.url;
		detail = null;
		void load();
	});
	async function send(e: Event) {
		e.preventDefault();
		if (!comment.trim() || busy) return;
		busy = true;
		error = '';
		try {
			await commentOnLink(link, comment);
			comment = '';
			await load();
		} catch (err) {
			error = String(err);
		} finally {
			busy = false;
		}
	}
	const when = (iso: string) => {
		const at = isoTime(iso);
		return at ? timeAgo(at, adeTasks.now) : '';
	};
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape anywhere in the drawer) -->
<aside class="flex h-full w-[420px] max-w-full shrink-0 flex-col border-l border-(--vscode-widget-border) bg-(--vscode-sideBar-background) text-xs" aria-label={t('adeSources.drawer.trackerTitle', { ref })} onkeydown={(e) => e.key === 'Escape' && onclose()}>
	<header class="flex shrink-0 items-start gap-2 border-b border-(--vscode-widget-border) px-3 py-2">
		<div class="min-w-0 flex-1">
			<p class="font-mono text-(--vscode-descriptionForeground)">{ref} · {service}</p>
			<h2 class="text-[13px] font-semibold break-words">{detail?.title || link.title}</h2>
		</div>
		<button class={ICON_BUTTON} aria-label={t('adeSources.openOn', { ref, service })} title={t('adeSources.openOn', { ref, service })} onclick={() => void openLink(link).catch((e) => (error = String(e)))}><Icon name="openExternal" size={14} /></button>
		<button class={ICON_BUTTON} aria-label={t('common.close')} title={t('common.close')} onclick={onclose}><Icon name="close" size={14} /></button>
	</header>
	<div class="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2">
		{#if error}<p class="rounded border border-(--vscode-errorForeground) px-2 py-1 text-(--vscode-errorForeground)" role="alert">{error}</p>{/if}
		{#if !detail}
			{#if !error}<p class="text-(--vscode-descriptionForeground)">{t('adeSources.drawer.loading')}</p>{/if}
		{:else}
			<div class="flex flex-wrap items-center gap-1.5">
				{#if detail.state}<span class="rounded-full bg-(--vscode-badge-background)/60 px-2 leading-5 text-(--vscode-badge-foreground)">{detail.state}</span>{/if}
				{#each detail.labels as l (l.name)}
					<span class="rounded-full border px-1.5 text-[11px] leading-4" style:border-color={/^[0-9a-f]{6}$/i.test(l.color) ? `#${l.color}` : undefined}>{l.name}</span>
				{/each}
				<span class="text-(--vscode-descriptionForeground)">{detail.assignees.length ? detail.assignees.join(', ') : t('adeSources.drawer.nobody')}</span>
			</div>
			<p class="text-[11px] text-(--vscode-descriptionForeground)">{t('adeSources.drawer.editThere', { service })}</p>
			{#if detail.body}
				<section aria-label={t('adeSources.drawer.body')} class="rounded border border-(--vscode-widget-border) px-2 py-1.5 break-words whitespace-pre-wrap">{detail.body}{#if detail.truncated}…{/if}</section>
			{/if}
			<section aria-label={t('adeSources.drawer.comments')} class="space-y-2">
				<h3 class="font-medium text-(--vscode-descriptionForeground)">{t('adeSources.drawer.commentCount', { count: detail.comments.length + detail.omitted })}</h3>
				{#each detail.comments as c, i (i)}
					<article class="rounded border border-(--vscode-widget-border) px-2 py-1.5">
						<p class="mb-1 text-(--vscode-descriptionForeground)"><span class="font-medium text-(--vscode-foreground)">{c.author}</span> · {when(c.created_at)}</p>
						<p class="break-words whitespace-pre-wrap">{c.body}</p>
					</article>
				{/each}
			</section>
		{/if}
	</div>
	{#if detail}
		<form class="shrink-0 space-y-1.5 border-t border-(--vscode-widget-border) p-2" onsubmit={send}>
			<textarea class={[INPUT, 'h-16 resize-none']} placeholder={t('adeSources.drawer.commentPlaceholder')} aria-label={t('adeSources.drawer.comment')} bind:value={comment} disabled={busy} onkeydown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && send(e)}></textarea>
			<div class="flex justify-end gap-1.5">
				<button type="button" class={BUTTON_SECONDARY} onclick={onclose}>{t('common.close')}</button>
				<button type="submit" class={BUTTON} disabled={busy || !comment.trim()}>{busy ? t('adeSources.drawer.sending') : t('adeSources.drawer.comment')}</button>
			</div>
		</form>
	{/if}
</aside>
