<script lang="ts">
	// The `/` command list above the chat input (VS Code's suggest widget for chatSubcommandLeader):
	// name, argument hint, description and where the command comes from. The Composer owns the
	// keys (↑/↓, Enter/Tab, Esc); a click picks a row. Also the `#` / `@` context list (Add
	// Context): rows with an icon and a `tag` instead of a source, no `/` (`prefix`), keyed by `key`.
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import type { SlashSource } from './slashCommands.ts';

	/**
	 * `section`: a header drawn above the row; `drill`: picking the row opens that list in place
	 * (the `@` menu's Files & Folders) instead of attaching.
	 */
	export type SuggestItem = { name: string; description: string; argumentHint?: string; source?: SlashSource; tag?: string; key?: string; icon?: IconName; section?: string; drill?: string };

	let {
		items,
		active,
		id,
		onpick,
		prefix = '/',
		label,
		hint,
		back
	}: {
		items: SuggestItem[];
		active: number;
		id: string;
		onpick: (item: SuggestItem) => void;
		prefix?: string;
		label?: string;
		hint?: string;
		/** A drilled-in list (the `@` menu's Files & Folders): its title and the way back. */
		back?: { title: string; go: () => void };
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
		'user-skill': () => t('chatInput.slash.source.userSkill')
	};

	let list: HTMLUListElement | undefined = $state();
	// Keep the highlighted row in view while ↑/↓ walk past the edge.
	$effect(() => {
		void active;
		list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
	});
</script>

<div
	class="absolute right-0 bottom-full left-0 z-30 mb-1 overflow-hidden rounded-md border border-(--vscode-editorSuggestWidget-border,var(--vscode-widget-border)) bg-(--vscode-editorSuggestWidget-background,var(--vscode-editorWidget-background)) text-xs shadow-lg"
>
	{#if back}
		<button
			type="button"
			class="flex w-full items-center gap-1.5 border-b border-(--vscode-widget-border) px-2 py-1 text-left text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)"
			title={t('composer.mention.back')}
			onmousedown={(e) => (e.preventDefault(), back.go())}><Icon name="arrowLeft" size={12} />{back.title}</button
		>
	{/if}
	<ul bind:this={list} {id} role="listbox" aria-label={label ?? t('chatInput.slash.list')} class="max-h-60 overflow-y-auto py-0.5">
		{#each items as item, i (item.key ?? item.name)}
			{#if item.section !== undefined}
				<li role="presentation" class={['px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-(--vscode-descriptionForeground)', i > 0 && 'mt-0.5 border-t border-(--vscode-widget-border)']}>{item.section}</li>
			{/if}
			<li
				id="{id}-{i}"
				role="option"
				aria-selected={i === active}
				class={[
					'flex cursor-pointer items-baseline gap-2 px-2 py-1 text-(--vscode-editorSuggestWidget-foreground,var(--vscode-foreground))',
					i === active && 'bg-(--vscode-editorSuggestWidget-selectedBackground,var(--vscode-list-activeSelectionBackground)) text-(--vscode-editorSuggestWidget-selectedForeground,var(--vscode-list-activeSelectionForeground))'
				]}
				onmousedown={(e) => (e.preventDefault(), onpick(item))}
			>
				{#if item.icon}<span class="shrink-0 self-center"><Icon name={item.icon} size={13} /></span>{/if}
				<span class={['shrink-0', prefix && 'font-mono']}>{prefix}{item.name}</span>
				{#if item.argumentHint}<span class="shrink-0 font-mono opacity-70">{item.argumentHint}</span>{/if}
				<span class="min-w-0 flex-1 truncate text-(--vscode-descriptionForeground)" title={item.description}>{item.description}</span>
				<span class="shrink-0 text-[11px] text-(--vscode-descriptionForeground)">{item.source ? SOURCE[item.source]() : (item.tag ?? '')}</span>
				{#if item.drill}<span class="shrink-0 self-center text-(--vscode-descriptionForeground)"><Icon name="chevronRight" size={12} /></span>{/if}
			</li>
		{/each}
	</ul>
	<div class="border-t border-(--vscode-widget-border) px-2 py-0.5 text-[11px] text-(--vscode-descriptionForeground)">{hint ?? t('chatInput.slash.hint')}</div>
</div>
