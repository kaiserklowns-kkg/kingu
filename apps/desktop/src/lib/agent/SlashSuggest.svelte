<script lang="ts">
	// The composer's `/` and `@` menus (Cursor's). The Composer owns the keys (↑/↓, Enter/Tab,
	// Esc); a click picks a row.
	//   `/` (`kind: 'slash'`): two-line rows, a bold `/name` with its argument hint in muted text
	//   and the description below it, under section headers (Skills, Commands, …). A `more` row
	//   ("Show N more") unfolds a section. Where a command comes from is in the row's tooltip.
	//   `@` (`kind: 'mention'`): one-line rows with an icon, the name and a muted detail; › on a
	//   row that opens its own list (`drill`); a `section: ''` row draws a separator above itself.
	//   `preview` shows the highlighted file's first lines beside the menu.
	// `below`: the menu opens under the input (the composer at the top of an empty chat).
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import type { SlashSource } from './slashCommands.ts';

	/**
	 * `section`: a header drawn above the row ('' a plain separator); `drill`: picking the row
	 * opens that list in place (the `@` menu's Files & Folders) instead of attaching; `more`: the
	 * "Show N more" row of a folded section.
	 */
	export type SuggestItem = {
		name: string;
		description: string;
		argumentHint?: string;
		source?: SlashSource;
		tag?: string;
		key?: string;
		icon?: IconName;
		section?: string;
		drill?: string;
		more?: boolean;
	};

	let {
		items,
		active,
		id,
		onpick,
		kind = 'slash',
		label,
		back,
		below = false,
		preview
	}: {
		items: SuggestItem[];
		active: number;
		id: string;
		onpick: (item: SuggestItem) => void;
		kind?: 'slash' | 'mention';
		label?: string;
		/** A drilled-in list (the `@` menu's Files & Folders): its title and the way back. */
		back?: { title: string; go: () => void };
		below?: boolean;
		/** The first lines of a row's file, or null when it has none to show. */
		preview?: (item: SuggestItem) => Promise<string | null>;
	} = $props();

	const SOURCE: Record<SlashSource, () => string> = {
		kingu: () => t('chatInput.slash.source.kingu'),
		mode: () => t('composer.slash.source.mode'),
		prompt: () => t('chatCustomize.source.prompt'),
		'user-prompt': () => t('chatCustomize.source.userPrompt'),
		session: () => t('chatInput.slash.source.session'),
		project: () => t('chatInput.slash.source.project'),
		user: () => t('chatInput.slash.source.user'),
		'project-skill': () => t('chatInput.slash.source.projectSkill'),
		'user-skill': () => t('chatInput.slash.source.userSkill'),
		mcp: () => t('chatMcp.slash.source')
	};

	let box: HTMLDivElement | undefined = $state();
	let list: HTMLUListElement | undefined = $state();
	// Keep the highlighted row in view while ↑/↓ walk past the edge.
	$effect(() => {
		void active;
		list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
	});

	// The highlighted file's preview, beside the menu where there is room (else on its other side).
	let shown = $state<{ key: string; text: string } | null>(null);
	let side = $state<{ left: number; top: number; width: number } | null>(null);
	$effect(() => {
		const item = items[active];
		if (!preview || !item?.key) return void (shown = null);
		const key = item.key;
		let live = true;
		preview(item).then((text) => live && (shown = text ? { key, text } : null));
		return () => {
			live = false;
		};
	});
	$effect(() => {
		void shown;
		if (!shown || !box) return void (side = null);
		const r = box.getBoundingClientRect();
		const width = 320;
		const right = r.right + 6 + width <= window.innerWidth - 4;
		side = { left: right ? r.right + 6 : Math.max(4, r.left - 6 - width), top: Math.max(4, below ? r.top : r.bottom - 240), width };
	});
</script>

