// Opens PopupMenu at a point from plain TypeScript (a Monaco gutter right-click has no Svelte
// parent to render it in): mounted on the body, unmounted when it closes.

import { mount, unmount } from 'svelte';
import PopupMenu from './PopupMenu.svelte';
import type { MenuNode } from './menus';

export function popupMenuAt(x: number, y: number, label: string, items: MenuNode[], onRun: (id: string) => void) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	let app: ReturnType<typeof mount> | null = null;
	const close = () => {
		const a = app;
		app = null;
		// After PopupMenu's own handler is done with its elements.
		setTimeout(() => {
			if (a) void unmount(a);
			target.remove();
		});
	};
	app = mount(PopupMenu, { target, props: { items, label, x, y, focusFirst: true, onRun: (node: MenuNode) => node.type === 'item' && onRun(node.id), onClose: close } });
}
