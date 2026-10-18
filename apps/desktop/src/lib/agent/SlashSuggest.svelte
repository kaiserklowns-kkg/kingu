<script lang="ts">
	// The `/` command list above the chat input (VS Code's suggest widget for chatSubcommandLeader):
	// name, argument hint, description and where the command comes from. The Composer owns the
	// keys (↑/↓, Enter/Tab, Esc); a click picks a row. Also the `#` / `@` context list (Add
	// Context): rows with an icon and a `tag` instead of a source, no `/` (`prefix`), keyed by `key`.
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import type { SlashSource } from './slashCommands.ts';

	export type SuggestItem = { name: string; description: string; argumentHint?: string; source?: SlashSource; tag?: string; key?: string; icon?: IconName };

	let {
		items,
		active,
		id,
		onpick,
		prefix = '/',
		label,
		hint
	}: { items: SuggestItem[]; active: number; id: string; onpick: (item: SuggestItem) => void; prefix?: string; label?: string; hint?: string } = $props();

	const SOURCE: Record<SlashSource, () => string> = {
		kingu: () => t('chatInput.slash.source.kingu'),
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
	<ul bind:this={list} {id} role="listbox" aria-label={label ?? t('chatInput.slash.list')} class="max-h-60 overflow-y-auto py-0.5">
		{#each items as item, i (item.key ?? item.name)}
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
			</li>
		{/each}
	</ul>
	<div class="border-t border-(--vscode-widget-border) px-2 py-0.5 text-[11px] text-(--vscode-descriptionForeground)">{hint ?? t('chatInput.slash.hint')}</div>
</div>
