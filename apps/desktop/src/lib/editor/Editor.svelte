<script lang="ts">
	import { onMount } from 'svelte';
	import type * as Monaco from 'monaco-editor';
	import { clientLog } from '#lib/client-log.ts';

	let { path, value }: { path: string; value: string } = $props();

	let host: HTMLDivElement;
	let api = $state<typeof import('./monaco') | undefined>();
	let editor = $state<Monaco.editor.IStandaloneCodeEditor | undefined>();

	onMount(() => {
		let disposed = false;
		// Loaded on demand so Monaco (several MB) stays out of the first paint.
		import('./monaco').then((m) => {
			if (disposed) return;
			api = m;
			editor = m.monaco.editor.create(host, {
				theme: 'vs-dark',
				automaticLayout: true,
				fontFamily: "Menlo, 'SF Mono', 'IBM Plex Sans Thai', monospace",
				fontSize: 13,
				minimap: { enabled: true }
			});
			clientLog('info', 'editor ready');
		});
		return () => {
			disposed = true;
			editor?.getModel()?.dispose();
			editor?.dispose();
		};
	});

	$effect(() => {
		if (!editor || !api) return;
		const old = editor.getModel();
		editor.setModel(api.monaco.editor.createModel(value, api.languageFor(path)));
		old?.dispose();
		clientLog('info', `opened ${path} as ${api.languageFor(path)} (${editor.getModel()?.getLineCount()} lines)`);
	});
</script>

<div bind:this={host} class="h-full w-full"></div>
