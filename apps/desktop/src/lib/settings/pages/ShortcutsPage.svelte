<script lang="ts">
	// Settings › Keyboard Shortcuts (VS Code's keybindings editor, Orca's Shortcuts pane): every
	// command with its key, searchable by name, key or id. Double-click a row to run the command.
	import { commands, keyOf } from '#lib/workbench/commands.svelte.ts';
	import { keyLabel } from '#lib/workbench/keys.ts';
	import Icon from '#lib/workbench/Icon.svelte';
	import { systemSettings } from '../systemSettings.svelte';

	let query = $state('');
	let onlyBound = $state(true);

	const rows = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return commands.all
			.filter((c) => c.palette !== false || keyOf(c))
			.map((c) => ({ id: c.id, title: c.category ? `${c.category}: ${c.title}` : c.title, key: keyOf(c) ? keyLabel(keyOf(c)!) : '' }))
			.filter((r) => (!onlyBound || r.key) && (!q || r.title.toLowerCase().includes(q) || r.key.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)))
			.sort((a, b) => a.title.localeCompare(b.title));
	});

	function run(id: string) {
		systemSettings.close();
		void commands.run(id);
	}
</script>

<div class="flex h-full flex-col">
	<div class="mx-auto flex w-full max-w-[960px] shrink-0 items-center gap-3 px-8 pt-6 pb-3">
		<div class="flex-1">
			<h1 class="text-lg font-semibold">Keyboard Shortcuts</h1>
			<p class="mt-1 text-[13px] text-(--vscode-descriptionForeground)">{rows.length} คำสั่ง · ดับเบิลคลิกเพื่อรันคำสั่ง</p>
		</div>
		<label class="flex items-center gap-2 text-[13px] text-(--vscode-descriptionForeground)">
			<input type="checkbox" bind:checked={onlyBound} class="accent-(--vscode-focusBorder)" /> เฉพาะที่มีคีย์ลัด
		</label>
	</div>
	<div class="mx-auto w-full max-w-[960px] shrink-0 px-8 pb-3">
		<label class="relative flex items-center">
			<span class="pointer-events-none absolute left-2.5 text-(--vscode-input-placeholderForeground)"><Icon name="search" size={15} /></span>
			<!-- svelte-ignore a11y_autofocus -->
			<input bind:value={query} autofocus placeholder="ค้นหาคำสั่ง คีย์ลัด หรือ id" class="h-8 w-full rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) pr-2 pl-8 text-[13px] outline-none focus:border-(--vscode-focusBorder)" />
		</label>
	</div>
	<div class="min-h-0 flex-1 overflow-y-auto">
		<table class="mx-auto w-full max-w-[960px] border-separate border-spacing-0 px-8 text-[13px]">
			<thead class="sticky top-0 bg-(--vscode-editor-background) text-left text-xs text-(--vscode-descriptionForeground)">
				<tr>
					<th class="border-b border-(--vscode-widget-border) py-2 pl-3 font-medium">คำสั่ง</th>
					<th class="w-48 border-b border-(--vscode-widget-border) py-2 font-medium">คีย์ลัด</th>
					<th class="w-72 border-b border-(--vscode-widget-border) py-2 pr-3 font-medium">ID</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as r (r.id)}
					<tr class="group cursor-default hover:bg-(--vscode-list-hoverBackground)" ondblclick={() => run(r.id)}>
						<td class="rounded-l-md py-1.5 pl-3">{r.title}</td>
						<td class="py-1.5">
							{#if r.key}
								<span class="flex gap-1">
									{#each r.key.split(' ') as chord, i (i)}
										<kbd class="rounded-md border border-(--vscode-widget-border) bg-(--vscode-editorGroupHeader-tabsBackground) px-1.5 py-0.5 font-sans text-xs">{chord}</kbd>
									{/each}
								</span>
							{:else}<span class="text-(--vscode-descriptionForeground)">—</span>{/if}
						</td>
						<td class="truncate rounded-r-md py-1.5 pr-3 font-mono text-xs text-(--vscode-descriptionForeground)">{r.id}</td>
					</tr>
				{:else}
					<tr><td colspan="3" class="py-8 text-center text-(--vscode-descriptionForeground)">ไม่พบคำสั่งที่ตรงกับ “{query}”</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>
