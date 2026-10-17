<script lang="ts">
	// VS Code's sash: 4px hit area, focus-border highlight after a 300ms hover.
	let {
		orientation,
		onDrag,
		onReset
	}: { orientation: 'vertical' | 'horizontal'; onDrag: (delta: number) => void; onReset?: () => void } = $props();

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
		orientation === 'vertical' ? '-mx-[2px] w-(--kg-sash-size) cursor-ew-resize' : '-my-[2px] h-(--kg-sash-size) cursor-ns-resize',
		dragging && 'active'
	]}
	onpointerdown={down}
	onpointermove={move}
	onpointerup={() => (dragging = false)}
	ondblclick={() => onReset?.()}
></div>

<style>
	.sash {
		transition: background-color 0.1s ease-out 0.3s;
	}
	.sash:hover,
	.sash.active {
		background-color: var(--vscode-sash-hoverBorder);
	}
</style>
