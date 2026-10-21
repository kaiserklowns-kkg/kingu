<script lang="ts">
	// Markdown: Open Preview (VS Code ⇧⌘V, Orca's MarkdownPreview). Follows the open editor's
	// unsaved text live; otherwise reads the file. Links to workspace files open them; localhost
	// links open in the browser; other links are copied, since the preview never navigates.
	import { invoke } from '@tauri-apps/api/core';
	import { editors } from './editors.svelte';
	import { status } from './status.svelte';
	import { previewTarget } from './viewers';
	import { renderMarkdown } from './markdown';
	import './markdown.css';
	import { watchSource } from './viewerSource';

	let { previewKey: key }: { previewKey: string } = $props();
	const rel = $derived(previewTarget(key));

	let source = $state('');
	let error = $state('');

	$effect(() => {
		error = '';
		return watchSource(rel, (text) => (source = text), (e) => (error = e));
	});

	const html = $derived(renderMarkdown(source));

	function onclick(e: MouseEvent | KeyboardEvent) {
		if (e instanceof KeyboardEvent && e.key !== 'Enter') return;
		const a = (e.target as HTMLElement).closest<HTMLElement>('a[data-href]');
		if (!a) return;
		e.preventDefault();
		const href = a.dataset.href ?? '';
		if (href.startsWith('#')) return;
		if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(href)) {
			void invoke('open_local_url', { url: href }).catch((err) => status.error(String(err)));
		} else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
			void navigator.clipboard.writeText(href).then(() => status.flash(`คัดลอกลิงก์แล้ว: ${href}`, 4000));
		} else {
			// A relative link: resolve against the Markdown file's folder.
			const base = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
			const parts: string[] = [];
			for (const seg of (base + href.split('#')[0]).split('/')) {
				if (seg === '..') parts.pop();
				else if (seg && seg !== '.') parts.push(seg);
			}
			if (parts.length) editors.open(parts.join('/'));
		}
	}
</script>

<div class="h-full overflow-y-auto bg-(--vscode-editor-background)">
	{#if error}
		<p class="p-6 text-[13px] text-(--vscode-errorForeground)">เปิด preview ไม่ได้: {error}</p>
	{:else}
		<!-- Link clicks are delegated here; the links themselves stay keyboard-reachable anchors. -->
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<article class="markdown-body kg-selectable mx-auto max-w-[860px] px-8 py-6" {onclick} onkeydown={onclick}>
			<!-- Safe: renderMarkdown escapes raw HTML and drops images and hrefs (see markdown.ts). -->
			{@html html}
		</article>
	{/if}
</div>
