<script lang="ts">
	// The status bar's bell (VS Code's notifications bell): an unread dot, the Do Not Disturb icon,
	// and a click that shows or hides the notification center (NotificationToasts.svelte).
	import Icon from './Icon.svelte';
	import { notifications } from './notifications.svelte';

	const label = $derived(notifications.doNotDisturb ? 'การแจ้งเตือน: ห้ามรบกวน (Do Not Disturb)' : notifications.unread ? `การแจ้งเตือน: ใหม่ ${notifications.unread} รายการ` : 'การแจ้งเตือน (No Notifications)');
</script>

<button
	class="relative flex h-full items-center px-2 hover:bg-(--vscode-toolbar-hoverBackground) aria-expanded:bg-(--vscode-toolbar-hoverBackground)"
	aria-expanded={notifications.centerVisible}
	aria-label={label}
	title={label}
	onclick={() => notifications.toggleCenter()}
>
	<Icon name={notifications.doNotDisturb ? 'bellSlash' : 'bell'} size={14} />
	{#if notifications.unread && !notifications.doNotDisturb}<span class="absolute top-[3px] right-[5px] size-1.5 rounded-full bg-(--vscode-activityBarBadge-background)"></span>{/if}
</button>
