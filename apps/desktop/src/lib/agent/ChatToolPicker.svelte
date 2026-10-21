<script lang="ts">
	// Configure Tools (VS Code's chat tool picker): the chat's tool sets, its agent's own tools and
	// each MCP server's tools, with a check each. A group's check turns all of it on or off (mixed
	// when only some are on). OK saves the chat's off list (chatTools.apply); its next run goes
	// without those tools. An agent that picks its own tools (ACP, Codex) only gets a note.
	import { untrack } from 'svelte';
	import AdeDialog from '#lib/ade/AdeDialog.svelte';
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { chats } from './chats.svelte.ts';
	import { chatTools } from './chatTools.svelte.ts';
	import { checkOf, setTools, type Check } from './chatTools.ts';

	let { id }: { id: string } = $props();

	const meta = $derived(chats.get(id));
	const filters = $derived(chatTools.filters(id));
	const groups = $derived(chatTools.groups(id));
	// The picker is keyed by chat (Workbench.svelte), so the draft starts from that chat's list once.
	let draft = $state<string[]>(untrack(() => [...(chats.get(id)?.disabled_tools ?? [])]));
	let open = $state<Record<string, boolean>>({});
	let query = $state('');

	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return groups;
		return groups
			.map((g) => ({ ...g, rows: g.rows.filter((r) => `${r.label} ${r.description}`.toLowerCase().includes(q)) }))
			.filter((g) => g.rows.length || g.label.toLowerCase().includes(q));
	});
	const offCount = $derived(draft.length);

	function toggle(tools: string[], check: Check) {
		draft = setTools(draft, tools, check !== 'on', chatTools.servers());
	}

	function close() {
		chatTools.picking = null;
	}

	async function ok() {
		const off = draft;
		close();
		await chatTools.apply(id, off);
	}

	/** A checkbox's state for a group or row (`indeterminate` for mixed). */
	const box = (check: Check) => (el: HTMLInputElement) => {
		el.checked = check === 'on';
		el.indeterminate = check === 'mixed';
	};
</script>

<AdeDialog title={t('chatTools.title', { title: meta?.title ?? '' })} width={560} onClose={close}>
	{#if !filters}
		<p class="py-2 text-(--vscode-descriptionForeground)">{t('chatTools.ownTools')}</p>
	{:else}
		<input
			class="mb-2 h-[26px] w-full rounded-sm border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) px-2 text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
			placeholder={t('chatTools.search')}
			aria-label={t('chatTools.search')}
			data-autofocus
			bind:value={query}
		/>
		<ul class="flex flex-col" aria-label={t('chatTools.title', { title: meta?.title ?? '' })}>
			{#each shown as g (g.id)}
				{@const gc = checkOf(g.tools, draft)}
				{@const expanded = open[g.id] ?? (g.id === 'sets' || g.id === 'builtin' || !!query.trim())}
				<li>
					<div class="flex h-[26px] items-center gap-1.5 rounded px-1 hover:bg-(--vscode-list-hoverBackground)">
						<button
							class="grid size-4 shrink-0 place-items-center text-(--vscode-descriptionForeground)"
							aria-label={expanded ? t('chatTools.collapse') : t('chatTools.expand')}
							aria-expanded={expanded}
							disabled={!g.rows.length}
							onclick={() => (open = { ...open, [g.id]: !expanded })}><Codicon id={expanded ? 'chevron-down' : 'chevron-right'} size={12} /></button
						>
						<label class="flex min-w-0 flex-1 items-center gap-2">
							<input type="checkbox" {@attach box(gc)} onchange={() => toggle(g.tools, gc)} />
							<span class="truncate font-medium">{g.label}</span>
							{#if g.description}<span class="shrink-0 text-xs text-(--vscode-descriptionForeground)">{g.description}</span>{/if}
							{#if !g.rows.length && g.id.startsWith('mcp:')}<span class="truncate text-xs text-(--vscode-descriptionForeground)">{t('chatTools.mcpNotStarted')}</span>{/if}
						</label>
					</div>
					{#if expanded && g.rows.length}
						<ul class="ml-6">
							{#each g.rows as r (r.id)}
								{@const rc = checkOf(r.tools, draft)}
								<li class="flex h-[24px] items-center gap-2 rounded px-1 hover:bg-(--vscode-list-hoverBackground)">
									<label class="flex min-w-0 flex-1 items-center gap-2" title={r.description || r.label}>
										<input type="checkbox" {@attach box(rc)} onchange={() => toggle(r.tools, rc)} />
										<span class="shrink-0">{r.label}</span>
										{#if r.description}<span class="truncate text-xs text-(--vscode-descriptionForeground)">{r.description}</span>{/if}
									</label>
								</li>
							{/each}
						</ul>
					{/if}
				</li>
			{:else}
				<li class="py-2 text-(--vscode-descriptionForeground)">{t('chatTools.none')}</li>
			{/each}
		</ul>
		<p class="mt-2 text-xs text-(--vscode-descriptionForeground)">{t('chatTools.hint')}</p>
	{/if}
	{#snippet footer()}
		{#if filters}
			<span class="flex-1 text-xs text-(--vscode-descriptionForeground)">{t('chatTools.offCount', { count: offCount })}</span>
			<button class="rounded px-3 py-1 hover:bg-(--vscode-toolbar-hoverBackground)" disabled={!offCount} onclick={() => (draft = [])}>{t('chatTools.reset')}</button>
			<button class="rounded px-3 py-1 hover:bg-(--vscode-toolbar-hoverBackground)" onclick={close}>{t('common.cancel')}</button>
			<button class="rounded bg-(--vscode-button-background) px-3 py-1 text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)" onclick={() => void ok()}>{t('chatTools.ok')}</button>
		{:else}
			<button class="rounded bg-(--vscode-button-background) px-3 py-1 text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)" onclick={close}>{t('chatTools.ok')}</button>
		{/if}
	{/snippet}
</AdeDialog>
