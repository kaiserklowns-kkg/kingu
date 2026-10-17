<script lang="ts">
	import { onMount } from 'svelte';
	import { Channel, invoke } from '@tauri-apps/api/core';
	import { Terminal } from '@xterm/xterm';
	import { FitAddon } from '@xterm/addon-fit';
	import '@xterm/xterm/css/xterm.css';

	let host: HTMLDivElement;

	onMount(() => {
		const term = new Terminal({
			fontFamily: "Menlo, Monaco, 'Courier New', 'IBM Plex Sans Thai', monospace",
			fontSize: 12,
			lineHeight: 1.2,
			cursorBlink: true,
			// VS Code Dark Modern: terminal background follows the panel.
			theme: { background: '#181818', foreground: '#CCCCCC' }
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);
		fit.fit();

		let id: number | undefined;
		const onData = new Channel<string>();
		onData.onmessage = (chunk) => term.write(chunk);

		invoke<number>('pty_spawn', { cols: term.cols, rows: term.rows, onData })
			.then((v) => (id = v))
			.catch((e) => term.write(`\r\nเปิด terminal ไม่ได้: ${e}\r\n`));

		const input = term.onData((data) => {
			if (id !== undefined) invoke('pty_write', { id, data });
		});
		const resized = term.onResize(({ cols, rows }) => {
			if (id !== undefined) invoke('pty_resize', { id, cols, rows });
		});
		const observer = new ResizeObserver(() => fit.fit());
		observer.observe(host);

		return () => {
			observer.disconnect();
			input.dispose();
			resized.dispose();
			if (id !== undefined) invoke('pty_kill', { id });
			term.dispose();
		};
	});
</script>

<div bind:this={host} class="h-full w-full px-2 pt-1"></div>
