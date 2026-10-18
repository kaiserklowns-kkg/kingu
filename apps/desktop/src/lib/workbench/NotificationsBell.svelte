<script lang="ts">
	// The status bar's bell (VS Code's notification center): unread dot, and a popup listing every
	// notice with Clear All and Do Not Disturb.
	import Icon from './Icon.svelte';
	import StatusPopover from './StatusPopover.svelte';
	import { notifications } from './notifications.svelte';
	import { timeAgo } from '#lib/ade/model.ts';

	let anchor = $state<HTMLElement | null>(null);
	let open = $state(false);
	let now = $state(Date.now());

	function toggle(e: MouseEvent) {
		anchor = e.currentTarget as HTMLElement;
		open = !open;
		now = Date.now();
		if (open) notifications.markRead();
	}

	const TONE = { error: 'text-(--vscode-errorForeground)', warning: 'text-(--vscode-editorWarning-foreground)', info: 'text-(--vscode-editorInfo-foreground)' };
	const BTN = 'grid size-6 shrink-0 place-items-center rounded-md text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)';
	const label = $derived(notifications.unread ? `การแจ้งเตือน: ใหม่ ${notifications.unread} รายการ` : notifications.quiet ? 'การแจ้งเตือน: ห้ามรบกวน' : 'การแจ้งเตือน');
</script>

<button
	class="relative flex h-full items-center px-2 hover:bg-(--vscode-toolbar-hoverBackground) aria-expanded:bg-(--vscode-toolbar-hoverBackground)"
	aria-haspopup="dialog"
	aria-expanded={open}
	aria-label={label}
	title={label}
	onclick={toggle}
>
	<Icon name="bell" size={14} filled={notifications.quiet} />
	{#if notifications.unread}<span class="absolute top-[3px] right-[5px] size-1.5 rounded-full bg-(--vscode-activityBarBadge-background)"></span>{/if}
</button>

{#if open && anchor}
	<StatusPopover {anchor} label="การแจ้งเตือน" width={380} onClose={() => (open = false)}>
		<div class="flex h-9 shrink-0 items-center gap-1 border-b border-(--vscode-widget-border) pr-1.5 pl-3">
			<span class="flex-1 font-medium">การแจ้งเตือน</span>
			<button
				class={[BTN, notifications.quiet && 'text-(--vscode-textLink-foreground)']}
				aria-pressed={notifications.quiet}
				aria-label="ห้ามรบกวน"
				title={notifications.quiet ? 'ห้ามรบกวน: เปิด (ไม่เด้ง toast)' : 'ห้ามรบกวน: ปิด'}
				onclick={() => (notifications.quiet = !notifications.quiet)}
			>
				<Icon name="bell" size={14} filled={notifications.quiet} />
			</button>
			<button class={BTN} aria-label="ล้างทั้งหมด" title="ล้างทั้งหมด" disabled={!notifications.list.length} onclick={() => notifications.clear()}>
				<Icon name="trash" size={14} />
			</button>
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto py-1">
			{#each notifications.list as n (n.id)}
				<div class="group flex items-start gap-2.5 px-3 py-2 hover:bg-(--vscode-list-hoverBackground)">
					<span class={['mt-0.5 shrink-0', TONE[n.severity]]}><Icon name={n.severity} size={15} /></span>
					<div class="min-w-0 flex-1">
						<p class="kg-selectable leading-snug break-words">{n.message}</p>
						<p class="mt-0.5 text-[11px] text-(--vscode-descriptionForeground)">{timeAgo(n.at, now)}{n.count > 1 ? ` · ${n.count} ครั้ง` : ''}</p>
					</div>
					<button class="{BTN} opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label="ลบการแจ้งเตือนนี้" onclick={() => notifications.remove(n.id)}><Icon name="close" size={13} /></button>
				</div>
			{:else}
				<p class="px-3 py-6 text-center text-xs text-(--vscode-descriptionForeground)">ไม่มีการแจ้งเตือนใหม่</p>
			{/each}
		</div>
	</StatusPopover>
{/if}
