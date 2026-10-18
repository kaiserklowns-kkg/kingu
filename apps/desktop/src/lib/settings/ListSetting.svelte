<script lang="ts">
	// The settings editor's list widget (VS Code: ListSettingWidget / ObjectSettingWidget) for
	// array settings (`editor.rulers`) and map settings (`files.exclude`, `terminal.integrated.env.osx`).
	import Icon from '#lib/workbench/Icon.svelte';
	import type { SettingSchema } from './registry';

	type ListSchema = Extract<SettingSchema, { type: 'array' } | { type: 'object' }>;
	let { schema, value, disabled = false, onchange }: { schema: ListSchema; value: unknown; disabled?: boolean; onchange: (v: unknown) => void } = $props();

	let draftKey = $state('');
	let draftValue = $state('');

	const items = $derived(schema.type === 'array' && Array.isArray(value) ? (value as (string | number)[]) : []);
	const entries = $derived(schema.type === 'object' && value && typeof value === 'object' ? Object.entries(value as Record<string, boolean | string | { when: string }>) : []);
	/** A glob map (`files.exclude`): a checkbox per pattern; `boolean|when` values may be sibling clauses. */
	const patterns = $derived(schema.type === 'object' && (schema.values === 'boolean' || schema.values === 'boolean|when'));

	/** A typed object value: `true`/`false` become booleans where the schema allows them. */
	function parseValue(text: string): boolean | string {
		if (schema.type === 'object' && schema.values.includes('boolean') && (text === 'true' || text === 'false')) return text === 'true';
		return text;
	}

	function addItem() {
		const text = draftKey.trim();
		if (!text || schema.type !== 'array') return;
		const item = schema.items === 'number' ? Number(text) : text;
		if (schema.items === 'number' && !Number.isFinite(item)) return;
		if (schema.itemEnum && !schema.itemEnum.includes(text)) return;
		onchange([...items, item]);
		draftKey = '';
	}

	function addEntry() {
		const key = draftKey.trim();
		if (!key || schema.type !== 'object') return;
		const v = patterns ? true : parseValue(draftValue);
		onchange({ ...Object.fromEntries(entries), [key]: v });
		draftKey = '';
		draftValue = '';
	}

	const without = (key: string) => Object.fromEntries(entries.filter(([k]) => k !== key));
	const INPUT =
		'h-[26px] min-w-0 rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 text-[13px] text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)';
	const ROW = 'flex h-7 items-center gap-2 px-1.5 text-[13px] hover:bg-(--vscode-list-hoverBackground)';
</script>

<div class="mt-1.5 max-w-[500px]">
	{#if schema.type === 'array'}
		{#each items as item, i (i)}
			<div class={ROW}>
				<span class="flex-1 truncate font-mono">{item}</span>
				<button class="grid size-5 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="ลบ {item}" {disabled} onclick={() => onchange(items.filter((_, j) => j !== i))}>
					<Icon name="close" size={14} />
				</button>
			</div>
		{/each}
		<div class="mt-1 flex gap-2">
			{#if schema.itemEnum}
				<!-- VS Code's list widget offers the allowed values (`items.enum`, e.g. git.checkoutType). -->
				<select class={[INPUT, 'flex-1']} bind:value={draftKey} {disabled} aria-label="เพิ่มรายการ (Add Item)">
					<option value="">เลือกค่า (Select a value)</option>
					{#each schema.itemEnum.filter((v) => !items.includes(v)) as option (option)}
						<option value={option}>{option}</option>
					{/each}
				</select>
			{:else}
				<input class={[INPUT, 'flex-1']} placeholder={schema.items === 'number' ? 'เพิ่มตัวเลข (Add Item)' : 'เพิ่มรายการ (Add Item)'} bind:value={draftKey} {disabled} onkeydown={(e) => e.key === 'Enter' && addItem()} />
			{/if}
			<button class="rounded-sm bg-(--vscode-button-background) px-2 text-[13px] text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)" {disabled} onclick={addItem}>Add Item</button>
		</div>
	{:else}
		{#each entries as [key, v] (key)}
			<div class={ROW}>
				{#if patterns}
					<input type="checkbox" class="size-4 accent-(--vscode-focusBorder)" checked={v === true} {disabled} aria-label={key} onchange={(e) => onchange({ ...Object.fromEntries(entries), [key]: e.currentTarget.checked })} />
				{/if}
				<span class="flex-1 truncate font-mono">{key}</span>
				{#if typeof v === 'object' && v}<span class="truncate text-xs text-(--vscode-descriptionForeground)">when: {v.when}</span>{/if}
				{#if !patterns}
					<input class={[INPUT, 'w-40']} value={String(v)} {disabled} aria-label="ค่าของ {key}" onchange={(e) => onchange({ ...Object.fromEntries(entries), [key]: parseValue(e.currentTarget.value) })} />
				{/if}
				<button class="grid size-5 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="ลบ {key}" {disabled} onclick={() => onchange(without(key))}>
					<Icon name="close" size={14} />
				</button>
			</div>
		{/each}
		<div class="mt-1 flex gap-2">
			<input class={[INPUT, 'flex-1']} placeholder={patterns ? 'เพิ่ม pattern (Add Pattern)' : 'คีย์ (Key)'} bind:value={draftKey} {disabled} onkeydown={(e) => e.key === 'Enter' && addEntry()} />
			{#if !patterns}
				<input class={[INPUT, 'w-40']} placeholder="ค่า (Value)" bind:value={draftValue} {disabled} onkeydown={(e) => e.key === 'Enter' && addEntry()} />
			{/if}
			<button class="rounded-sm bg-(--vscode-button-background) px-2 text-[13px] text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)" {disabled} onclick={addEntry}>
				{patterns ? 'Add Pattern' : 'Add Item'}
			</button>
		</div>
	{/if}
</div>
