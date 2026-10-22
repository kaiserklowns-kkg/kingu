<script lang="ts">
	// Styled tooltips for every `title` in the workbench (VS Code's custom hover, Orca's tooltips):
	// after a short delay on hover or keyboard focus, the title shows in a rounded box. The
	// attribute is moved aside while hovering so the native tooltip does not show twice, then
	// restored. Monaco and the terminal keep their own hovers.
	import { onMount } from 'svelte';
	import { tooltipPosition } from './tooltipPosition';

	const DELAY_MS = 450;
	/** Moving between controls within this window shows the next tooltip at once, like VS Code. */
	const WARM_MS = 600;

	let text = $state('');
	let pos = $state<{ x: number; y: number } | null>(null);
	let tip: HTMLDivElement | undefined = $state();

	let target: HTMLElement | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let hiddenAt = 0;
	/** Invalidates a queued hide when the next tooltip arms first (release → show in one tick). */
	let seq = 0;

	function release() {
		const at = ++seq;
		clearTimeout(timer);
		if (target?.dataset.kgTitle !== undefined) {
			target.setAttribute('title', target.dataset.kgTitle);
			delete target.dataset.kgTitle;
		}
		target = null;
		if (text) hiddenAt = performance.now();
		// A focusout during a component's teardown runs inside Svelte's effect, where writes are
		// forbidden; the hide itself can wait a microtask.
		queueMicrotask(() => {
			if (seq !== at) return;
			text = '';
			pos = null;
		});
	}

	function arm(el: HTMLElement) {
		if (el === target) return;
		release();
		const title = el.getAttribute('title');
		if (!title?.trim()) return;
		target = el;
		el.dataset.kgTitle = title;
		el.removeAttribute('title');
		const show = () => {
			if (target !== el || !el.isConnected) return;
			const at = ++seq;
			text = title;
			pos = { x: -9999, y: -9999 };
			requestAnimationFrame(() => {
				if (seq !== at || !tip || target !== el) return;
				const r = el.getBoundingClientRect();
				const p = tooltipPosition(r, { width: tip.offsetWidth, height: tip.offsetHeight }, window.innerWidth, window.innerHeight);
				pos = { x: p.x, y: p.y };
			});
		};
		if (performance.now() - hiddenAt < WARM_MS) show();
		else timer = setTimeout(show, DELAY_MS);
	}

	const host = (node: EventTarget | null) =>
		node instanceof Element && !node.closest('.monaco-editor, .xterm') ? node.closest<HTMLElement>('[title], [data-kg-title]') : null;

	onMount(() => {
		const over = (e: PointerEvent) => {
			const el = host(e.target);
			if (el) arm(el);
			else if (target && !(e.target instanceof Node && target.contains(e.target))) release();
		};
		const focus = (e: FocusEvent) => {
			const el = host(e.target);
			if (el && (e.target as HTMLElement).matches(':focus-visible')) arm(el);
		};
		const away = () => release();
		document.addEventListener('pointerover', over, true);
		document.addEventListener('focusin', focus, true);
		document.addEventListener('focusout', away, true);
		document.addEventListener('pointerdown', away, true);
		document.addEventListener('keydown', away, true);
		window.addEventListener('blur', away);
		document.addEventListener('scroll', away, true);
		return () => {
			clearTimeout(timer);
			if (target?.dataset.kgTitle !== undefined) {
				target.setAttribute('title', target.dataset.kgTitle);
				delete target.dataset.kgTitle;
			}
			target = null;
			document.removeEventListener('pointerover', over, true);
			document.removeEventListener('focusin', focus, true);
			document.removeEventListener('focusout', away, true);
			document.removeEventListener('pointerdown', away, true);
			document.removeEventListener('keydown', away, true);
			window.removeEventListener('blur', away);
			document.removeEventListener('scroll', away, true);
		};
	});
</script>

{#if text && pos}
	<div
		bind:this={tip}
		role="tooltip"
		class="pointer-events-none fixed z-[60] max-w-[360px] rounded-md border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) px-2 py-1 text-xs leading-snug break-words whitespace-pre-line text-(--vscode-foreground) shadow-lg shadow-black/40"
		style:left="{pos.x}px"
		style:top="{pos.y}px"
	>
		{text}
	</div>
{/if}
