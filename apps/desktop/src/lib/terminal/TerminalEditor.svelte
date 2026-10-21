<script lang="ts">
	// A terminal shown as an editor (`terminal:<id>`, terminalEditor.svelte.ts). Unmounting it (another
	// tab in front) leaves the shell running; showing it again re-attaches with its recent output.
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { t as tr } from '#lib/i18n/index.ts';
	import Terminal from './Terminal.svelte';
	import { terminals } from './terminals.svelte.ts';
	import { terminalEditorKey, terminalIdOfEditor } from './terminalEditor.svelte.ts';

	let { editorKey }: { editorKey: string } = $props();
	const id = $derived(terminalIdOfEditor(editorKey));
	const entry = $derived(id !== null && terminals.tag ? terminals.get(id) : undefined);

	function openFile(rel: string, line?: number, column?: number) {
		editors.open(rel, { preview: false, reveal: line ? { line, column: column ?? 1, focus: true } : undefined });
	}

	function action(a: string) {
		if (!entry) return;
		if (a === 'kill') editors.closeEverywhere(terminalEditorKey(entry.id));
		else if (a === 'rename') void terminals.rename(entry.id);
	}
</script>

<div class="h-full w-full bg-(--vscode-terminal-background)">
	{#if entry?.inEditor}
		{#key entry.id}
			<Terminal key={terminals.key(entry.id)} run={entry.run} folder={entry.folder} profile={entry.profile} flavor="ide" onaction={action} onopenfile={openFile} />
		{/key}
	{:else}
		<div class="grid h-full place-items-center text-(--vscode-descriptionForeground)">{tr('terminal.editor.noTerminal')}</div>
	{/if}
</div>
