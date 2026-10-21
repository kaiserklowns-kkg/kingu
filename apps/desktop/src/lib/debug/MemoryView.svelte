<script lang="ts">
	// The Memory view (VS Code: View Binary Data, the hex editor on a variable's memory reference):
	// 16 bytes a row as address, hex and text, read a page at a time with readMemory (earlier and
	// later pages on request); a byte is edited in place and written with writeMemory when the
	// adapter can. Adapter `memory` events read the changed bytes again.
	import { onDestroy } from 'svelte';
	import { t } from '#lib/i18n/index.ts';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import { debug } from './debug.svelte.ts';
	import { asciiOf, hexByte, MEMORY_PAGE, memoryRows, parseHexBytes, parseMemoryKey, putChunk, type MemoryChunk } from './memory.ts';

	let { memoryKey }: { memoryKey: string } = $props();

	const parsed = $derived(parseMemoryKey(memoryKey));
	let chunks = $state.raw<MemoryChunk[]>([]);
	let error = $state('');
	let editing = $state<{ offset: number; value: string } | null>(null);
	// Follows the sessions (the one that owns the memory may end).
	const support = $derived(debug.sessions && parsed ? debug.memorySupport(parsed.session) : { live: false, write: false });
	const start = $derived(chunks.length ? chunks[0].offset : 0);
	const end = $derived(chunks.length ? Math.max(...chunks.map((c) => c.offset + c.bytes.length + c.unreadable)) : 0);
	const rows = $derived(parsed ? memoryRows(parsed.memoryReference, chunks, start, end) : []);

	async function read(offset: number, count = MEMORY_PAGE) {
		if (!parsed) return;
		try {
			const got = await debug.readMemory(parsed.session, parsed.memoryReference, offset, count);
			if (!got) return void (error = t('debugExtras.memory.ended'));
			error = '';
			chunks = putChunk(chunks, { offset, bytes: got.bytes, unreadable: got.bytes.length + got.unreadable < count ? count - got.bytes.length : got.unreadable });
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	$effect(() => {
		void memoryKey;
		chunks = [];
		void read(0);
	});

	// The adapter says bytes changed: the pages that hold them are read again.
	const off = debug.onMemory((key, ref, offset, count) => {
		if (!parsed || key !== parsed.session || ref !== parsed.memoryReference) return;
		const from = Math.floor(offset / MEMORY_PAGE) * MEMORY_PAGE;
		for (let o = from; o < offset + Math.max(1, count); o += MEMORY_PAGE) if (o >= start && o < end) void read(o);
	});
	onDestroy(off);

	async function commit() {
		const e = editing;
		editing = null;
		if (!e || !parsed) return;
		const bytes = parseHexBytes(e.value);
		if (!bytes) return notifications.error(t('debugExtras.memory.badBytes', { value: e.value }));
		try {
			await debug.writeMemory(parsed.session, parsed.memoryReference, e.offset, bytes);
			await read(Math.floor(e.offset / MEMORY_PAGE) * MEMORY_PAGE);
		} catch (err) {
			notifications.error(err instanceof Error ? err.message : String(err));
		}
	}
</script>

<section class="flex h-full min-h-0 flex-col bg-(--vscode-editor-background) font-(family-name:--vscode-editor-font-family) text-[12px] text-(--vscode-editor-foreground)">
	<div class="flex h-[26px] shrink-0 items-center gap-3 border-b border-(--vscode-editorGroupHeader-tabsBorder,transparent) px-3 font-sans text-xs text-(--vscode-descriptionForeground)">
		<span class="truncate">{t('debugExtras.memory.title', { reference: parsed?.memoryReference ?? '' })}</span>
		{#if !support.live}<span class="text-(--vscode-errorForeground)">{t('debugExtras.memory.ended')}</span>{:else if !support.write}<span>{t('debugExtras.memory.readOnly')}</span>{/if}
		<button class="ml-auto text-(--vscode-textLink-foreground) hover:underline disabled:opacity-40" disabled={!support.live} onclick={() => void read(start - MEMORY_PAGE)}>{t('debugExtras.memory.earlier')}</button>
		<button class="text-(--vscode-textLink-foreground) hover:underline disabled:opacity-40" disabled={!support.live} onclick={() => void read(end)}>{t('debugExtras.memory.later')}</button>
	</div>
	{#if error}<p class="px-4 py-1 font-sans text-(--vscode-errorForeground)">{error}</p>{/if}
	<div class="min-h-0 flex-1 overflow-auto px-3 py-1" role="grid" aria-label={t('debugExtras.memory.title', { reference: parsed?.memoryReference ?? '' })}>
		{#each rows as row (row.offset)}
			<div class="flex h-[19px] items-center gap-4 whitespace-pre" role="row">
				<span class="w-[130px] shrink-0 text-(--vscode-editorLineNumber-foreground)">{row.address}</span>
				<span class="flex shrink-0 gap-[6px]">
					{#each row.bytes as b, i (i)}
						{@const offset = row.offset + i}
						{#if editing?.offset === offset}
							<!-- svelte-ignore a11y_autofocus -->
							<input
								autofocus
								class="w-[5ch] border border-(--vscode-focusBorder) bg-(--vscode-input-background) px-0.5 text-(--vscode-input-foreground) outline-none"
								aria-label={t('debugExtras.memory.edit', { address: row.address })}
								bind:value={editing.value}
								onkeydown={(e) => (e.key === 'Enter' ? void commit() : e.key === 'Escape' && (editing = null))}
								onblur={() => (editing = null)}
							/>
						{:else}
							<button
								class={['w-[2ch] text-left', i === 8 && 'ml-[6px]', b === null ? 'text-(--vscode-descriptionForeground)' : 'hover:bg-(--vscode-editor-selectionBackground)']}
								disabled={b === null || !support.write}
								title={support.write ? t('debugExtras.memory.editHint') : undefined}
								ondblclick={() => (editing = { offset, value: hexByte(b) })}>{hexByte(b)}</button
							>
						{/if}
					{/each}
				</span>
				<span class="shrink-0 text-(--vscode-descriptionForeground)">{asciiOf(row.bytes)}</span>
			</div>
		{/each}
	</div>
</section>
