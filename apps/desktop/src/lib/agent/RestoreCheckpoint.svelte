<script lang="ts">
	// "Restore Checkpoint" on a chat request row (VS Code's chat checkpoints), "Start Over" on the
	// first one: after a confirm, the request and every later one are removed and their file
	// changes undone, and the conversation goes back too (chatRewind.svelte.ts). On a request
	// reverted by the older file-only restore it says so instead. The timeline renders it from the
	// `checkpoint` event that follows each user message (ChatList's `checkpoint` snippet).
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { chatEdits } from './chatEdits.svelte.ts';
	import { chatRewind } from './chatRewind.svelte.ts';

	let {
		chatId,
		request,
		first = false,
		compact = false,
		onrestored
	}: {
		chatId: string;
		request: number;
		/** The chat's first request: Start Over. */
		first?: boolean;
		/** Only the ↶ icon (inside the request's box, Cursor's). */
		compact?: boolean;
		/** After the rewind (e.g. put the request back in the input). */
		onrestored?: () => void;
	} = $props();

	let busy = $state(false);
	const view = $derived(chatEdits.view(chatId));
	const req = $derived(view?.requests.find((r) => r.index === request));

	async function restore() {
		busy = true;
		try {
			if (await chatRewind.restore(chatId, request)) onrestored?.();
		} finally {
			busy = false;
		}
	}
</script>

{#if req?.reverted}
	<div class="flex items-center gap-1 text-xs text-(--vscode-descriptionForeground) italic">
		<Icon name="discard" size={12} />{t('chatEdits.reverted')}
	</div>
{:else if compact}
	<button
		class="grid size-6 place-items-center rounded-md text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:opacity-50"
		aria-label={first ? t('chatRewind.startOver') : t('chatRewind.restore')}
		title={first ? t('chatRewind.startOverHint') : t('chatRewind.restoreHint')}
		disabled={busy}
		onclick={restore}><Icon name="discard" size={13} /></button
	>
{:else}
	<div class="flex items-center gap-2 text-xs text-(--vscode-descriptionForeground)">
		<button
			class="inline-flex items-center gap-1 rounded-sm px-1 hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:opacity-50"
			title={first ? t('chatRewind.startOverHint') : t('chatRewind.restoreHint')}
			disabled={busy}
			onclick={restore}><Icon name="discard" size={12} />{first ? t('chatRewind.startOver') : t('chatRewind.restore')}</button
		>
		{#if req?.head_moved}<span title={t('chatEdits.headMoved')}><Icon name="warning" size={12} /></span>{/if}
	</div>
{/if}
