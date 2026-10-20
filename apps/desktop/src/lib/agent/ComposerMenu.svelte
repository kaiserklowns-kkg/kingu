<script lang="ts">
	// A dropdown that opens above a composer control (the mode pill, the model label, the options
	// button): sections of rows with a check on the current one, an optional search field, and
	// ↑/↓ Enter Esc. The parent wraps its trigger and this in a `relative` element and shows it while open.
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { filterRows, initialActive, nextEnabled, startsSection, type MenuRow } from './composerMenu.ts';

	let {
		rows,
		label,
		search = false,
		placeholder,
		align = 'left',
		width = 260,
		footer,
		onpick,
		onclose
	}: {
		rows: MenuRow[];
		label: string;
		/** A search field on top (the model picker's "Search models"). */
		search?: boolean;
		placeholder?: string;
		align?: 'left' | 'right';
		width?: number;
		/** A note under the rows. */
		footer?: string;
		onpick: (id: string) => void;
		/** `refocus`: closed from the keyboard (Esc), so the input can take the focus back. */
		onclose: (refocus: boolean) => void;
	} = $props();

	let query = $state('');
	let wrap: HTMLDivElement | undefined = $state();
	let input: HTMLInputElement | undefined = $state();
	let list: HTMLUListElement | undefined = $state();
	const shown = $derived(filterRows(rows, query));
	let active = $state(-1);
	const listId = `cmenu-${Math.random().toString(36).slice(2, 8)}`;

	$effect(() => {
		void query;
		active = initialActive(shown);
	});
	$effect(() => {
		void active;
		list?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
	});
	$effect(() => {
		queueMicrotask(() => (search ? input : list)?.focus());
	});

	function pick(row: MenuRow | undefined) {
		if (!row || row.disabled) return;
		onpick(row.id);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.isComposing) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			active = nextEnabled(shown, active, e.key === 'ArrowDown' ? 1 : -1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			pick(shown[active]);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			onclose(true);
		} else if (e.key === 'Tab') onclose(false);
	}

	function onwindowdown(e: PointerEvent) {
		if (wrap && !wrap.parentElement?.contains(e.target as Node)) onclose(false);
	}
</script>

<svelte:window onpointerdown={onwindowdown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={wrap}
	class={[
		'absolute bottom-full z-40 mb-1.5 overflow-hidden rounded-lg border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background,var(--vscode-menu-background)) text-xs text-(--vscode-foreground) shadow-lg',
		align === 'left' ? 'left-0' : 'right-0'
	]}
	style:width="{width}px"
	style:max-width="calc(100vw - 16px)"
	{onkeydown}
>
	{#if search}
		<div class="flex items-center gap-1.5 border-b border-(--vscode-widget-border) px-2">
			<Icon name="search" size={12} />
			<input
				bind:this={input}
				bind:value={query}
				class="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-(--vscode-input-placeholderForeground)"
				placeholder={placeholder ?? t('composer.menu.search')}
				aria-label={placeholder ?? t('composer.menu.search')}
				role="combobox"
				aria-expanded="true"
				aria-controls={listId}
				aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
			/>
		</div>
	{/if}
	<ul bind:this={list} id={listId} role="listbox" aria-label={label} tabindex="-1" class="max-h-72 overflow-y-auto py-1 outline-none" aria-activedescendant={!search && active >= 0 ? `${listId}-${active}` : undefined}>
		{#each shown as row, i (row.id)}
			{#if startsSection(shown, i)}
				<li role="presentation" class={['px-2.5 pt-1.5 pb-0.5 text-[11px] font-medium text-(--vscode-descriptionForeground)', i > 0 && 'mt-1 border-t border-(--vscode-widget-border) pt-2']}>{row.section}</li>
			{/if}
			<li
				id="{listId}-{i}"
				role="option"
				aria-selected={!!row.checked}
				aria-disabled={row.disabled || undefined}
				data-active={i === active}
				class={[
					'mx-1 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1',
					i === active && 'bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)',
					row.disabled && 'cursor-default opacity-50',
					row.warn && i !== active && 'text-(--vscode-editorWarning-foreground)'
				]}
				title={row.description || row.label}
				onpointermove={() => !row.disabled && (active = i)}
				onmousedown={(e) => (e.preventDefault(), pick(row))}
			>
				{#if row.icon}<span class="shrink-0" style:color={i === active ? undefined : row.color}><Icon name={row.icon} size={13} /></span>{/if}
				<span class="flex min-w-0 flex-1 flex-col">
					<span class="truncate">{row.label}</span>
					{#if row.description}<span class={['truncate text-[11px]', i === active ? 'opacity-80' : 'text-(--vscode-descriptionForeground)']}>{row.description}</span>{/if}
				</span>
				{#if row.keyLabel}<span class="shrink-0 text-[11px] opacity-70">{row.keyLabel}</span>{/if}
				<span class={['shrink-0', !row.checked && 'invisible']}><Icon name="check" size={12} /></span>
			</li>
		{:else}
			<li class="px-2.5 py-1.5 text-(--vscode-descriptionForeground)">{t('composer.menu.none')}</li>
		{/each}
	</ul>
	{#if footer}<div class="border-t border-(--vscode-widget-border) px-2.5 py-1 text-[11px] text-(--vscode-descriptionForeground)">{footer}</div>{/if}
</div>
