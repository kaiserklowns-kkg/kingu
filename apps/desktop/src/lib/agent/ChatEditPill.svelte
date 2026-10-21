<script lang="ts">
	// An edit tool's call in a response (VS Code's chatEditPillElement): the file's icon and name,
	// `+added −removed` and, while it runs, a spinner. A click opens the chat edit's diff
	// (chatEdits), or the file itself once it left the working set.
	import Codicon from '#lib/workbench/Codicon.svelte';
	import FileIcon from '#lib/workbench/FileIcon.svelte';
	import { fileIcon } from '#lib/workbench/fileIcons.ts';
	import { splitPath } from '#lib/workbench/scm.ts';
	import { t } from '#lib/i18n/index.ts';
	import { chatEdits } from './chatEdits.svelte.ts';
	import { shortPath } from './chatParts';

	let {
		path,
		added,
		removed,
		done,
		error = false,
		chatId = null,
		cwd = null,
		root = null,
		flat = false
	}: {
		path: string;
		added: number;
		removed: number;
		done: boolean;
		error?: boolean;
		chatId?: string | null;
		cwd?: string | null;
		root?: string | null;
		/** The header of an edit card (no own border, full width). */
		flat?: boolean;
	} = $props();

	const rel = $derived(shortPath(path, cwd));
	const name = $derived(splitPath(rel)[0]);
</script>

<button
	type="button"
	class={[
		'min-w-0 items-center gap-1.5 text-left hover:bg-(--vscode-list-hoverBackground)',
		flat ? 'flex w-full px-2 py-1 text-xs' : 'inline-flex max-w-full self-start rounded border border-(--vscode-widget-border) px-1.5 py-0.5'
	]}
	title={rel}
	aria-label={t('chatParts.edit.open', { path: rel })}
	onclick={() => chatEdits.openEdited(chatId, rel, shortPath(path, root))}
>
	{#if !done}
		<span class="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"></span>
	{:else if error}
		<span class="shrink-0 text-(--vscode-errorForeground)"><Codicon id="error" size={13} /></span>
	{:else}
		<FileIcon icon={fileIcon(name)} size={14} />
	{/if}
	<span class={['min-w-0 truncate', error && 'line-through']}>{name}</span>
	{#if added || removed}
		<span class="shrink-0 font-mono text-[11px]"
			><span class="text-(--vscode-gitDecoration-addedResourceForeground,#73c991)">+{added}</span>
			<span class="text-(--vscode-gitDecoration-deletedResourceForeground,#f14c4c)">−{removed}</span></span
		>
	{/if}
</button>
