<script lang="ts" module>
	/** One row of the new-tab menu; rows sharing a `group` sit under its heading, `agent` draws the agent's mark. */
	export type NewTabItem = { id: string; label: string; keyLabel?: string; agent?: string; description?: string; group?: string };
</script>

<script lang="ts">
	// Orca's new-tab menu: a searchable popover under the tab row's "+" (New Terminal, New Browser
	// Tab, New Markdown, Open Markdown…, then the agent CLIs found on the PATH).
	import AgentIcon from '#lib/agent/AgentIcon.svelte';
	import { onMount } from 'svelte';

	let { items, x, y, onRun, onClose }: { items: NewTabItem[]; x: number; y: number; onRun: (id: string) => void; onClose: () => void } = $props();

	const WIDTH = 300;
	const left = $derived(Math.max(4, Math.min(x, (typeof window === 'undefined' ? 1200 : window.innerWidth) - WIDTH - 4)));
	let query = $state('');
	let picked = $state(0);
	let input: HTMLInputElement | undefined = $state();

	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return items.filter((i) => !q || i.label.toLowerCase().includes(q) || i.description?.toLowerCase().includes(q));
	});
	const groups = $derived.by(() => {
		const out: { title: string | undefined; rows: NewTabItem[] }[] = [];
		for (const item of shown) {
			const last = out.at(-1);
			if (!last || last.title !== item.group) out.push({ title: item.group, rows: [item] });
			else last.rows.push(item);
		}
		return out;
	});

	onMount(() => input?.focus());
	$effect(() => {
		if (picked >= shown.length) picked = Math.max(0, shown.length - 1);
	});

	function run(id: string) {
		onClose();
		onRun(id);
	}
	function key(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') (e.preventDefault(), (picked = Math.min(picked + 1, shown.length - 1)));
		else if (e.key === 'ArrowUp') (e.preventDefault(), (picked = Math.max(picked - 1, 0)));
		else if (e.key === 'Enter' && shown[picked]) (e.preventDefault(), run(shown[picked].id));
		else if (e.key === 'Escape') (e.preventDefault(), onClose());
	}
</script>

<svelte:window onblur={onClose} />

<div class="fixed inset-0 z-40" role="presentation" data-tauri-drag-region="false" onpointerdown={onClose} oncontextmenu={(e) => (e.preventDefault(), onClose())}></div>
<div
	class="fixed z-50 rounded-lg border border-[color:var(--vscode-menu-border,#454545)] bg-[var(--vscode-menu-background,#1F1F1F)] p-1 text-[13px] text-[color:var(--vscode-menu-foreground,#CCCCCC)] shadow-xl shadow-black/40"
	style:left="{left}px"
	style:top="{y}px"
	style:width="{WIDTH}px"
	role="dialog"
	aria-label="New Tab"
	data-tauri-drag-region="false"
>
	<input
		bind:this={input}
		bind:value={query}
		onkeydown={key}
		class="mb-1 h-7 w-full rounded-md border border-[color:var(--vscode-input-border,transparent)] bg-(--vscode-input-background) px-2 text-[13px] text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground) focus:border-(--vscode-focusBorder)"
		placeholder="Search tabs, files, agents"
		aria-label="Search"
	/>
	<div role="menu" aria-label="New Tab" class="max-h-80 overflow-y-auto">
		{#each groups as g, gi (gi)}
			{#if g.title}<div class="px-2 pt-2 pb-1 text-[11px] text-(--vscode-descriptionForeground)">{g.title}</div>{/if}
			{#each g.rows as item (item.id)}
				{@const i = shown.indexOf(item)}
				<button
					role="menuitem"
					class={['flex h-[28px] w-full items-center gap-2 rounded-md px-2 text-left', i === picked ? 'bg-[var(--vscode-menu-selectionBackground,#0078D4)] text-[color:var(--vscode-menu-selectionForeground,#FFFFFF)]' : 'hover:bg-[var(--vscode-menu-selectionBackground,#0078D4)] hover:text-[color:var(--vscode-menu-selectionForeground,#FFFFFF)]']}
					onpointerenter={() => (picked = i)}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => run(item.id)}
				>
					<span class="grid w-4 shrink-0 place-items-center">{#if item.agent}<AgentIcon agent={item.agent} size={14} />{/if}</span>
					<span class="min-w-0 flex-1 truncate">{item.label}</span>
					{#if item.keyLabel}<span class="shrink-0 text-xs opacity-80">{item.keyLabel}</span>{/if}
				</button>
			{/each}
		{/each}
		{#if !shown.length}<p class="px-2 py-3 text-xs text-(--vscode-descriptionForeground)">No matches</p>{/if}
	</div>
</div>
