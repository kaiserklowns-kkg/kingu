// Page parts the floating workspace toggle must never cover, such as the chat composer and its Send
// button (Orca's floating-terminal-trigger-keep-clear.ts). The button gets out of their way by
// showing just below or above them (floating.ts keepButtonClear), so pages never reserve space for it.
//   <div {@attach keepFloatingToggleClear()}>      a box to keep clear while it is mounted
//   keepClear.rects                                 their boxes, for the toggle to avoid

import { untrack } from 'svelte';
import type { KeepClearRect } from './floating';

type Registration = {
	/** The column the element sits in, whose bottom bounds where the button may go below it. */
	column: HTMLElement | null;
	/** Watches `column` instead, when the element's column changes. */
	watch: (column: HTMLElement | null) => void;
};

const elements = new Map<HTMLElement, Registration>();
/** The last measured boxes, read without subscribing: measuring runs inside the marked element's attachment. */
let current: readonly KeepClearRect[] = [];

class KeepClear {
	rects = $state.raw<readonly KeepClearRect[]>([]);
}
export const keepClear = new KeepClear();

function measure() {
	const next: KeepClearRect[] = [];
	for (const [element, registration] of elements) {
		const { left, top, right, bottom } = element.getBoundingClientRect();
		// A hidden page's box measures empty and has nothing to keep clear.
		if (right > left && bottom > top) {
			// Resolved again each time: a wrapper hidden at registration lays nothing out once shown.
			const column = layoutParentOf(element);
			if (column !== registration.column) registration.watch(column);
			const paneBottom = column?.getBoundingClientRect().bottom ?? window.innerHeight;
			next.push({ left, top, right, bottom, paneBottom });
		}
	}
	const rects = current;
	const same =
		next.length === rects.length &&
		next.every((r, i) => r.left === rects[i].left && r.top === rects[i].top && r.right === rects[i].right && r.bottom === rects[i].bottom && r.paneBottom === rects[i].paneBottom);
	if (same) return;
	current = next;
	keepClear.rects = next;
}

/** The element that lays `element` out: past `display: contents` wrappers, which have no box to watch. */
function layoutParentOf(element: HTMLElement): HTMLElement | null {
	let parent = element.parentElement;
	while (parent && getComputedStyle(parent).display === 'contents') parent = parent.parentElement;
	return parent;
}

function keepClearOf(element: HTMLElement): () => void {
	if (elements.size === 0) window.addEventListener('resize', measure);
	// The element also moves without resizing when a box above it in its column grows, so the
	// column and every box in it are watched, including boxes added later.
	const resized = new ResizeObserver(measure);
	const added = new MutationObserver(() => {
		registration.watch(registration.column);
		measure();
	});
	const registration: Registration = {
		column: null,
		watch: (column) => {
			registration.column = column;
			resized.disconnect();
			added.disconnect();
			resized.observe(element);
			if (column) {
				for (const box of [column, ...column.children]) resized.observe(box);
				added.observe(column, { childList: true });
			}
		}
	};
	registration.watch(layoutParentOf(element));
	elements.set(element, registration);
	measure();
	return () => {
		resized.disconnect();
		added.disconnect();
		elements.delete(element);
		if (elements.size === 0) window.removeEventListener('resize', measure);
		measure();
	};
}

/** Keeps the floating workspace toggle off the element while it is mounted (and `enabled`). */
export function keepFloatingToggleClear(enabled = true) {
	return (element: HTMLElement) => (enabled ? untrack(() => keepClearOf(element)) : undefined);
}
