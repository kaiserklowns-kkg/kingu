<script lang="ts">
	// Orca's Edit Worktree Details (double-click a card, or the card menu): the display name, a
	// comment shown on the card, and one linked issue (paste a GitHub or Linear URL). The branch
	// and folder stay as they are.
	import { untrack } from 'svelte';
	import AdeDialog from './AdeDialog.svelte';
	import { adeTasks } from './tasks.svelte.ts';
	import { detailsPatch, MAX_COMMENT } from './taskDetails.ts';
	import { BUTTON, BUTTON_SECONDARY, INPUT } from './ui.ts';
	import { t } from '#lib/i18n/index.ts';

	let { slug, onClose }: { slug: string; onClose: () => void } = $props();

	// The form starts from the task as it was when the dialog opened ({#key slug} remounts it).
	const meta = untrack(() => adeTasks.find(slug)?.meta);
	let title = $state(meta?.title ?? '');
	let comment = $state(meta?.comment ?? '');
	let issueUrl = $state(meta?.issue?.url ?? '');
	let busy = $state(false);
	let error = $state('');

	async function save(e?: Event) {
		e?.preventDefault();
		if (!meta || busy) return;
		const patch = detailsPatch({ comment: meta.comment, issue: meta.issue }, { comment, issueUrl });
		if ('error' in patch) {
			error = patch.error === 'badIssue' ? t('adeTasks.details.badIssue') : t('adeTasks.details.longComment', { max: MAX_COMMENT });
			return;
		}
		busy = true;
		try {
			await adeTasks.updateDetails(slug, { title, ...patch });
			onClose();
		} catch (err) {
			error = t('adeTasks.details.saveFailed', { error: String(err) });
		} finally {
			busy = false;
		}
	}
</script>

<AdeDialog title={t('adeTasks.details.title')} {busy} {onClose}>
	<form class="space-y-3 text-xs" onsubmit={save}>
		<label class="block space-y-1">
			<span class="text-(--vscode-descriptionForeground)">{t('adeTasks.details.name')}</span>
			<input class={INPUT} bind:value={title} maxlength="200" data-autofocus disabled={busy} />
		</label>
		<label class="block space-y-1">
			<span class="text-(--vscode-descriptionForeground)">{t('adeTasks.details.comment')}</span>
			<textarea class={[INPUT, 'min-h-16 resize-y']} bind:value={comment} maxlength={MAX_COMMENT} placeholder={t('adeTasks.details.commentPlaceholder')} disabled={busy}></textarea>
		</label>
		<label class="block space-y-1">
			<span class="text-(--vscode-descriptionForeground)">{t('adeTasks.details.issue')}</span>
			<input class={INPUT} bind:value={issueUrl} placeholder={t('adeTasks.details.issuePlaceholder')} spellcheck="false" disabled={busy} oninput={() => (error = '')} />
		</label>
		{#if error}<p class="text-(--vscode-errorForeground)" role="alert">{error}</p>{/if}
		<button type="submit" hidden aria-hidden="true" tabindex="-1"></button>
	</form>
	{#snippet footer()}
		<button class={BUTTON_SECONDARY} disabled={busy} onclick={onClose}>{t('common.cancel')}</button>
		<button class={BUTTON} disabled={busy || !title.trim()} onclick={() => save()}>{t('adeTasks.details.save')}</button>
	{/snippet}
</AdeDialog>
