<script lang="ts">
	// The pill above the status bar while dictating (Orca's DictationIndicator): the level meter
	// and time, Stop (inserts the text) and Cancel; then "Transcribing…".
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { dictation } from './dictation.svelte';

	const BUTTON = 'h-6 rounded-full px-2.5 text-xs hover:bg-(--vscode-toolbar-hoverBackground)';
</script>

{#if dictation.state !== 'idle'}
	<div
		role="status"
		aria-live="polite"
		class="fixed bottom-9 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) py-1 pr-1.5 pl-3 text-[13px] text-(--vscode-foreground) shadow-lg"
	>
		<span class={dictation.state === 'listening' ? 'text-(--vscode-errorForeground)' : 'text-(--vscode-descriptionForeground)'}><Icon name="mic" size={14} /></span>
		{#if dictation.state === 'transcribing'}
			<span>{t('voice.transcribing')}</span>
		{:else}
			<span class="h-1.5 w-12 overflow-hidden rounded-full bg-(--vscode-widget-border)" aria-hidden="true">
				<span class="block h-full bg-(--vscode-button-background) transition-[width] duration-75" style:width="{Math.round(dictation.level * 100)}%"></span>
			</span>
			<span class="tabular-nums">{t('voice.listening', { time: dictation.elapsed })}</span>
			<button class="{BUTTON} bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:opacity-90" disabled={dictation.state !== 'listening'} onclick={() => void dictation.stop()}>{t('voice.stop')}</button>
			<button class={BUTTON} onclick={() => dictation.cancel()}>{t('voice.cancel')}</button>
		{/if}
	</div>
{/if}
