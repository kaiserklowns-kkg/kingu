<script lang="ts">
	// The Output view's text (VS Code: OutputViewPane): the active channel, filtered by the
	// filter box, kept scrolled to the end unless auto scrolling is off. With
	// output.smartScroll.enabled scrolling up turns auto scrolling off and back to the end on.
	import { tick } from 'svelte';
	import { t } from '#lib/i18n/index.ts';
	import { output } from './output.svelte';
	import { filterLines, smartScrollLock } from './output.ts';

	let scroller: HTMLPreElement | undefined = $state();
	const all = $derived(output.lines(output.active));
	const lines = $derived(filterLines(all, output.filter));
	const placeholder = $derived(all.length ? t('output.noMatch') : t('output.empty'));

	$effect(() => {
		void lines;
		if (output.locked) return;
		void tick().then(() => scroller && (scroller.scrollTop = scroller.scrollHeight));
	});

	function onscroll() {
		if (!scroller) return;
		const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4;
		const locked = smartScrollLock(output.locked, output.smartScroll, atEnd);
		if (locked !== output.locked) output.locked = locked;
	}
</script>

<pre
	bind:this={scroller}
	{onscroll}
	aria-label={output.active}
	class="absolute inset-0 overflow-auto px-5 py-1 font-mono text-xs whitespace-pre-wrap text-(--vscode-foreground) select-text">{#if lines.length}{lines.join('\n')}{:else}<span class="text-(--vscode-descriptionForeground)">{placeholder}</span>{/if}</pre>
