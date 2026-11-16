<script lang="ts">
	// Orca's notification bell (docs notifications.mdx): the agent notices — done, needs you,
	// failed — newest first; unread ones bold. A click opens the task (its project first when it
	// is another one); the dot marks it read or unread again.
	import Icon from '#lib/workbench/Icon.svelte';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { agentInbox } from './agentInbox.svelte.ts';
	import { adeTasks } from './tasks.svelte';
	import { projects } from './projects.svelte';
	import { timeAgo } from './model';
	import { t } from '#lib/i18n/index.ts';

	let { navClass = '' }: { navClass?: string } = $props();
	let box: HTMLDivElement | undefined = $state();

	function open(i: (typeof agentInbox.items)[number]) {
		agentInbox.open = false;
		if (!appMode.isAgents) appMode.setMode('agents');
		if (i.root && i.root !== workspace.root) return void projects.open(i.root, i.slug);
		if (adeTasks.find(i.slug)) adeTasks.openTask(i.slug);
	}

	$effect(() => {
		if (!agentInbox.open) return;
		const away = (e: PointerEvent) => box && !box.contains(e.target as Node) && (agentInbox.open = false);
		const esc = (e: KeyboardEvent) => e.key === 'Escape' && (agentInbox.open = false);
		window.addEventListener('pointerdown', away, true);
		window.addEventListener('keydown', esc);
		return () => (window.removeEventListener('pointerdown', away, true), window.removeEventListener('keydown', esc));
	});
</script>

<div class="relative" bind:this={box}>
	<button class={navClass} aria-label={t('ade.inbox.title')} aria-expanded={agentInbox.open} onclick={() => (agentInbox.open = !agentInbox.open)}>
		<span class="text-(--vscode-sideBar-foreground)/60"><Icon name={agentInbox.unread ? 'bellDot' : 'bell'} size={16} /></span>
		<span class="flex-1 text-left">{t('ade.inbox.title')}</span>
		{#if agentInbox.unread}<span class="rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] text-(--vscode-badge-foreground) tabular-nums">{agentInbox.unread}</span>{/if}
	</button>
	{#if agentInbox.open}
		<div class="absolute top-full left-0 z-30 mt-1 w-[300px] overflow-hidden rounded-md border border-(--vscode-widget-border) bg-(--vscode-menu-background,var(--vscode-editorWidget-background)) text-xs shadow-lg shadow-black/30" role="dialog" aria-label={t('ade.inbox.title')}>
			<div class="flex items-center gap-2 border-b border-(--vscode-widget-border) px-2.5 py-1.5">
				<span class="flex-1 font-medium">{t('ade.inbox.title')}</span>
				<button class="text-(--vscode-textLink-foreground) hover:underline disabled:opacity-50" disabled={!agentInbox.unread} onclick={() => agentInbox.markAll()}>{t('ade.inbox.markAll')}</button>
				<button class="text-(--vscode-descriptionForeground) hover:underline disabled:opacity-50" disabled={!agentInbox.items.length} onclick={() => agentInbox.clear()}>{t('ade.inbox.clear')}</button>
			</div>
			<ul class="max-h-80 overflow-auto">
				{#each agentInbox.items as i (i.id)}
					<li class="flex items-start gap-1.5 px-2.5 py-1.5 hover:bg-(--vscode-list-hoverBackground)">
						<button class="mt-1 grid size-3 shrink-0 place-items-center" aria-label={i.read ? t('ade.inbox.markUnread') : t('ade.inbox.markRead')} title={i.read ? t('ade.inbox.markUnread') : t('ade.inbox.markRead')} onclick={() => agentInbox.toggle(i.id)}>
							<span class={['size-1.5 rounded-full', i.read ? 'border border-(--vscode-descriptionForeground)/50' : 'bg-(--vscode-focusBorder)']}></span>
						</button>
						<button class="min-w-0 flex-1 text-left" onclick={() => open(i)}>
							<span class={['block truncate', !i.read && 'font-semibold']}>{i.title}</span>
							<span class="block truncate text-(--vscode-descriptionForeground)">{i.body}</span>
							<span class="block text-[10px] text-(--vscode-descriptionForeground)/70">{timeAgo(i.at, adeTasks.now)}</span>
						</button>
					</li>
				{:else}
					<li class="px-2.5 py-4 text-center text-(--vscode-descriptionForeground)">{t('ade.inbox.empty')}</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
