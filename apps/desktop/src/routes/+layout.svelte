<script lang="ts">
	import './layout.css';
	import favicon from '#lib/assets/favicon.svg';

	import { forwardWindowErrors } from '#lib/client-log.ts';
	import { platform } from '#lib/workbench/platform.svelte.ts';

	let { children } = $props();

	$effect(() => forwardWindowErrors());
	// Per-OS CSS (fonts, title bar) keys off this; see workbench/platform.ts.
	$effect(() => {
		document.documentElement.dataset.platform = platform.current;
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
