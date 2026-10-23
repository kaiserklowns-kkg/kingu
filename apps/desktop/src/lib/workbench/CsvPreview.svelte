<script lang="ts">
	// CSV / TSV preview (Orca's CsvViewer): a sticky header table with row numbers, live with edits.
	import { delimiterFor, parseCsv } from './csv';
	import { previewTarget } from './viewers';
	import { watchSource } from './viewerSource';
	import { t } from '#lib/i18n/index.ts';

	let { previewKey: key }: { previewKey: string } = $props();
	const rel = $derived(previewTarget(key));

	/** Rows beyond this are summarized; the text editor still has them all. */
	const ROW_LIMIT = 5000;

	let source = $state('');
	let error = $state('');
	$effect(() => {
		error = '';
		return watchSource(rel, (text) => (source = text), (e) => (error = e));
	});

	const rows = $derived(parseCsv(source, delimiterFor(rel)));
	const header = $derived(rows[0] ?? []);
	const body = $derived(rows.slice(1, ROW_LIMIT + 1));
	const width = $derived(Math.max(header.length, ...body.map((r) => r.length)));
</script>

<div class="h-full overflow-auto bg-(--vscode-editor-background) text-[13px]">
	{#if error}
		<p class="p-6 text-(--vscode-errorForeground)">{t('legacyWorkbench.csvPreview.previewFailed', { error })}</p>
	{:else}
		<table class="kg-selectable border-separate border-spacing-0">
			<thead class="sticky top-0 z-10 bg-(--vscode-editorGroupHeader-tabsBackground)">
				<tr>
					<th class="sticky left-0 z-20 border-r border-b border-(--vscode-widget-border) bg-(--vscode-editorGroupHeader-tabsBackground) px-2 text-right font-normal text-(--vscode-descriptionForeground)">#</th>
					{#each { length: width } as _, c (c)}
						<th class="border-r border-b border-(--vscode-widget-border) px-3 py-1.5 text-left font-semibold whitespace-nowrap">{header[c] ?? ''}</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each body as row, r (r)}
					<tr class="hover:bg-(--vscode-list-hoverBackground)">
						<td class="sticky left-0 border-r border-b border-(--vscode-widget-border) bg-(--vscode-editor-background) px-2 text-right text-xs text-(--vscode-descriptionForeground) tabular-nums">{r + 1}</td>
						{#each { length: width } as _, c (c)}
							<td class="max-w-[420px] truncate border-r border-b border-(--vscode-widget-border) px-3 py-1" title={row[c]}>{row[c] ?? ''}</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
		<p class="px-3 py-2 text-xs text-(--vscode-descriptionForeground)">
			{rows.length - 1 > ROW_LIMIT
				? t('legacyWorkbench.csvPreview.summaryLimited', {
						rows: Math.max(0, rows.length - 1).toLocaleString(),
						columns: width,
						limit: ROW_LIMIT.toLocaleString()
					})
				: t('legacyWorkbench.csvPreview.summary', { rows: Math.max(0, rows.length - 1).toLocaleString(), columns: width })}
		</p>
	{/if}
</div>
