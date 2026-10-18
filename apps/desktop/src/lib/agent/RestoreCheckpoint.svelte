<script lang="ts">
	// "Restore checkpoint" on a chat request row (VS Code's chat checkpoints): reverts the file
	// changes of request `request` and every later one, after a confirm. On a reverted request it
	// says so instead. Shown only for requests that changed files. The timeline renders it from
	// the `checkpoint` event that follows each user message (AgentTimeline's `checkpoint` snippet).
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { chatEdits, restoreCheckpoint } from './chatEdits.svelte.ts';

	let { chatId, request }: { chatId: string; request: number } = $props();

	let busy = $state(false);
	const view = $derived(chatEdits.view(chatId));
	const req = $derived(view?.requests.find((r) => r.index === request));
	/** Any file changed from this request on (not yet reverted): something to go back from. */
	const changes = $derived(!!view?.requests.some((r) => r.index >= request && !r.reverted && r.paths.length));

	async function restore() {
		busy = true;
		try {
			await restoreCheckpoint(chatId, request);
		} finally {
			busy = false;
		}
	}
</script>

{#if req?.reverted}
	<div class="flex items-center gap-1 text-xs text-(--vscode-descriptionForeground) italic">
		<Icon name="discard" size={12} />{t('chatEdits.reverted')}
	</div>
{:else if req && changes}
	<div class="flex items-center gap-2 text-xs text-(--vscode-descriptionForeground)">
		<button
			class="inline-flex items-center gap-1 rounded-sm px-1 hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:opacity-50"
			title={view?.running ? t('chatEdits.running') : t('chatEdits.restoreHint')}
			disabled={busy || view?.running}
			onclick={restore}><Icon name="discard" size={12} />{t('chatEdits.restore')}</button
		>
		{#if req.head_moved}<span title={t('chatEdits.headMoved')}><Icon name="warning" size={12} /></span>{/if}
	</div>
{/if}
