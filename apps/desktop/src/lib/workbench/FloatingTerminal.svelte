<script lang="ts">
	// Orca's floating terminal: drag the title bar to move, the corner to resize.
	import Terminal from '#lib/terminal/Terminal.svelte';
	import Icon from './Icon.svelte';
	import { floating } from './floating.svelte';

	let drag: { mode: 'move' | 'size'; px: number; py: number; start: typeof floating.rect } | null = null;

	function down(e: PointerEvent, mode: 'move' | 'size') {
		if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
		drag = { mode, px: e.clientX, py: e.clientY, start: { ...floating.rect } };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function move(e: PointerEvent) {
		if (!drag) return;
		const dx = e.clientX - drag.px;
		const dy = e.clientY - drag.py;
		const s = drag.start;
		floating.move(drag.mode === 'move' ? { ...s, x: s.x + dx, y: s.y + dy } : { ...s, w: s.w + dx, h: s.h + dy });
	}
	const up = () => (drag = null);

	const BTN = 'grid size-6 place-items-center rounded-md text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)';
</script>

<svelte:window onresize={() => floating.move(floating.rect)} />

{#if floating.alive}
	<section
		aria-label="Floating terminal"
		class={['fixed z-40 flex flex-col overflow-hidden rounded-xl border border-(--vscode-widget-border) bg-(--vscode-terminal-background,var(--vscode-panel-background)) shadow-2xl shadow-black/50', !floating.visible && 'pointer-events-none invisible']}
		style:left="{floating.rect.x}px"
		style:top="{floating.rect.y}px"
		style:width="{floating.rect.w}px"
		style:height="{floating.rect.h}px"
	>
		<!-- Dragging only moves the panel; its buttons and the terminal stay keyboard-reachable. -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<header
			class="flex h-8 shrink-0 cursor-grab items-center gap-1.5 border-b border-(--vscode-widget-border) bg-(--vscode-editorGroupHeader-tabsBackground) pr-1 pl-3 text-xs text-(--vscode-descriptionForeground) select-none active:cursor-grabbing"
			onpointerdown={(e) => down(e, 'move')}
			onpointermove={move}
			onpointerup={up}
		>
			<Icon name="terminal" size={13} />
			<span class="flex-1">Terminal</span>
			<button class={BTN} aria-label="ซ่อน (shell ยังทำงานต่อ)" title="ซ่อน — shell ยังทำงานต่อ" onclick={() => (floating.visible = false)}><Icon name="minus" size={14} /></button>
			<button class={BTN} aria-label="ปิด terminal" title="ปิด terminal" onclick={() => floating.close()}><Icon name="close" size={14} /></button>
		</header>
		<div class="relative min-h-0 flex-1">
			<div class="absolute inset-0">{#key floating.session}<Terminal />{/key}</div>
		</div>
		<!-- Resize grip -->
		<div
			class="absolute right-0 bottom-0 size-4 cursor-nwse-resize"
			role="presentation"
			onpointerdown={(e) => down(e, 'size')}
			onpointermove={move}
			onpointerup={up}
		></div>
	</section>
{/if}
