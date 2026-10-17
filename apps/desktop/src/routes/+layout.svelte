<script lang="ts">
	import './layout.css';
	import favicon from '#lib/assets/favicon.svg';

	import { forwardWindowErrors } from '#lib/client-log.ts';

	let { children } = $props();

	$effect(() => forwardWindowErrors());
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
