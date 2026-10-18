<script lang="ts">
	// Orca's PR comments in the Checks panel: the unresolved review threads, each selectable for
	// the "fix review feedback" prompt and resolvable on GitHub.
	import Icon from '#lib/workbench/Icon.svelte';
	import { botOverrides, byAudience, isBotAuthor, snippet, threadLocation, unresolvedThreads, type Audience } from './prComments.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { prStatuses } from './prStatus.svelte.ts';
	import { adeTasks } from './tasks.svelte.ts';
	import { BUTTON_SECONDARY, ICON_BUTTON } from './ui.ts';

	let { slug }: { slug: string } = $props();

	const entry = $derived(prStatuses.threads[slug]);
	// Orca's people / bots filter; kingu.pr.botAuthors marks more logins as bots.
	const bots = $derived(botOverrides(settings.get<unknown[]>('kingu.pr.botAuthors')));
	let audience = $state<Audience>('all');
	const unresolved = $derived(unresolvedThreads(entry?.list ?? []));
	const botCount = $derived(unresolved.filter((t) => isBotAuthor(t.comments[0]?.author ?? '', bots)).length);
	const open = $derived(byAudience(unresolved, audience, bots));
	const resolvedCount = $derived((entry?.list.length ?? 0) - unresolved.length);
	const busy = $derived(!!adeTasks.busy[slug]);
	/** Threads left out of the prompt; everything unresolved is in by default. */
	let skipped = $state<Record<string, boolean>>({});
	let expanded = $state<Record<string, boolean>>({});
	const selected = $derived(open.filter((t) => !skipped[t.id]));
</script>

<div class="space-y-1.5">
	<div class="flex items-center gap-1 text-[11px] font-bold text-(--vscode-descriptionForeground) uppercase">
		<span class="flex-1">คอมเมนต์รีวิว{unresolved.length ? ` (${unresolved.length})` : ''}</span>
		{#if botCount}
			<select class="rounded bg-(--vscode-dropdown-background) px-1 text-[11px] font-normal normal-case" aria-label="แสดงคอมเมนต์ของ" bind:value={audience}>
				<option value="all">ทั้งหมด</option>
				<option value="people">คน ({unresolved.length - botCount})</option>
				<option value="bots">bot ({botCount})</option>
			</select>
		{/if}
		<button class={ICON_BUTTON} aria-label="รีเฟรชคอมเมนต์" title="รีเฟรชคอมเมนต์" disabled={entry?.loading} onclick={() => prStatuses.refreshThreads(slug)}><Icon name="refresh" size={14} /></button>
	</div>
	{#if entry?.error}
		<p class="text-(--vscode-errorForeground)">{entry.error}</p>
	{:else if !entry || (entry.loading && !entry.list.length)}
		<p class="text-(--vscode-descriptionForeground)">กำลังอ่านคอมเมนต์…</p>
	{:else if !unresolved.length}
		<p class="text-(--vscode-descriptionForeground)">ไม่มีคอมเมนต์ที่ยังไม่ resolve{resolvedCount ? ` (resolve แล้ว ${resolvedCount})` : ''}</p>
	{:else}
		{#each open as t (t.id)}
			{@const root = t.comments[0]}
			{@const where = threadLocation(t)}
			<div class="rounded border border-(--vscode-widget-border) px-1.5 py-1">
				<div class="flex items-start gap-1.5">
					<input class="mt-0.5" type="checkbox" aria-label="ส่ง thread นี้ให้ agent" checked={!skipped[t.id]} onchange={(e) => (skipped[t.id] = !e.currentTarget.checked)} />
					<button class="min-w-0 flex-1 text-left" onclick={() => (expanded[t.id] = !expanded[t.id])}>
						<span class="block truncate">
							<span class="font-semibold">{root?.author ?? '?'}</span>
							{#if root && isBotAuthor(root.author, bots)}<span class="rounded border border-(--vscode-widget-border) px-1 text-[10px] text-(--vscode-descriptionForeground)">bot</span>{/if}
							{#if where}<span class="font-mono text-(--vscode-descriptionForeground)"> {where}</span>{/if}
							{#if t.outdated}<span class="text-(--vscode-editorWarning-foreground)"> outdated</span>{/if}
						</span>
						{#if !expanded[t.id]}<span class="block truncate text-(--vscode-descriptionForeground)">{snippet(root?.body ?? '')}</span>{/if}
					</button>
					<button class={ICON_BUTTON} aria-label="Resolve thread" title="Resolve บน GitHub" disabled={busy} onclick={() => adeTasks.resolveThread(slug, t.id)}><Icon name="check" size={14} /></button>
				</div>
				{#if expanded[t.id]}
					{#each t.comments as c (c.id)}
						<div class="mt-1 border-t border-(--vscode-widget-border) pt-1 pl-5">
							<a class="font-semibold hover:underline" href={c.url} target="_blank" rel="noreferrer">{c.author}</a>
							<p class="break-words whitespace-pre-wrap">{c.body}</p>
						</div>
					{/each}
				{/if}
			</div>
		{/each}
		<button class={BUTTON_SECONDARY} disabled={busy || !selected.length} title={slug ? 'ส่งคอมเมนต์ที่เลือกให้ agent ของงานนี้แก้' : 'คัดลอก prompt ไปวางให้ agent'} onclick={() => adeTasks.fixComments(slug, selected)}>
			<Icon name="send" size={12} /> {slug ? 'ให้ agent แก้ตามคอมเมนต์' : 'คัดลอก prompt แก้ตามคอมเมนต์'} ({selected.length})
		</button>
	{/if}
</div>
