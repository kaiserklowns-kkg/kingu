<script lang="ts">
	// Read-only Jupyter notebook viewer (Orca's IpynbViewer): Markdown cells rendered, code cells
	// with their execution count and saved outputs. Nothing runs; edit the JSON as text to change it.
	import { renderMarkdown } from './markdown';
	import { parseNotebook, type Notebook } from './notebook';
	import { watchSource } from './viewerSource';

	let { path }: { path: string } = $props();

	let nb = $state<Notebook | null>(null);
	let error = $state('');
	$effect(() => {
		error = '';
		return watchSource(
			path,
			(text) => {
				try {
					nb = parseNotebook(text);
				} catch (e) {
					error = e instanceof Error ? e.message : String(e);
				}
			},
			(e) => (error = e)
		);
	});
</script>

<div class="h-full overflow-y-auto bg-(--vscode-editor-background)">
	{#if error}
		<p class="p-6 text-[13px] text-(--vscode-errorForeground)">เปิด notebook ไม่ได้: {error}</p>
	{:else if nb}
		<div class="kg-selectable mx-auto flex max-w-[960px] flex-col gap-3 px-6 py-5 text-[13px]">
			<p class="text-xs text-(--vscode-descriptionForeground)">{nb.cells.length} cell · {nb.language} · ดูอย่างเดียว ไม่ได้รันโค้ด</p>
			{#each nb.cells as cell, i (i)}
				{#if cell.kind === 'markdown'}
					<!-- Safe: renderMarkdown escapes raw HTML and drops images and hrefs. -->
					<div class="markdown-cell px-1">{@html renderMarkdown(cell.source)}</div>
				{:else}
					<div class="flex gap-2">
						<span class="w-12 shrink-0 pt-2 text-right font-mono text-xs text-(--vscode-descriptionForeground)">{cell.kind === 'code' ? `[${cell.count ?? ' '}]` : ''}</span>
						<div class="min-w-0 flex-1">
							<pre class="overflow-x-auto rounded-lg border border-(--vscode-widget-border) bg-(--vscode-input-background) px-3 py-2 font-mono text-[12.5px] leading-relaxed">{cell.source}</pre>
							{#each cell.outputs as o, j (j)}
								{#if o.kind === 'image'}
									<img src={o.src} alt="output {j + 1}" class="mt-2 max-w-full rounded-md bg-white" />
								{:else}
									<pre class={['mt-1.5 max-h-80 overflow-auto px-3 py-1 font-mono text-[12px] whitespace-pre-wrap', o.kind === 'error' ? 'text-(--vscode-errorForeground)' : 'text-(--vscode-descriptionForeground)']}>{o.text}</pre>
								{/if}
							{/each}
						</div>
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>

<style>
	.markdown-cell :global(h1) {
		font-size: 1.6em;
		font-weight: 600;
		margin: 0.3em 0;
	}
	.markdown-cell :global(h2) {
		font-size: 1.3em;
		font-weight: 600;
		margin: 0.3em 0;
	}
	.markdown-cell :global(h3) {
		font-weight: 600;
	}
	.markdown-cell :global(p) {
		margin: 0.3em 0;
		line-height: 1.6;
	}
	.markdown-cell :global(ul) {
		list-style: disc;
		padding-left: 1.4em;
	}
	.markdown-cell :global(ol) {
		list-style: decimal;
		padding-left: 1.4em;
	}
	.markdown-cell :global(code) {
		font-family: Menlo, monospace;
		padding: 0.1em 0.3em;
		border-radius: 4px;
		background: rgb(128 128 128 / 0.16);
	}
	.markdown-cell :global(a) {
		color: var(--vscode-textLink-foreground);
	}
</style>
