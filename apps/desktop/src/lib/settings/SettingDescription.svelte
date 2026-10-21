<script lang="ts">
	// A setting's (Markdown) description: inline code, web links, and setting references that jump
	// to the referenced setting (VS Code's settings editor does the same with `#id#`).
	import { invoke } from '@tauri-apps/api/core';
	import { describeParts, isWebLink } from './description';

	let { text, onsetting }: { text: string; onsetting: (id: string) => void } = $props();
	const parts = $derived(describeParts(text));
</script>

{#each parts as part, i (i)}{#if part.kind === 'text'}{part.text}{:else if part.kind === 'code'}<code class="rounded-sm bg-(--vscode-textCodeBlock-background) px-1 font-mono text-[12px]">{part.text}</code>{:else if part.kind === 'setting'}<button
			type="button"
			class="text-(--vscode-textLink-foreground) hover:underline"
			onclick={(e) => {
				e.preventDefault();
				onsetting(part.id);
			}}>{part.id}</button
		>{:else if isWebLink(part.href)}<a
			class="text-(--vscode-textLink-foreground) hover:underline"
			href={part.href}
			onclick={(e) => {
				e.preventDefault();
				void invoke('open_web_url', { url: part.href }).catch(() => {});
			}}>{part.text}</a
		>{:else}{part.text}{/if}{/each}
