<script lang="ts">
	// Markdown: Open Preview (VS Code ⇧⌘V, Orca's MarkdownPreview). Follows the open editor's
	// unsaved text live; otherwise reads the file. Links to workspace files open them; localhost
	// links open in the browser; other links are copied, since the preview never navigates.
	import { invoke } from '@tauri-apps/api/core';
	import { editors } from './editors.svelte';
	import { status } from './status.svelte';
	import { previewTarget } from './viewers';
	import { renderMarkdown } from './markdown';
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

<style>
	.markdown-body {
		font-size: 14px;
		line-height: 1.65;
		color: var(--vscode-editor-foreground);
		overflow-wrap: break-word;
	}
	.markdown-body :global(h1),
	.markdown-body :global(h2) {
		padding-bottom: 0.3em;
		border-bottom: 1px solid var(--vscode-widget-border);
	}
	.markdown-body :global(h1) {
		font-size: 2em;
		font-weight: 600;
		margin: 0.4em 0 0.6em;
	}
	.markdown-body :global(h2) {
		font-size: 1.5em;
		font-weight: 600;
		margin: 1.4em 0 0.6em;
	}
	.markdown-body :global(h3) {
		font-size: 1.25em;
		font-weight: 600;
		margin: 1.2em 0 0.5em;
	}
	.markdown-body :global(h4),
	.markdown-body :global(h5),
	.markdown-body :global(h6) {
		font-weight: 600;
		margin: 1em 0 0.4em;
	}
	.markdown-body :global(p),
	.markdown-body :global(ul),
	.markdown-body :global(ol),
	.markdown-body :global(blockquote),
	.markdown-body :global(pre),
	.markdown-body :global(table) {
		margin: 0 0 1em;
	}
	.markdown-body :global(ul) {
		list-style: disc;
		padding-left: 1.6em;
	}
	.markdown-body :global(ol) {
		list-style: decimal;
		padding-left: 1.6em;
	}
	.markdown-body :global(li > input[type='checkbox']) {
		margin-right: 0.4em;
	}
	.markdown-body :global(a) {
		color: var(--vscode-textLink-foreground);
		cursor: pointer;
	}
	.markdown-body :global(a:hover) {
		text-decoration: underline;
	}
	.markdown-body :global(code) {
		font-family: var(--vscode-editor-font-family, Menlo, monospace);
		font-size: 0.9em;
		padding: 0.15em 0.35em;
		border-radius: 5px;
		background: rgb(128 128 128 / 0.16);
	}
	.markdown-body :global(pre) {
		padding: 12px 14px;
		border-radius: 8px;
		background: rgb(128 128 128 / 0.12);
		overflow-x: auto;
	}
	.markdown-body :global(pre code) {
		padding: 0;
		background: none;
	}
	.markdown-body :global(blockquote) {
		padding: 0 1em;
		color: var(--vscode-descriptionForeground);
		border-left: 3px solid var(--vscode-widget-border);
	}
	.markdown-body :global(table) {
		border-collapse: collapse;
		display: block;
		overflow-x: auto;
	}
	.markdown-body :global(th),
	.markdown-body :global(td) {
		padding: 6px 12px;
		border: 1px solid var(--vscode-widget-border);
	}
	.markdown-body :global(th) {
		font-weight: 600;
	}
	.markdown-body :global(hr) {
		margin: 1.5em 0;
		border: 0;
		border-top: 1px solid var(--vscode-widget-border);
	}
	.markdown-body :global(.md-image) {
		display: inline-block;
		padding: 2px 8px;
		border-radius: 6px;
		border: 1px dashed var(--vscode-widget-border);
		color: var(--vscode-descriptionForeground);
		font-size: 0.9em;
	}
</style>
