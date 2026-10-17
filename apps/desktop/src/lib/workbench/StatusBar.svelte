<script lang="ts">
	import { lsp } from '#lib/lsp/lsp.svelte.ts';
	import TeamStatus from '#lib/team/TeamStatus.svelte';
	import Icon from './Icon.svelte';
	import { editors } from './editors.svelte';
	import { layout } from './layout.svelte';
	import { quick } from './quick.svelte';
	import { status } from './status.svelte';

	const languageNames: Record<string, string> = {
		typescript: 'TypeScript',
		javascript: 'JavaScript',
		rust: 'Rust',
		go: 'Go',
		json: 'JSON',
		markdown: 'Markdown',
		css: 'CSS',
		html: 'HTML',
		ini: 'TOML',
		plaintext: 'Plain Text'
	};

	const languageStatus = $derived(lsp.statusFor(editors.language));
</script>

<!-- 22px, items 22px line-height (VS Code statusbarPart). -->
<footer
	class="flex h-(--kg-statusbar-height) shrink-0 items-center border-t border-(--vscode-statusBar-border) bg-(--vscode-statusBar-background) text-xs leading-(--kg-statusbar-height) text-(--vscode-statusBar-foreground)"
>
	{#if status.branch}
		<span class="flex h-full items-center gap-1 px-2"><Icon name="branch" size={14} />{status.branch}</span>
	{/if}
	<button class="flex h-full items-center gap-1 px-2 hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => layout.showPanel('problems')}>
		<Icon name="error" size={14} />{lsp.counts.errors} <Icon name="warning" size={14} />{lsp.counts.warnings}
	</button>
	{#if lsp.progress && lsp.progress !== languageStatus?.text}
		<button class="flex h-full min-w-0 items-center gap-1 truncate px-2 hover:bg-(--vscode-toolbar-hoverBackground)" title={lsp.progress} onclick={() => layout.showPanel('output')}>
			<span class="inline-block size-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent"></span>
			<span class="truncate">{lsp.progress}</span>
		</button>
	{/if}
	{#if status.message}<span class="truncate px-2">{status.message}</span>{/if}
	<div class="flex-1"></div>
	<TeamStatus />
	{#if editors.active && languageStatus}
		<button
			class={['h-full max-w-80 truncate px-2 hover:bg-(--vscode-toolbar-hoverBackground)', languageStatus.state === 'not-installed' || languageStatus.state === 'error' ? 'text-(--vscode-editorWarning-foreground)' : '']}
			title={languageStatus.tooltip}
			onclick={() => layout.showPanel('output')}>{languageStatus.text}</button
		>
	{/if}
	{#if editors.active}
		<button class="h-full px-2 hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => quick.show(':')}>Ln {editors.cursor.line}, Col {editors.cursor.column}</button>
		<span class="px-2">{editors.indent}</span>
		<span class="px-2">UTF-8</span>
		<span class="px-2">{editors.eol}</span>
		<span class="px-2">{languageNames[editors.language] ?? editors.language}</span>
	{/if}
</footer>
