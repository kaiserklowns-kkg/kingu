<script lang="ts">
	// A code cell's outputs (VS Code's output renderers): text and streams, images, sanitized HTML,
	// Markdown, errors. Links in HTML and Markdown outputs open through link protection.
	import { openEditorLink } from '#lib/editor/linkOpener.ts';
	import { t } from '#lib/i18n/index.ts';
	import { renderMarkdown } from './markdown';
	import type { Json } from './notebook';
	import { displayOutput } from './notebookOutput';

	let { outputs }: { outputs: Json[] } = $props();
	const shown = $derived(outputs.map(displayOutput));

	function onclick(e: MouseEvent) {
		const a = (e.target as Element).closest('a[data-href]');
		if (!a) return;
		e.preventDefault();
		openEditorLink(a.getAttribute('data-href') ?? '');
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="nb-outputs kg-selectable flex flex-col gap-1 py-1 text-[12.5px]" {onclick}>
	{#each shown as o, j (j)}
		{#if o.kind === 'image'}
			<img src={o.src} alt="output {j + 1}" class="max-w-full self-start rounded-md bg-white" />
		{:else if o.kind === 'html'}
			<!-- Safe: sanitizeHtml keeps no script, handlers, styles sheets, frames or remote URLs. -->
			<div class="nb-html overflow-x-auto">{@html o.html}</div>
		{:else if o.kind === 'markdown'}
			<!-- Safe: renderMarkdown escapes raw HTML and drops images and hrefs. -->
			<div class="nb-html">{@html renderMarkdown(o.source)}</div>
		{:else if o.kind === 'unsupported'}
			<p class="text-xs text-(--vscode-descriptionForeground) italic">{t('notebook.unsupportedOutput', { mimes: o.mimes.join(', ') })}</p>
		{:else}
			<pre
				class={[
					'max-h-[480px] overflow-auto font-mono whitespace-pre-wrap',
					o.kind === 'error' && 'text-(--vscode-errorForeground)',
					o.kind === 'stream' && o.name === 'stderr' && 'rounded bg-[color-mix(in_srgb,var(--vscode-errorForeground)_8%,transparent)] px-1'
				]}>{o.text}</pre>
		{/if}
	{/each}
</div>

<style>
	.nb-html :global(table) {
		border-collapse: collapse;
		font-size: 12px;
	}
	.nb-html :global(th),
	.nb-html :global(td) {
		border-bottom: 1px solid var(--vscode-widget-border);
		padding: 2px 8px;
		text-align: right;
	}
	.nb-html :global(thead th) {
		font-weight: 600;
	}
	.nb-html :global(a) {
		color: var(--vscode-textLink-foreground);
		cursor: pointer;
	}
	.nb-html :global(code) {
		font-family: Menlo, monospace;
	}
</style>
