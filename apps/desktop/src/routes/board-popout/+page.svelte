<script lang="ts">
	// The task board's pop-out window (windows.rs opens it at this route): only the board, never
	// the workbench, so it starts no workspace, watchers or terminals.
	import BoardPopoutWindow from '#lib/ade/BoardPopoutWindow.svelte';
</script>

<BoardPopoutWindow />
