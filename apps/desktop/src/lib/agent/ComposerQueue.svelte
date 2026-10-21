<script lang="ts">
	// The queued messages on top of the chat composer (Cursor's queue): "N Queued", folding, and a
	// row per message, sent in this order when the turn ends. On hover a row offers Edit (back into
	// the input, then into its place again), Send Now (steers the running turn, or stops it first
	// where the runtime cannot steer), Remove, and ⋯ with the other way to send and Move Up / Down.
	// Rows can also be dragged into another order.
	import Icon from '#lib/workbench/Icon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import { t } from '#lib/i18n/index.ts';
	import type { QueuedMessage } from './chats.svelte.ts';

	let {
		items,
		steer,
		onedit,
		onsend,
		onremove,
		onmove
	}: {
		items: QueuedMessage[];
		/** The runtime can take a message mid-turn: Send Now steers. */
		steer: boolean;
		onedit: (n: number) => void;
		onsend: (n: number, how: 'steer' | 'stop') => void;
		onremove: (n: number) => void;
		onmove: (n: number, index: number) => void;
	} = $props();

	let open = $state(true);
	let menu = $state<{ n: number; x: number; y: number; keyboard: boolean } | null>(null);
	let dragging = $state<number | null>(null);
	let dropAt = $state<number | null>(null);

	const primary = $derived<'steer' | 'stop'>(steer ? 'steer' : 'stop');

	function openMenu(e: MouseEvent, n: number) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		menu = { n, x: r.right - 248, y: Math.max(4, r.top - 4 * 26 - 20), keyboard: e.detail === 0 };
	}

	const menuItems = $derived.by(() => {
		if (!menu) return [];
		const i = items.findIndex((q) => q.n === menu!.n);
		const move = [menuItem('up', t('composer.queue.moveUp'), { enabled: i > 0 }), menuItem('down', t('composer.queue.moveDown'), { enabled: i >= 0 && i < items.length - 1 })];
		// With steering, Send Now steers and the menu offers the other way: stop the turn, then send.
		return steer ? [menuItem('stop', t('composer.queue.interrupt')), menuSeparator, ...move] : move;
	});

	function runMenu(id: string) {
		if (!menu) return;
		const n = menu.n;
		const i = items.findIndex((q) => q.n === n);
		if (id === 'stop') onsend(n, 'stop');
		else if (id === 'up') onmove(n, i - 1);
		else if (id === 'down') onmove(n, i + 1);
	}

	function ondrop(e: DragEvent, index: number) {
		e.preventDefault();
		if (dragging !== null) {
			const from = items.findIndex((q) => q.n === dragging);
			onmove(dragging, from < index ? index - 1 : index);
		}
		dragging = null;
		dropAt = null;
	}

	const ICON = 'grid size-5 shrink-0 place-items-center rounded text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)';
</script>

{#if items.length}
	<div class="text-xs" role="region" aria-label={t('composer.queue.title', { count: items.length })}>
		<button class="flex h-[26px] w-full items-center gap-1 pr-1 pl-1.5 text-left text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)" aria-expanded={open} onclick={() => (open = !open)}>
			<Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
			{t('composer.queue.title', { count: items.length })}
		</button>
		{#if open}
			<ul class="space-y-px px-1 pb-1" aria-label={t('chatView.queued')}>
				{#each items as q, i (q.n)}
					<li
						class={[
							'group/q relative flex min-h-[22px] items-center gap-2 rounded py-px pr-0.5 pl-1 hover:bg-(--vscode-list-hoverBackground)',
							dragging === q.n && 'opacity-50',
							dropAt === i && 'before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded before:bg-(--vscode-focusBorder)'
						]}
						draggable="true"
						ondragstart={(e) => {
							dragging = q.n;
							e.dataTransfer?.setData('text/plain', String(q.n));
							if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
						}}
						ondragover={(e) => {
							if (dragging === null) return;
							e.preventDefault();
							const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
							dropAt = e.clientY > r.top + r.height / 2 ? i + 1 : i;
						}}
						ondrop={(e) => ondrop(e, dropAt ?? i)}
						ondragend={() => ((dragging = null), (dropAt = null))}
					>
						<span class="shrink-0 cursor-grab text-(--vscode-descriptionForeground) opacity-0 group-hover/q:opacity-100" title={t('composer.queue.drag')}><Icon name="grip" size={12} /></span>
						<span class="size-2.5 shrink-0 rounded-full border border-(--vscode-descriptionForeground)" aria-hidden="true"></span>
						<span class="min-w-0 flex-1 truncate" title={q.label}>{q.label}</span>
						<span class="flex shrink-0 items-center opacity-0 group-focus-within/q:opacity-100 group-hover/q:opacity-100">
							<button class={ICON} aria-label={t('composer.queue.edit')} title={t('composer.queue.edit')} onclick={() => onedit(q.n)}><Icon name="edit" size={12} /></button>
							<button class={ICON} aria-label={steer ? t('composer.queue.steer') : t('composer.queue.sendNow')} title={steer ? t('composer.queue.steerHint') : t('composer.queue.sendNowHint')} onclick={() => onsend(q.n, primary)}
								><Icon name="send" size={12} /></button
							>
							<button class={ICON} aria-label={t('composer.queue.remove')} title={t('composer.queue.remove')} onclick={() => onremove(q.n)}><Icon name="trash" size={12} /></button>
							<button class={ICON} aria-label={t('composer.queue.more')} title={t('composer.queue.more')} aria-haspopup="menu" onclick={(e) => openMenu(e, q.n)}><Icon name="more" size={12} /></button>
						</span>
					</li>
				{/each}
				{#if dropAt === items.length}<li class="mx-1 h-0.5 rounded bg-(--vscode-focusBorder)" role="presentation" ondragover={(e) => e.preventDefault()} ondrop={(e) => ondrop(e, items.length)}></li>{/if}
			</ul>
		{/if}
	</div>
{/if}
{#if menu}
	<PopupMenu items={menuItems} label={t('composer.queue.more')} x={menu.x} y={menu.y} focusFirst={menu.keyboard} onRun={(n) => n.type === 'item' && runMenu(n.id)} onClose={() => (menu = null)} />
{/if}
