// The wheel of Kingu's scrolling lists and trees (VS Code's list scrollable element options).

import { settings } from '#lib/settings/settings.svelte.ts';
import { wheelDelta } from './workbenchOptions';

/**
 * Svelte action for a scrolling list or tree: `workbench.list.mouseWheelScrollSensitivity`, and
 * `workbench.list.fastScrollSensitivity` while Alt is held (VS Code's list scrollable element).
 */
export function listWheel(node: HTMLElement) {
	const onWheel = (e: WheelEvent) => {
		if (e.ctrlKey || e.metaKey) return; // pinch and zoom gestures
		const d = wheelDelta({ x: e.deltaX, y: e.deltaY }, e.altKey, settings.get<number>('workbench.list.mouseWheelScrollSensitivity'), settings.get<number>('workbench.list.fastScrollSensitivity'));
		if (!d) return;
		e.preventDefault();
		const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? node.clientHeight : 1;
		node.scrollBy({ left: d.x * unit, top: d.y * unit, behavior: 'instant' });
	};
	node.addEventListener('wheel', onWheel, { passive: false });
	return { destroy: () => node.removeEventListener('wheel', onWheel) };
}
