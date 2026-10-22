<script lang="ts" module>
	import type { MenuNode } from './menus';

	/** A clickable row of a popup menu (`id` is handed back to `onRun`). */
	export const menuItem = (id: string, text: string, opts: { checked?: boolean; enabled?: boolean; keyLabel?: string; agent?: string } = {}): MenuNode => ({
		type: 'item',
		id,
		text,
		enabled: opts.enabled ?? true,
		...(opts.checked !== undefined ? { checked: opts.checked } : {}),
		...(opts.keyLabel ? { keyLabel: opts.keyLabel } : {}),
		...(opts.agent ? { agent: opts.agent } : {})
	});
	export const menuSeparator: MenuNode = { type: 'separator' };
</script>

<script lang="ts">
	// A context menu or dropdown at a point (title bar right-click, split button, layout menu,
	// the compact menu bar's hamburger), drawn with the menu bar's MenuList.
	import MenuList from './MenuList.svelte';

	type Props = {
		items: MenuNode[];
		label: string;
		/** Top-left corner in viewport px; kept on screen. */
		x: number;
		y: number;
		focusFirst?: boolean;
		onRun: (node: MenuNode) => void;
		onClose: () => void;
	};
	let { items, label, x, y, focusFirst = false, onRun, onClose }: Props = $props();

	const MENU_WIDTH = 248;
	const left = $derived(Math.max(4, Math.min(x, (typeof window === 'undefined' ? 1200 : window.innerWidth) - MENU_WIDTH - 4)));
	const previous = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);

	function close() {
		onClose();
		previous?.focus?.();
	}

	function run(node: MenuNode) {
		close();
		setTimeout(() => onRun(node));
	}
</script>

<svelte:window onblur={close} />

<div class="fixed inset-0 z-40" role="presentation" data-tauri-drag-region="false" onpointerdown={close} oncontextmenu={(e) => (e.preventDefault(), close())}></div>
<div class="fixed z-50" style:left="{left}px" style:top="{y}px" data-tauri-drag-region="false">
	<MenuList {items} {label} {focusFirst} onRun={run} onClose={close} />
</div>
