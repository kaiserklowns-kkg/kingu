<script lang="ts">
	// The chat's scheduled messages on top of the composer (VS Code 1.147's "Scheduled" rows under
	// the pending divider: chatListRenderer.renderScheduledRequest, scheduledChatsService's actions).
	// Each row: the message, when it sends ("Sends in 10 minutes · Today at 3:40 PM"), and on hover
	// Edit (back into the input, no longer scheduled), Send Now, Reschedule... and Cancel Schedule.
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import type { ScheduledMessage } from './sendLater.ts';
	import { exactLabel, relativeLabel } from './sendLater.svelte.ts';

	let {
		items,
		onedit,
		onsend,
		onreschedule,
		oncancel
	}: {
		items: ScheduledMessage[];
		onedit: (id: string) => void;
		onsend: (id: string) => void;
		onreschedule: (id: string, anchor: HTMLElement) => void;
		oncancel: (id: string) => void;
	} = $props();

	let open = $state(true);
	// The labels move on each minute (VS Code re-renders them every 60 s).
	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});

	const relative = (s: ScheduledMessage) => relativeLabel(s, now);
	const exact = (s: ScheduledMessage) => exactLabel(s.runAt, now);

	const ICON = 'grid size-5 shrink-0 place-items-center rounded text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)';
</script>

{#if items.length}
	<div class="text-xs" role="region" aria-label={t('sendLater.title', { count: items.length })}>
		<button class="flex h-[26px] w-full items-center gap-1 pr-1 pl-1.5 text-left text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)" aria-expanded={open} onclick={() => (open = !open)}>
			<Codicon id={open ? 'chevron-down' : 'chevron-right'} size={12} />
			{t('sendLater.title', { count: items.length })}
		</button>
		{#if open}
			<ul class="space-y-px px-1 pb-1" aria-label={t('sendLater.list')}>
				{#each items as s (s.id)}
					<li class="group/s flex min-h-[22px] items-center gap-2 rounded py-px pr-0.5 pl-1 hover:bg-(--vscode-list-hoverBackground)" data-scheduled={s.id}>
						<span class={['shrink-0', s.failed ? 'text-(--vscode-errorForeground)' : 'text-(--vscode-descriptionForeground)']} aria-hidden="true"><Codicon id={s.failed ? 'warning' : 'clock'} size={12} /></span>
						<span class="min-w-0 flex-1 truncate" title={s.label}>{s.label}</span>
						<span class="shrink-0 text-(--vscode-descriptionForeground) group-focus-within/s:hidden group-hover/s:hidden" title={exact(s)}>{relative(s)}</span>
						<span class="hidden shrink-0 items-center group-focus-within/s:flex group-hover/s:flex">
							<span class="mr-1 text-(--vscode-descriptionForeground)">{exact(s)}</span>
							<button class={ICON} aria-label={t('sendLater.edit')} title={t('sendLater.edit')} onclick={() => onedit(s.id)}><Codicon id="edit" size={12} /></button>
							<button class={ICON} aria-label={t('sendLater.sendNow')} title={t('sendLater.sendNow')} onclick={() => onsend(s.id)}><Codicon id="arrow-up-compact" size={12} /></button>
							<button class={ICON} aria-label={t('sendLater.reschedule')} title={t('sendLater.reschedule')} onclick={(e) => onreschedule(s.id, e.currentTarget as HTMLElement)}><Codicon id="clock" size={12} /></button>
							<button class={ICON} aria-label={t('sendLater.cancel')} title={t('sendLater.cancel')} onclick={() => oncancel(s.id)}><Codicon id="close" size={12} /></button>
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}
