<script lang="ts">
	// VS Code's save conflict compare (textFileSaveErrorHandler's ResolveSaveConflictAction): the
	// file on disk on the left, your version (the shared model, still editable) on the right, with
	// "Accept Your Changes" (overwrite) and "Revert Your Changes" (take the disk version).
	import { onMount } from 'svelte';
	import type * as Monaco from 'monaco-editor';
	import Icon from './Icon.svelte';
	import { editorLabel } from './editorLabel';
	import { getEntry } from './editorModels';
	import { textFiles } from './textFileService.svelte';

	let { path, disk }: { path: string; disk: string } = $props();

	let host: HTMLDivElement;
	const name = $derived(editorLabel(path));

	onMount(() => {
		let diff: Monaco.editor.IStandaloneDiffEditor | undefined;
		let original: Monaco.editor.ITextModel | undefined;
		let gone = false;
		void import('#lib/editor/monaco.ts').then(async (m) => {
			await m.setupTextMate();
			const entry = getEntry(path);
			if (gone || !entry) return;
			original = m.monaco.editor.createModel(disk, entry.model.getLanguageId(), m.monaco.Uri.from({ scheme: 'kingu-disk', path: '/' + path }));
			diff = m.monaco.editor.createDiffEditor(host, { theme: m.THEME_ID, automaticLayout: true, renderSideBySide: true, originalEditable: false });
			diff.setModel({ original, modified: entry.model });
		});
		return () => {
			gone = true;
			// The modified side is the file's shared model: detach it, never dispose it.
			diff?.setModel(null);
			diff?.dispose();
			original?.dispose();
		};
	});
</script>

<div class="flex h-full flex-col bg-(--vscode-editor-background)">
	<div class="flex h-(--kg-breadcrumbs-height) shrink-0 items-center gap-2 border-b border-(--vscode-editorGroup-border) px-3 text-(--vscode-descriptionForeground)">
		<span class="min-w-0 flex-1 truncate">{name} (บนดิสก์ · on disk) ↔ {name} (ของคุณ · yours)</span>
		<button class="flex items-center gap-1 rounded px-1.5 hover:bg-(--vscode-toolbar-hoverBackground)" title="บันทึกเวอร์ชันของคุณทับไฟล์บนดิสก์" onclick={() => textFiles.overwrite(path)}>
			<Icon name="check" size={14} />ใช้ของคุณ (Accept Your Changes)
		</button>
		<button class="flex items-center gap-1 rounded px-1.5 hover:bg-(--vscode-toolbar-hoverBackground)" title="ทิ้งการแก้ไขของคุณและใช้ไฟล์บนดิสก์" onclick={() => textFiles.revert(path)}>
			<Icon name="discard" size={14} />ใช้บนดิสก์ (Revert Your Changes)
		</button>
		<button class="grid size-5 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="ปิดการเปรียบเทียบ" onclick={() => textFiles.closeCompare()}>
			<Icon name="close" size={14} />
		</button>
	</div>
	<div bind:this={host} class="min-h-0 flex-1"></div>
</div>
