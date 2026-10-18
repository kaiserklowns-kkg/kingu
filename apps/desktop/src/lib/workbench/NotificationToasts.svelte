<script lang="ts">
	// Toasts and the notifications center (VS Code: notificationsToasts.ts, notificationsCenter.ts),
	// 450px wide, in the corner `workbench.notifications.position` names (bottom-right above the
	// status bar by default, bottom-left, or top-right below the title bar).
	import Icon, { type IconName } from './Icon.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { notificationsCorner } from './workbenchOptions';
	import { notifications, type NotificationItem } from './notifications.svelte';
	import { progressPercent } from './notificationsModel';

	const ICON: Record<NotificationItem['severity'], { name: IconName; color: string }> = {
		info: { name: 'info', color: 'var(--vscode-notificationsInfoIcon-foreground, #3794ff)' },
		warning: { name: 'warning', color: 'var(--vscode-notificationsWarningIcon-foreground, #cca700)' },
		error: { name: 'error', color: 'var(--vscode-notificationsErrorIcon-foreground, #f14c4c)' }
	};
	const BUTTON = 'h-[22px] rounded-md px-2 text-xs';
	const corner = $derived(notificationsCorner(settings.get<string>('workbench.notifications.position')));
	const TOOL = 'grid size-6 shrink-0 place-items-center rounded-md text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)';
	// The UI's popover look (StatusPopover / the old toasts): rounded, quick-input background, soft shadow.
	const FRAME = 'pointer-events-auto overflow-hidden rounded-lg border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) text-[13px] text-(--vscode-foreground) shadow-xl shadow-black/40';
</script>

{#snippet row(n: NotificationItem, inToast: boolean)}
	{@const pct = progressPercent(n.progress)}
	<div
		role={n.severity === 'error' ? 'alert' : 'status'}
		class="group relative flex flex-col gap-1.5 px-3 py-2.5"
		onmouseenter={() => inToast && notifications.hold(n.id, true)}
		onmouseleave={() => inToast && notifications.hold(n.id, false)}
		onfocusin={() => inToast && notifications.hold(n.id, true)}
		onfocusout={() => inToast && notifications.hold(n.id, false)}
	>
		<div class="flex items-start gap-2.5">
			<span class="mt-0.5 flex shrink-0" style:color={ICON[n.severity].color}><Icon name={ICON[n.severity].name} size={16} /></span>
			<p class={['kg-selectable min-w-0 flex-1 leading-snug break-words whitespace-pre-wrap', !n.expanded && 'line-clamp-3']}>{n.message}</p>
			<div class="flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
				{#if n.message.length > 120 || n.message.includes('\n')}
					<button class={TOOL} aria-label={n.expanded ? 'ย่อ (Collapse)' : 'ขยาย (Expand)'} title={n.expanded ? 'Collapse' : 'Expand'} onclick={() => notifications.toggleExpanded(n.id)}>
						<Icon name={n.expanded ? 'chevronDown' : 'chevronUp'} size={14} />
					</button>
				{/if}
				<button class={TOOL} aria-label="ปิดการแจ้งเตือน (Clear Notification)" title="Clear Notification" onclick={() => notifications.close(n.id)}><Icon name="close" size={14} /></button>
			</div>
		</div>
		{#if n.source || n.actions.length}
			<div class="flex items-center gap-2 pl-[26px]">
				{#if n.source}<span class="min-w-0 flex-1 truncate text-xs text-(--vscode-descriptionForeground)">ที่มา (Source): {n.source}</span>{:else}<span class="flex-1"></span>{/if}
				{#each n.actions as action, i (i)}
					<button
						class={[
							BUTTON,
							i === 0
								? 'bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-[var(--vscode-button-hoverBackground,#026EC1)]'
								: 'bg-[var(--vscode-button-secondaryBackground,#3a3d41)] text-[color:var(--vscode-button-secondaryForeground,#ffffff)] hover:bg-[var(--vscode-button-secondaryHoverBackground,#45494e)]'
						]}
						onclick={() => notifications.runAction(n.id, action)}>{action.label}</button
					>
				{/each}
			</div>
		{/if}
		{#if n.progress && !n.progress.done}
			<div class="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden" aria-hidden="true">
				{#if pct === null}<div class="kg-progress-infinite h-full w-1/5 bg-(--vscode-progressBar-background)"></div>
				{:else}<div class="h-full bg-(--vscode-progressBar-background) transition-[width]" style:width="{pct}%"></div>{/if}
			</div>
		{/if}
	</div>
{/snippet}

<div
	class={[
		'pointer-events-none fixed z-40 flex w-[min(380px,calc(100vw-24px))] flex-col items-stretch gap-2',
		corner.left ? 'left-3' : 'right-3',
		corner.top ? 'top-[calc(var(--kg-titlebar-height)+8px)]' : 'bottom-[calc(var(--kg-statusbar-height)+8px)]'
	]}
>
	{#if notifications.centerVisible}
		<section
			aria-label="Notifications"
			class={[FRAME, 'flex max-h-[min(500px,60vh)] flex-col']}
		>
			<header class="flex h-9 shrink-0 items-center gap-1 border-b border-(--vscode-widget-border) pr-1.5 pl-3">
				<span class="flex-1 font-medium">การแจ้งเตือน</span>
				<button class={TOOL} aria-label="ล้างทั้งหมด (Clear All Notifications)" title="Clear All Notifications" onclick={() => notifications.clearAll()}><Icon name="clearAll" size={14} /></button>
				<button
					class={TOOL}
					aria-pressed={notifications.doNotDisturb}
					aria-label="ห้ามรบกวน (Toggle Do Not Disturb Mode)"
					title="Toggle Do Not Disturb Mode"
					onclick={() => notifications.setDoNotDisturb(!notifications.doNotDisturb)}><Icon name={notifications.doNotDisturb ? 'bellSlash' : 'bell'} size={14} /></button
				>
				<button class={TOOL} aria-label="ซ่อน (Hide Notifications)" title="Hide Notifications" onclick={() => notifications.toggleCenter(false)}><Icon name="chevronDown" size={14} /></button>
			</header>
			<div class="min-h-0 flex-1 overflow-y-auto py-1">
				{#each notifications.items as n (n.id)}
					<div class="hover:bg-(--vscode-list-hoverBackground)">{@render row(n, false)}</div>
				{:else}
					<p class="px-3 py-6 text-center text-xs text-(--vscode-descriptionForeground)">ไม่มีการแจ้งเตือนใหม่</p>
				{/each}
			</div>
		</section>
	{:else}
		{#each notifications.toasts as n (n.id)}
			<div class="kg-toast {FRAME}">
				{@render row(n, true)}
			</div>
		{/each}
	{/if}
</div>

<style>
	.kg-toast {
		animation: kg-toast-in 180ms ease-out;
	}
	@keyframes kg-toast-in {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}
	.kg-progress-infinite {
		animation: kg-progress 1.5s linear infinite;
	}
	@keyframes kg-progress {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(500%);
		}
	}
</style>
