<script lang="ts">
	// Send while a turn runs (VS Code's chatQueuePickerActionItem): a split button. The main part
	// runs the default action (`kingu.chat.requestQueuing.defaultAction`), the chevron opens Add to
	// Queue / Steer with Message / Stop and Send with the keys that run them.
	import Icon from '#lib/workbench/Icon.svelte';
	import PopupMenu, { menuItem } from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { t } from '#lib/i18n/index.ts';
	import { sendMenu, type QueueDefault, type SendHow } from './requestQueuing.ts';

	let { def, disabled = false, onsend }: { def: QueueDefault; disabled?: boolean; onsend: (how: SendHow) => void } = $props();

	const MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
	const KEY = { enter: 'Enter', altEnter: MAC ? '⌥Enter' : 'Alt+Enter' } as const;
	const LABEL: Record<SendHow, () => string> = { queue: () => t('chatInput.send.queue'), steer: () => t('chatInput.send.steer'), stop: () => t('chatInput.send.stop') };
	const HINT: Record<SendHow, () => string> = { queue: () => t('chatInput.send.queueHint'), steer: () => t('chatInput.send.steerHint'), stop: () => t('chatInput.send.stopHint') };
	/** MenuList's row height and padding: the menu opens upward from the button. */
	const ROW = 26;

	let menu = $state<{ x: number; y: number; keyboard: boolean } | null>(null);
	const rows = $derived(sendMenu(def));
	const items = $derived<MenuNode[]>(rows.map((r) => menuItem(r.how, LABEL[r.how](), { keyLabel: r.key ? KEY[r.key] : undefined })));

	function open(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		menu = { x: r.right - 248, y: Math.max(4, r.top - rows.length * ROW - 14), keyboard: e.detail === 0 };
	}
</script>

<div class="flex shrink-0 items-center overflow-hidden rounded-full bg-(--vscode-button-background) text-(--vscode-button-foreground)">
	<button
		type="button"
		class="grid h-7 w-7 place-items-center hover:opacity-90 disabled:opacity-60"
		aria-label={LABEL[def]()}
		title={`${LABEL[def]()} (${KEY.enter}) · ${HINT[def]()}`}
		{disabled}
		onclick={() => onsend(def)}><Icon name="send" size={14} /></button
	>
	<button
		type="button"
		class="grid h-7 w-4 place-items-center border-l border-(--vscode-button-foreground)/30 pr-0.5 hover:opacity-90 disabled:opacity-60"
		aria-label={t('chatInput.send.more')}
		title={t('chatInput.send.more')}
		aria-haspopup="menu"
		aria-expanded={menu !== null}
		{disabled}
		onclick={open}><Icon name="chevronDown" size={10} /></button
	>
</div>
{#if menu}
	<PopupMenu {items} label={t('chatInput.send.more')} x={menu.x} y={menu.y} focusFirst={menu.keyboard} onRun={(n) => n.type === 'item' && onsend(n.id as SendHow)} onClose={() => (menu = null)} />
{/if}