<div
	bind:this={box}
	class={[
		'absolute z-30 overflow-hidden rounded-lg border border-(--vscode-editorSuggestWidget-border,var(--vscode-widget-border)) bg-(--vscode-editorSuggestWidget-background,var(--vscode-editorWidget-background)) text-xs shadow-lg',
		below ? 'top-full mt-1' : 'bottom-full mb-1',
		kind === 'mention' ? 'left-0 w-[260px] max-w-full' : 'right-0 left-0'
	]}
>
	{#if back}
		<button
			type="button"
			class="flex w-full items-center gap-1.5 border-b border-(--vscode-widget-border) px-2 py-1 text-left text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)"
			title={t('composer.mention.back')}
			onmousedown={(e) => (e.preventDefault(), back.go())}><Icon name="arrowLeft" size={12} />{back.title}</button
		>
	{/if}
	<ul bind:this={list} {id} role="listbox" aria-label={label ?? t('chatInput.slash.list')} class="max-h-72 overflow-y-auto py-1">
		{#each items as item, i (item.key ?? item.name)}
			{#if item.section === ''}
				{#if i > 0}<li role="presentation" class="mx-2 my-1 border-t border-(--vscode-widget-border)"></li>{/if}
			{:else if item.section !== undefined}
				<li role="presentation" class={['px-2.5 pt-1.5 pb-0.5 text-[11px] font-medium text-(--vscode-descriptionForeground)', i > 0 && 'mt-1']}>{item.section}</li>
			{/if}
			<li
				id="{id}-{i}"
				role="option"
				aria-selected={i === active}
				class={[
					'mx-1 flex cursor-pointer gap-2 rounded px-1.5 text-(--vscode-editorSuggestWidget-foreground,var(--vscode-foreground))',
					kind === 'slash' && !item.more ? 'flex-col gap-0 py-1' : 'items-center py-[3px]',
					i === active && 'bg-(--vscode-editorSuggestWidget-selectedBackground,var(--vscode-list-activeSelectionBackground)) text-(--vscode-editorSuggestWidget-selectedForeground,var(--vscode-list-activeSelectionForeground))'
				]}
				title={item.source ? `${SOURCE[item.source]()}${item.description ? ` · ${item.description}` : ''}` : item.description || undefined}
				onmousedown={(e) => (e.preventDefault(), onpick(item))}
			>
				{#if item.more}
					<span class="text-(--vscode-descriptionForeground)">{item.name}</span>
				{:else if kind === 'slash'}
					<span class="flex min-w-0 items-baseline gap-1.5">
						<span class="shrink-0 font-semibold">/{item.name}</span>
						{#if item.argumentHint}<span class="min-w-0 truncate opacity-60">{item.argumentHint}</span>{/if}
					</span>
					{#if item.description}<span class="truncate text-[11px] opacity-70">{item.description}</span>{/if}
				{:else}
					{#if item.icon}<span class="shrink-0 opacity-80"><Icon name={item.icon} size={13} /></span>{/if}
					<span class="shrink-0 truncate">{item.name}</span>
					{#if item.description}<span class="min-w-0 flex-1 truncate opacity-60">{item.description}</span>{:else}<span class="flex-1"></span>{/if}
					{#if item.tag}<span class="shrink-0 text-[11px] opacity-60">{item.tag}</span>{/if}
					{#if item.drill}<span class="shrink-0 opacity-70"><Icon name="chevronRight" size={12} /></span>{/if}
				{/if}
			</li>
		{:else}
			<li class="px-2.5 py-1 text-(--vscode-descriptionForeground)">{t('composer.menu.none')}</li>
		{/each}
	</ul>
</div>
{#if shown && side}
	<pre
		class="pointer-events-none fixed z-40 max-h-60 overflow-hidden rounded-lg border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) p-2 font-mono text-[11px] leading-4 whitespace-pre text-(--vscode-foreground) shadow-lg"
		style:left="{side.left}px"
		style:top="{side.top}px"
		style:width="{side.width}px"
		aria-hidden="true">{shown.text}</pre>
{/if}
