<script lang="ts">
	// The history list's search box and filter menu (VS Code's agent sessions filter): text matches
	// chat titles here and transcripts in Rust (chatHistory.hitsFor), the menu keeps only a status,
	// one agent, or chats that edited files. The state is `chatHistory.filter`.
	import { onMount } from 'svelte';
	import Codicon from '#lib/workbench/Codicon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { t } from '#lib/i18n/index.ts';
	import { chats } from './chats.svelte.ts';
	import { chatHistory, STATUS_KEY } from './chatHistory.svelte.ts';
	import { HISTORY_STATUSES, isFiltered, NO_FILTER, type HistoryStatus } from './chatHistory.ts';
	import { runtimeOf } from './runtimes.ts';

	let menuAt = $state<{ x: number; y: number; keyboard: boolean } | null>(null);
	const f = $derived(chatHistory.filter);
	const runtimes = $derived([...new Set(chats.list.map((c) => runtimeOf(c)))].sort());
	const menuOn = $derived(f.status !== null || f.runtime !== null || f.edits);

	onMount(() => void chatHistory.loadEdited());

	const menu = $derived.by<MenuNode[]>(() => [
		...HISTORY_STATUSES.map((s) => menuItem(`status:${s}`, t(STATUS_KEY[s]), { checked: f.status === s })),
		menuSeparator,
		...runtimes.map((r) => menuItem(`runtime:${r}`, chatHistory.runtimeName(r), { checked: f.runtime === r, agent: r })),
		...(runtimes.length ? [menuSeparator] : []),
		menuItem('edits', t('chatHistory.filter.edits'), { checked: f.edits }),
		menuSeparator,
		menuItem('clear', t('chatHistory.filter.clear'), { enabled: isFiltered(f) })
	]);

	function run(id: string) {
		const cur = chatHistory.filter;
		if (id.startsWith('status:')) {
			const s = id.slice(7) as HistoryStatus;
			chatHistory.filter = { ...cur, status: cur.status === s ? null : s };
		} else if (id.startsWith('runtime:')) {
			const r = id.slice(8);
			chatHistory.filter = { ...cur, runtime: cur.runtime === r ? null : r };
		} else if (id === 'edits') chatHistory.filter = { ...cur, edits: !cur.edits };
		else if (id === 'clear') chatHistory.filter = { ...NO_FILTER };
	}
</script>

<div class="flex shrink-0 items-center gap-1 px-2 pt-1.5 pb-1">
	<div class="flex h-[24px] min-w-0 flex-1 items-center gap-1 rounded-sm border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) px-1.5 focus-within:border-(--vscode-focusBorder)">
		<span class="shrink-0 text-(--vscode-descriptionForeground)"><Codicon id="search" size={12} /></span>
		<input
			class="min-w-0 flex-1 bg-transparent text-[13px] text-(--vscode-input-foreground) outline-none"
			placeholder={t('chatHistory.search')}
			aria-label={t('chatHistory.search')}
			value={f.query}
			oninput={(e) => (chatHistory.filter = { ...chatHistory.filter, query: e.currentTarget.value })}
			onkeydown={(e) => e.key === 'Escape' && f.query && (e.stopPropagation(), (chatHistory.filter = { ...chatHistory.filter, query: '' }))}
		/>
		{#if f.query}
			<button class="grid size-[18px] shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={t('chatHistory.filter.clear')} onclick={() => (chatHistory.filter = { ...chatHistory.filter, query: '' })}><Codicon id="close" size={11} /></button>
		{/if}
	</div>
	<button
		class={['grid size-[22px] shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)', menuOn && 'bg-(--vscode-toolbar-activeBackground) text-(--vscode-textLink-foreground)']}
		aria-label={t('chatHistory.filter.title')}
		title={t('chatHistory.filter.title')}
		aria-haspopup="menu"
		aria-expanded={menuAt !== null}
		onclick={(e) => {
			const r = e.currentTarget.getBoundingClientRect();
			menuAt = { x: r.right - 220, y: r.bottom + 2, keyboard: e.detail === 0 };
		}}><Codicon id="filter" size={14} /></button
	>
</div>
{#if menuAt}
	<PopupMenu items={menu} label={t('chatHistory.filter.title')} x={menuAt.x} y={menuAt.y} focusFirst={menuAt.keyboard} onRun={(n) => n.type === 'item' && run(n.id)} onClose={() => (menuAt = null)} />
{/if}
