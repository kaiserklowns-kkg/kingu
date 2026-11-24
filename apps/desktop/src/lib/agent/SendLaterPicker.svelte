<script lang="ts">
	// When to send (VS Code 1.147's pickScheduledChatTime, sessions/browser/scheduledChatTimePicker.ts):
	// In 5 / 10 / 15 / 30 Minutes, In 1 Hour, In 24 Hours, Tomorrow Morning, then Choose Date and
	// Time..., which opens a date and time field (this device's time; a past or invalid time is refused).
	// `sendNow` adds VS Code's "Send Now" row first (Reschedule on a scheduled message).
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { laterPresets, parseLocalDateTime, toLocalDateTime } from './sendLater.ts';

	let {
		x,
		y,
		title,
		sendNow = false,
		onpick,
		onclose
	}: {
		x: number;
		y: number;
		title: string;
		sendNow?: boolean;
		/** A time (ms), or 'now' for Send Now. */
		onpick: (at: number | 'now') => void;
		onclose: () => void;
	} = $props();

	const presets = laterPresets(new Date());
	const items = $derived([
		...(sendNow ? [menuItem('now', t('sendLater.sendNow')), menuSeparator] : []),
		...presets.map((p) => menuItem(p.id, t(`sendLater.preset.${p.id}`))),
		menuSeparator,
		menuItem('custom', t('sendLater.custom'))
	]);

	let custom = $state(false);
	let value = $state(toLocalDateTime(Date.now() + 60 * 60_000));
	let error = $state('');

	/** The menu closes before it runs the picked row (PopupMenu): close the picker only when nothing was picked. */
	let menuOpen = $state(true);
	let picked = false;
	function menuClosed() {
		menuOpen = false;
		setTimeout(() => setTimeout(() => !custom && !picked && onclose()));
	}

	function run(id: string) {
		picked = true;
		if (id === 'now') return onpick('now');
		if (id === 'custom') return void (custom = true);
		const p = presets.find((x) => x.id === id);
		if (p) onpick(p.at);
	}

	function schedule() {
		const at = parseLocalDateTime(value);
		if (!at || at.getTime() <= Date.now()) return void (error = t('sendLater.invalidTime'));
		onpick(at.getTime());
	}
</script>

{#if !custom}
	{#if menuOpen}<PopupMenu {items} label={title} {x} {y} focusFirst onRun={(n) => n.type === 'item' && run(n.id)} onClose={menuClosed} />{/if}
{:else}
	<div
		class="fixed z-50 w-72 rounded-md border border-(--vscode-menu-border,var(--vscode-widget-border)) bg-(--vscode-menu-background,var(--vscode-editorWidget-background)) p-3 text-xs text-(--vscode-menu-foreground,var(--vscode-foreground)) shadow-[0_2px_8px_var(--vscode-widget-shadow)]"
		style:left="{Math.max(4, Math.min(x, (typeof window === 'undefined' ? 1200 : window.innerWidth) - 296))}px"
		style:top="{Math.max(4, y)}px"
		role="dialog"
		aria-label={t('sendLater.customTitle')}
		tabindex="-1"
		onkeydown={(e) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				onclose();
			} else if (e.key === 'Enter' && !e.isComposing) {
				e.preventDefault();
				schedule();
			}
		}}
	>
		<p class="mb-2 font-medium">{t('sendLater.customTitle')}</p>
		<label class="flex flex-col gap-1">
			<span class="text-(--vscode-descriptionForeground)">{t('sendLater.time')}</span>
			<input
				type="datetime-local"
				class="h-[26px] rounded-sm border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-1 text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
				bind:value
				oninput={() => (error = '')}
				{@attach (el) => (el as HTMLInputElement).focus()}
			/>
		</label>
		<p class="mt-1.5 text-(--vscode-descriptionForeground)">{t('sendLater.customHint')}</p>
		{#if error}<p class="mt-1.5 text-(--vscode-errorForeground)" role="alert">{error}</p>{/if}
		<div class="mt-3 flex justify-end gap-2">
			<button type="button" class="rounded-sm px-2 py-1 hover:bg-(--vscode-toolbar-hoverBackground)" onclick={onclose}>{t('common.cancel')}</button>
			<button type="button" class="rounded-sm bg-(--vscode-button-background) px-2 py-1 text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)" onclick={schedule}>{t('sendLater.schedule')}</button>
		</div>
	</div>
{/if}
