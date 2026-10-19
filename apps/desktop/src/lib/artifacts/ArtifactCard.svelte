<script lang="ts">
	// The chat's card for an `artifact` event: the agent published a page; a click opens that
	// version in the artifact viewer.
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { artifacts } from './artifacts.svelte';
	import type { ArtifactEvent } from './artifacts';

	let { artifact }: { artifact: ArtifactEvent } = $props();
</script>

<button
	type="button"
	class="flex w-full max-w-[420px] items-center gap-2.5 rounded-md border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background,var(--vscode-editor-background)) px-3 py-2 text-left hover:bg-(--vscode-list-hoverBackground)"
	title={t('artifacts.card.open')}
	onclick={() => artifacts.open(artifact.root, artifact.id, artifact.version)}
>
	<span class="grid size-8 shrink-0 place-items-center rounded bg-(--vscode-badge-background) text-(--vscode-badge-foreground)"><Icon name={artifact.format === 'markdown' ? 'fileText' : 'code'} size={16} /></span>
	<span class="flex min-w-0 flex-1 flex-col">
		<span class="truncate font-medium">{artifact.title}</span>
		<span class="truncate text-xs text-(--vscode-descriptionForeground)">{t('artifacts.card.detail', { version: artifact.version, format: artifact.format === 'markdown' ? 'Markdown' : 'HTML' })}</span>
	</span>
	<span class="shrink-0 text-(--vscode-textLink-foreground)"><Icon name="openExternal" size={14} /></span>
</button>
