<script lang="ts">
	// The open folder's GitHub issue in the Issues page (Orca's GitHub item dialog,
	// components/github-item-dialog: body, conversation, edit fields): its body and latest
	// comments, Close / Reopen, labels and assignees to add or remove, and a comment box. Every
	// change goes through `gh` (Rust agent/issues.rs) and the issue is read again after it.
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { BUTTON, BUTTON_SECONDARY, ICON_BUTTON, INPUT } from './ui';
	import type { IssueDetail } from './issues';
	import { isoTime } from './taskSources';
	import { timeAgo } from './model';
	import { adeTasks } from './tasks.svelte';

	let { number, onclose, onchanged }: { number: number; onclose: () => void; onchanged?: () => void } = $props();

	let detail = $state<IssueDetail | null>(null);
	let error = $state('');
	let busy = $state<string | null>(null);
	let label = $state('');
	let comment = $state('');

	async function load() {
		error = '';
		try {
			detail = await invoke<IssueDetail>('gh_issue_view', { number });
		} catch (e) {
			error = String(e);
		}
	}
	$effect(() => {
		void number;
		detail = null;
		void load();
	});

	/** Runs one change, then reads the issue (and the list) again; the error stays on the drawer. */
	async function change(what: string, cmd: string, args: Record<string, unknown>): Promise<boolean> {
		if (busy) return false;
		busy = what;
		error = '';
		try {
			await invoke(cmd, { number, ...args });
			await load();
			onchanged?.();
			return true;
		} catch (e) {
			error = String(e);
			return false;
		} finally {
			busy = null;
		}
	}
	const edit = (e: { addLabels?: string[]; removeLabels?: string[]; addAssignees?: string[]; removeAssignees?: string[]; title?: string; body?: string }) => change('edit', 'gh_issue_edit', { edit: e });
	// Edit title and description (Orca's edit-item-fields). A description cut short when read
	// (body_truncated) is not offered: saving it would drop the rest.
	let editing = $state<{ title: string; body: string } | null>(null);
	function startEdit() {
		if (detail) editing = { title: detail.title, body: detail.body };
	}
	async function saveEdit(e: Event) {
		e.preventDefault();
		if (!editing || !detail) return;
		const next: { title?: string; body?: string } = {};
		if (editing.title.trim() !== detail.title.trim()) next.title = editing.title.trim();
		if (!detail.body_truncated && editing.body !== detail.body) next.body = editing.body;
		if (!Object.keys(next).length || (await edit(next))) editing = null;
	}
	async function addLabel(e: Event) {
		e.preventDefault();
		const l = label.trim();
		if (l && (await edit({ addLabels: [l] }))) label = '';
	}
	async function send(e: Event) {
		e.preventDefault();
		if (comment.trim() && (await change('comment', 'gh_issue_comment', { body: comment }))) comment = '';
	}
	const open = $derived(detail?.state === 'OPEN');
	const when = (iso: string) => {
		const at = isoTime(iso);
		return at ? timeAgo(at, adeTasks.now) : '';
	};
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape anywhere in the drawer) -->
<aside class="flex h-full w-[420px] max-w-full shrink-0 flex-col border-l border-(--vscode-widget-border) bg-(--vscode-sideBar-background) text-xs" aria-label={t('adeSources.drawer.title', { number })} onkeydown={(e) => e.key === 'Escape' && onclose()}>
	<header class="flex shrink-0 items-start gap-2 border-b border-(--vscode-widget-border) px-3 py-2">
		<div class="min-w-0 flex-1">
			<p class="font-mono text-(--vscode-descriptionForeground)">#{number}</p>
			<h2 class="text-[13px] font-semibold break-words">{detail?.title ?? ''}</h2>
			{#if detail && !editing}<button class="text-[11px] text-(--vscode-textLink-foreground) hover:underline" onclick={startEdit}>{t('adeSources.drawer.edit')}</button>{/if}
		</div>
		<button class={ICON_BUTTON} aria-label={t('common.close')} title={t('common.close')} onclick={onclose}><Icon name="close" size={14} /></button>
	</header>
	<div class="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2">
		{#if error}<p class="rounded border border-(--vscode-errorForeground) px-2 py-1 text-(--vscode-errorForeground)" role="alert">{error}</p>{/if}
		{#if !detail}
			{#if !error}<p class="text-(--vscode-descriptionForeground)">{t('adeSources.drawer.loading')}</p>{/if}
		{:else}
			<div class="flex flex-wrap items-center gap-2">
				<span class={['rounded-full px-2 leading-5 font-medium', open ? 'bg-[#238636]/30 text-[#3fb950]' : 'bg-[#8957e5]/30 text-[#a371f7]']}>{open ? t('adeSources.drawer.open') : t('adeSources.drawer.closed')}</span>
				<span class="text-(--vscode-descriptionForeground)">{t('adeSources.drawer.byline', { author: detail.author, when: when(detail.updated_at) })}</span>
				<span class="flex-1"></span>
				<button class={BUTTON_SECONDARY} disabled={!!busy} onclick={() => change('state', 'gh_issue_set_state', { open: !open })}>{open ? t('adeSources.drawer.close') : t('adeSources.drawer.reopen')}</button>
			</div>

			<section aria-label={t('adeSources.drawer.labels')} class="space-y-1">
				<h3 class="font-medium text-(--vscode-descriptionForeground)">{t('adeSources.drawer.labels')}</h3>
				<div class="flex flex-wrap items-center gap-1">
					{#each detail.labels as l (l.name)}
						<span class="flex items-center gap-0.5 rounded-full border pr-0.5 pl-1.5 text-[11px] leading-4" style:border-color={/^[0-9a-f]{6}$/i.test(l.color) ? `#${l.color}` : undefined}>
							{l.name}
							<button class="grid size-3.5 place-items-center rounded-full hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={t('adeSources.drawer.removeLabel', { label: l.name })} title={t('adeSources.drawer.removeLabel', { label: l.name })} disabled={!!busy} onclick={() => edit({ removeLabels: [l.name] })}><Icon name="close" size={9} /></button>
						</span>
					{/each}
					<form class="flex items-center gap-1" onsubmit={addLabel}>
						<input class={[INPUT, 'h-5 w-28 py-0 text-[11px]']} placeholder={t('adeSources.drawer.addLabel')} aria-label={t('adeSources.drawer.addLabel')} bind:value={label} disabled={!!busy} />
					</form>
				</div>
			</section>

			<section aria-label={t('adeSources.drawer.assignees')} class="space-y-1">
				<h3 class="font-medium text-(--vscode-descriptionForeground)">{t('adeSources.drawer.assignees')}</h3>
				<div class="flex flex-wrap items-center gap-1">
					{#each detail.assignees as a (a)}
						<span class="flex items-center gap-0.5 rounded-full bg-(--vscode-badge-background)/60 pr-0.5 pl-1.5 text-[11px] leading-4 text-(--vscode-badge-foreground)">
							@{a}
							<button class="grid size-3.5 place-items-center rounded-full hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={t('adeSources.drawer.unassign', { login: a })} title={t('adeSources.drawer.unassign', { login: a })} disabled={!!busy} onclick={() => edit({ removeAssignees: [a] })}><Icon name="close" size={9} /></button>
						</span>
					{:else}
						<span class="text-(--vscode-descriptionForeground)">{t('adeSources.drawer.nobody')}</span>
					{/each}
					<button class="text-(--vscode-textLink-foreground) hover:underline" disabled={!!busy} onclick={() => edit({ addAssignees: ['@me'] })}>{t('adeSources.drawer.assignMe')}</button>
				</div>
			</section>

			{#if editing}
				<form class="space-y-1.5 rounded border border-(--vscode-focusBorder) p-2" aria-label={t('adeSources.drawer.edit')} onsubmit={saveEdit} onkeydown={(e) => e.key === 'Escape' && (e.stopPropagation(), (editing = null))}>
					<input class={INPUT} aria-label={t('adeSources.drawer.editTitle')} bind:value={editing.title} disabled={!!busy} />
					{#if detail.body_truncated}
						<p class="text-[11px] text-(--vscode-descriptionForeground)">{t('adeSources.drawer.bodyTooLong')}</p>
					{:else}
						<textarea class={[INPUT, 'h-32 resize-y']} aria-label={t('adeSources.drawer.editBody')} bind:value={editing.body} disabled={!!busy}></textarea>
					{/if}
					<div class="flex justify-end gap-1.5">
						<button type="button" class={BUTTON_SECONDARY} disabled={!!busy} onclick={() => (editing = null)}>{t('common.cancel')}</button>
						<button type="submit" class={BUTTON} disabled={!!busy || !editing.title.trim()}>{t('common.save')}</button>
					</div>
				</form>
			{:else if detail.body}
				<section aria-label={t('adeSources.drawer.body')} class="rounded border border-(--vscode-widget-border) px-2 py-1.5 break-words whitespace-pre-wrap">{detail.body}{#if detail.body_truncated}…{/if}</section>
			{/if}

			<section aria-label={t('adeSources.drawer.comments')} class="space-y-2">
				<h3 class="font-medium text-(--vscode-descriptionForeground)">{t('adeSources.drawer.commentCount', { count: detail.comments.length + detail.comments_omitted })}</h3>
				{#if detail.comments_omitted}<p class="text-(--vscode-descriptionForeground)">{t('adeSources.drawer.olderComments', { count: detail.comments_omitted })}</p>{/if}
				{#each detail.comments as c, i (i)}
					<article class="rounded border border-(--vscode-widget-border) px-2 py-1.5">
						<p class="mb-1 text-(--vscode-descriptionForeground)"><span class="font-medium text-(--vscode-foreground)">@{c.author}</span> · {when(c.created_at)}</p>
						<p class="break-words whitespace-pre-wrap">{c.body}</p>
					</article>
				{/each}
			</section>
		{/if}
	</div>
	{#if detail}
		<form class="shrink-0 space-y-1.5 border-t border-(--vscode-widget-border) p-2" onsubmit={send}>
			<textarea
				class={[INPUT, 'h-16 resize-none']}
				placeholder={t('adeSources.drawer.commentPlaceholder')}
				aria-label={t('adeSources.drawer.comment')}
				bind:value={comment}
				disabled={!!busy}
				onkeydown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && send(e)}
			></textarea>
			<div class="flex justify-end"><button type="submit" class={BUTTON} disabled={!!busy || !comment.trim()}>{busy === 'comment' ? t('adeSources.drawer.sending') : t('adeSources.drawer.comment')}</button></div>
		</form>
	{/if}
</aside>
