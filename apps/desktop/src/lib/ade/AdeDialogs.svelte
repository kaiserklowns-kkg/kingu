<script lang="ts">
	// Hosts the ADE's modal forms over the whole window (create PR, remove task, compare attempts).
	import { adeDialogs } from './dialogs.svelte.ts';
	import AttemptsCompare from './AttemptsCompare.svelte';
	import PrCreateDialog from './PrCreateDialog.svelte';
	import RemoveTaskDialog from './RemoveTaskDialog.svelte';
</script>

{#if adeDialogs.current?.kind === 'pr'}
	{#key adeDialogs.current.slug}<PrCreateDialog slug={adeDialogs.current.slug} onClose={() => adeDialogs.close()} />{/key}
{:else if adeDialogs.current?.kind === 'remove'}
	{#key adeDialogs.current.slug}<RemoveTaskDialog slug={adeDialogs.current.slug} onClose={() => adeDialogs.close()} />{/key}
{:else if adeDialogs.current?.kind === 'compare'}
	{#key adeDialogs.current.group}<AttemptsCompare group={adeDialogs.current.group} onClose={() => adeDialogs.close()} />{/key}
{/if}
