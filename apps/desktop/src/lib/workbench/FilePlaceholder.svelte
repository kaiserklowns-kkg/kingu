<script lang="ts">
	// VS Code's editor placeholder (EditorPlaceholder: binaryEditor.ts, the too-large and error
	// editors): a file that cannot show as text keeps its tab and says why, with "Open Anyway".
	import Icon from './Icon.svelte';
	import { textFiles, type Placeholder } from './textFileService.svelte';

	let { path, placeholder }: { path: string; placeholder: Placeholder } = $props();

	// Past the hard limit even "Open Anyway" would refuse.
	const canOpen = $derived(!(placeholder.kind === 'tooLarge' && (placeholder.limit ?? 0) >= 1024 ** 3));
</script>

<div class="grid h-full place-items-center bg-(--vscode-editor-background) p-6">
	<div class="flex max-w-lg flex-col items-center gap-3 text-center text-(--vscode-foreground)">
		<span class="text-(--vscode-editorWarning-foreground)"><Icon name={placeholder.kind === 'error' ? 'error' : 'warning'} size={28} /></span>
		<p class="leading-relaxed">{textFiles.placeholderText(placeholder)}</p>
		{#if canOpen}
			<button
				class="rounded-sm bg-(--vscode-button-background) px-3 py-1 text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)"
				onclick={() => textFiles.openAnyway(path)}>{placeholder.kind === 'error' ? 'ลองอีกครั้ง (Try Again)' : 'เปิดอยู่ดี (Open Anyway)'}</button
			>
		{/if}
	</div>
</div>
