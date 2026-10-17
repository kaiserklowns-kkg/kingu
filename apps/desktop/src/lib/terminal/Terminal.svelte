<script lang="ts">
	import { onMount } from 'svelte';
	import { Channel, invoke } from '@tauri-apps/api/core';
	import { Terminal } from '@xterm/xterm';
	import { FitAddon } from '@xterm/addon-fit';
	import '@xterm/xterm/css/xterm.css';
	import { bindTerminalSettings } from '#lib/settings/apply.svelte.ts';

	/**
	 * `slug`: start in that task's worktree instead of the folder root. `run`: a command typed into
	 * the shell once it starts (an agent CLI, a Snap task); Rust quotes every argument.
	 */
	let { slug, run }: { slug?: string; run?: string[] } = $props();
	let host: HTMLDivElement;

	onMount(() => {
		const term = new Terminal({
			fontFamily: "Menlo, Monaco, 'Courier New', 'IBM Plex Sans Thai', monospace",
			fontSize: 12,
			lineHeight: 1.2,
			cursorBlink: true,
			// Font and colors follow the settings and color theme (bindTerminalSettings); these are first-paint values.
			theme: { background: '#181818', foreground: '#CCCCCC' }
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);
		fit.fit();

		let id: number | undefined;
		const onData = new Channel<string>();
		onData.onmessage = (chunk) => term.write(chunk);

		invoke<number>('pty_spawn', { cols: term.cols, rows: term.rows, onData, slug: slug ?? null, run: run ?? null })
			.then((v) => (id = v))
			.catch((e) => term.write(`\r\nเปิด terminal ไม่ได้: ${e}\r\n`));

		const input = term.onData((data) => {
			if (id !== undefined) invoke('pty_write', { id, data });
		});
		const resized = term.onResize(({ cols, rows }) => {
			if (id !== undefined) invoke('pty_resize', { id, cols, rows });
		});
		const unbindSettings = bindTerminalSettings(term, () => fit.fit());
		const observer = new ResizeObserver(() => fit.fit());
		observer.observe(host);

		return () => {
			observer.disconnect();
			unbindSettings();
			input.dispose();
			resized.dispose();
			if (id !== undefined) invoke('pty_kill', { id });
			term.dispose();
		};
	});
</script>

<div bind:this={host} class="h-full w-full px-2 pt-1"></div>
