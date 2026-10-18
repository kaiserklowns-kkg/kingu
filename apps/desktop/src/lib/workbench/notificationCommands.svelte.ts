// Notification commands (VS Code: notificationsCommands.ts) and their context keys.

import { commands } from './commands.svelte';
import { contributeContextKeys } from './contextKeys.svelte';
import { notifications } from './notifications.svelte';

export function installNotificationCommands(): () => void {
	const unregister = [
		contributeContextKeys(() => ({
			notificationCenterVisible: notifications.centerVisible,
			notificationToastsVisible: notifications.toasts.length > 0,
			notificationFocus: !!document.activeElement?.closest('[aria-label="Notifications"]')
		})),
		commands.register({ id: 'notifications.showList', title: 'Show Notifications', category: 'Notifications', run: () => notifications.toggleCenter(true) }),
		commands.register({ id: 'notifications.hideList', title: 'Hide Notifications', category: 'Notifications', palette: false, when: () => notifications.centerVisible, run: () => notifications.toggleCenter(false) }),
		commands.register({ id: 'notifications.toggleList', title: 'Toggle Notifications', category: 'Notifications', run: () => notifications.toggleCenter() }),
		commands.register({ id: 'notifications.clearAll', title: 'Clear All Notifications', category: 'Notifications', run: () => notifications.clearAll() }),
		commands.register({
			id: 'notifications.toggleDoNotDisturbMode',
			title: 'Toggle Do Not Disturb Mode',
			category: 'Notifications',
			run: () => notifications.setDoNotDisturb(!notifications.doNotDisturb)
		}),
		// Escape hides the toasts (or the center) unless something focused wants Escape itself.
		commands.register({
			id: 'notifications.hideToasts',
			title: 'Hide Notification Toasts',
			category: 'Notifications',
			key: 'escape',
			palette: false,
			when: () => notifications.toasts.length > 0 || notifications.centerVisible,
			keyWhen: () => {
				const el = document.activeElement;
				// The editor and terminal keep Escape (cancel multi-cursor, vim…), like VS Code's lower weight here.
				return !el?.closest('.monaco-editor, .xterm, [role="dialog"], [role="menu"]') && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement);
			},
			run: () => {
				if (notifications.centerVisible) notifications.toggleCenter(false);
				else for (const t of notifications.toasts) notifications.hideToast(t.id);
			}
		})
	];
	return () => unregister.forEach((u) => u());
}
