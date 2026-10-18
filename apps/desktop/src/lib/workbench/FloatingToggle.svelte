<script lang="ts">
	// The floating workspace's toggle (Orca's FloatingTerminalToggleButton): a 36px button at the
	// bottom right that can be dragged anywhere and keeps its place relative to the nearest corner,
	// or a small button in the status bar. An amber dot means new output in a hidden tab.
	// Right-click: move it to the status bar (or back), or hide the floating workspace.
	import Icon from './Icon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from './PopupMenu.svelte';
	import { floating } from './floating.svelte';
	import { BUTTON, MARGIN, TITLEBAR } from './floating';

	let { variant = 'floating' }: { variant?: 'floating' | 'status-bar' } = $props();

	const label = $derived(floating.open ? 'Minimize floating workspace' : floating.hasUnread ? 'Show floating workspace, new activity' : 'Show floating workspace');
	const tip = $derived(`${floating.open ? 'Minimize' : 'Show'} floating workspace (⌥⌘A)`);

	let drag: { px: number; py: number; left: number; top: number; moved: boolean } | null = null;
	let preview = $state<{ left: number; top: number } | null>(null);
	let swallowClick = false;
	const at = $derived(preview ?? floating.buttonAt);

	function down(e: PointerEvent) {
		if (e.button !== 0) return;
		drag = { px: e.clientX, py: e.clientY, left: floating.buttonAt.left, top: floating.buttonAt.top, moved: false };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function move(e: PointerEvent) {
		if (!drag) return;
		const dx = e.clientX - drag.px;
		const dy = e.clientY - drag.py;
		if (!drag.moved && Math.hypot(dx, dy) < 4) return;
		drag.moved = true;
		preview = {
			left: Math.min(Math.max(drag.left + dx, MARGIN), window.innerWidth - BUTTON - MARGIN),
			top: Math.min(Math.max(drag.top + dy, TITLEBAR), window.innerHeight - BUTTON - MARGIN)
		};
	}
	function up() {
		if (drag?.moved && preview) {
			floating.commitButton(preview);
			swallowClick = true;
		}
		drag = null;
		preview = null;
	}
	function click() {
		if (swallowClick) return void (swallowClick = false);
		floating.toggle();
	}

	let menu = $state<{ x: number; y: number } | null>(null);
	const items = $derived([
		variant === 'floating' ? menuItem('toStatusBar', 'Move to Status Bar') : menuItem('toFloating', 'Move to Floating Button'),
		menuSeparator,
		menuItem('hide', 'Hide Floating Workspace')
	]);
	function run(id: string) {
		if (id === 'toStatusBar') floating.setLocation('status-bar');
		else if (id === 'toFloating') floating.setLocation('floating-button');
		else if (id === 'hide') floating.disable();
	}
	const oncontextmenu = (e: MouseEvent) => (e.preventDefault(), e.stopPropagation(), (menu = { x: e.clientX, y: e.clientY }));
</script>

{#if variant === 'floating'}
	<span class="fixed z-[46]" style:left="{at.left}px" style:top="{at.top}px">
		<button
			data-floating-terminal-toggle
			aria-pressed={floating.open}
			aria-label={label}
			title={tip}
			class="relative grid size-9 cursor-grab place-items-center rounded-lg bg-(--vscode-list-inactiveSelectionBackground) text-(--vscode-foreground) shadow-[0_6px_16px_rgb(0_0_0/0.55),0_0_0_1px_rgb(255_255_255/0.22)] transition-transform hover:-translate-y-0.5 active:translate-y-0 active:cursor-grabbing"
			onpointerdown={down}
			onpointermove={move}
			onpointerup={up}
			onclick={click}
			{oncontextmenu}
		>
			<Icon name="floating" size={16} />
			{#if !floating.open && floating.hasUnread}<span aria-hidden="true" class="pointer-events-none absolute top-1 right-1 size-2 rounded-full bg-amber-500 ring-2 ring-(--vscode-list-inactiveSelectionBackground)"></span>{/if}
		</button>
	</span>
{:else}
	<button
		data-floating-terminal-toggle
		aria-pressed={floating.open}
		aria-label={label}
		title={tip}
		class="relative mx-1 grid size-5 place-items-center rounded border border-(--vscode-widget-border) bg-(--vscode-list-inactiveSelectionBackground) shadow-xs transition-colors hover:bg-(--vscode-toolbar-hoverBackground)"
		onclick={() => floating.toggle()}
		{oncontextmenu}
	>
		<Icon name="floating" size={13} />
		{#if !floating.open && floating.hasUnread}<span aria-hidden="true" class="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-amber-500 ring-1 ring-(--vscode-list-inactiveSelectionBackground)"></span>{/if}
	</button>
{/if}

{#if menu}
	<PopupMenu {items} label="Floating workspace" x={menu.x} y={Math.max(4, menu.y - 90)} onRun={(n) => n.type === 'item' && run(n.id)} onClose={() => (menu = null)} />
{/if}
