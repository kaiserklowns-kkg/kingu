<script lang="ts">
	// A markdown note tab of the floating workspace: edit, saved as you type; Preview renders it.
	import { invoke } from '@tauri-apps/api/core';
	import { renderMarkdown } from './markdown';

	let { path }: { path: string } = $props();
	let text = $state('');
	let loaded = $state(false);
	let preview = $state(false);
	let error = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		invoke<string>('floating_note_read', { path })
			.then((t) => ((text = t), (loaded = true)))
			.catch((e) => (error = String(e)));
		return () => {
			if (timer) (clearTimeout(timer), save());
		};
	});

	function save() {
		timer = undefined;
		invoke('floating_note_write', { path, text }).catch((e) => (error = String(e)));
	}
	function changed() {
		clearTimeout(timer);
		timer = setTimeout(save, 400);
	}
</script>

<div class="flex h-full min-h-0 flex-col bg-(--vscode-editor-background)">
	<div class="flex h-7 shrink-0 items-center gap-2 border-b border-(--vscode-widget-border) px-3 text-[11px] text-(--vscode-descriptionForeground)">
		<span class="min-w-0 flex-1 truncate" title={path}>{path}</span>
		{#if error}<span class="text-(--vscode-errorForeground)">{error}</span>{/if}
		<button class="rounded px-1.5 py-0.5 hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)" aria-pressed={preview} onclick={() => (preview = !preview)}>{preview ? 'Edit' : 'Preview'}</button>
	</div>
	{#if preview}
		<!-- Safe: renderMarkdown escapes raw HTML and drops images and hrefs. -->
		<article class="markdown-body min-h-0 flex-1 overflow-y-auto px-6 py-4 text-[13px]">{@html renderMarkdown(text)}</article>
	{:else}
		<textarea
			class="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[13px] leading-5 text-(--vscode-editor-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground)"
			placeholder={loaded ? 'Write a note…' : ''}
			spellcheck="false"
			disabled={!loaded}
			bind:value={text}
			oninput={changed}
		></textarea>
	{/if}
</div>
