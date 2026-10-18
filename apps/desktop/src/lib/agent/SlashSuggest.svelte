<script lang="ts">
	// The `/` command list above the chat input (VS Code's suggest widget for chatSubcommandLeader):
	// name, argument hint, description and where the command comes from. The Composer owns the
	// keys (↑/↓, Enter/Tab, Esc); a click picks a row.
	import { t } from '#lib/i18n/index.ts';
	import type { SlashItem, SlashSource } from './slashCommands.ts';

	let { items, active, id, onpick }: { items: SlashItem[]; active: number; id: string; onpick: (item: SlashItem) => void } = $props();

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
	<ul bind:this={list} {id} role="listbox" aria-label={t('chatInput.slash.list')} class="max-h-60 overflow-y-auto py-0.5">
		{#each items as item, i (item.name)}
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
				<span class="shrink-0 font-mono">/{item.name}</span>
				{#if item.argumentHint}<span class="shrink-0 font-mono opacity-70">{item.argumentHint}</span>{/if}
				<span class="min-w-0 flex-1 truncate text-(--vscode-descriptionForeground)" title={item.description}>{item.description}</span>
				<span class="shrink-0 text-[11px] text-(--vscode-descriptionForeground)">{SOURCE[item.source]()}</span>
			</li>
		{/each}
	</ul>
	<div class="border-t border-(--vscode-widget-border) px-2 py-0.5 text-[11px] text-(--vscode-descriptionForeground)">{t('chatInput.slash.hint')}</div>
</div>
