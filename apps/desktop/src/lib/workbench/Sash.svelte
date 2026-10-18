<script lang="ts">
	// VS Code's sash: a `workbench.sash.size` hit area (4px) that takes no layout space (with `gap`,
	// it is the gap between framed parts), and the focus-border highlight after
	// `workbench.sash.hoverDelay` (300ms) of hovering.
	let {
		orientation,
		onDrag,
		onReset,
		gap = false
	}: {
		orientation: 'vertical' | 'horizontal';
		onDrag: (delta: number) => void;
		onReset?: () => void;
		/** Between framed parts: takes its 4px as the gap instead of overlapping the neighbours. */
		gap?: boolean;
	} = $props();

	let dragging = $state(false);
	let last = 0;

	function down(e: PointerEvent) {
		dragging = true;
		last = orientation === 'vertical' ? e.clientX : e.clientY;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function move(e: PointerEvent) {
		if (!dragging) return;
		const now = orientation === 'vertical' ? e.clientX : e.clientY;
		onDrag(now - last);
		last = now;
	}
</script>

<div
	role="separator"
	aria-orientation={orientation}
	class={[
		'sash relative z-10 shrink-0 bg-transparent',
		orientation === 'vertical' ? 'w-(--kg-sash-size) cursor-ew-resize' : 'h-(--kg-sash-size) cursor-ns-resize',
		dragging && 'active'
	]}
	style:margin-inline={!gap && orientation === 'vertical' ? 'calc(var(--kg-sash-size) / -2)' : undefined}
	style:margin-block={!gap && orientation === 'horizontal' ? 'calc(var(--kg-sash-size) / -2)' : undefined}
	onpointerdown={down}
	onpointermove={move}
	onpointerup={() => (dragging = false)}
	ondblclick={() => onReset?.()}
></div>

<style>
	.sash {
		transition: background-color 0.1s ease-out var(--kg-sash-hover-delay, 300ms);
	}
	.sash:hover,
	.sash.active {
		background-color: var(--vscode-sash-hoverBorder);
	}
</style>
