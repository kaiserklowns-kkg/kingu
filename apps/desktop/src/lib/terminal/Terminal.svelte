<script lang="ts">
	import { onMount } from 'svelte';
	import { Channel, invoke } from '@tauri-apps/api/core';
	import { Terminal } from '@xterm/xterm';
	import { FitAddon } from '@xterm/addon-fit';
	import '@xterm/xterm/css/xterm.css';
	import { bindTerminalSettings } from '#lib/settings/apply.svelte.ts';

	/**
	 * `key`: the PTY session (sessions.ts). A live one is re-attached with its recent output
	 * replayed, so the shell outlives a webview reload; unmounting never kills it, closing the tab
	 * does (the terminal stores). `slug`: start in that task's worktree instead of the folder root.
	 * `run`: a command typed into a new shell (an agent CLI, a Snap task); Rust quotes every argument.
	 */
	let { key, slug, run, onoutput }: { key: string; slug?: string; run?: string[]; onoutput?: () => void } = $props();
	let host: HTMLDivElement;

	type Attached = { replay: string; spawned: boolean };

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

		let live = false;
		let disposed = false;
		// Live output can arrive before the attach or spawn call returns its replay: hold it until then.
		let early: string[] = [];
		// A fresh channel per call: Tauri ends a channel when its Rust side is dropped.
		function channel() {
			const ch = new Channel<string>();
			ch.onmessage = (chunk) => {
				if (disposed) return;
				if (live) term.write(chunk);
				else early.push(chunk);
				onoutput?.();
			};
			return ch;
		}
		function connected(a: Attached) {
			if (disposed) return;
			if (a.replay) term.write(a.replay);
			for (const chunk of early) term.write(chunk);
			early = [];
			live = true;
		}
		const failed = (e: unknown) => term.write(`\r\nเปิด terminal ไม่ได้: ${e}\r\n`);
		const sized = () => host.clientWidth > 0 && host.clientHeight > 0;

		// Re-attach first, even while hidden, so a running agent CLI's output keeps reaching the page.
		let attachChecked = false;
		const shown = sized();
		invoke<Attached | null>('pty_attach', { key, cols: shown ? term.cols : null, rows: shown ? term.rows : null, onData: channel() })
			.then((a) => {
				attachChecked = true;
				if (a) connected(a);
				else start();
			})
			.catch(failed);

		// Start a shell once the terminal has its real size: a terminal mounted hidden (the Agents
		// layout while the IDE shows) would otherwise type its command into an 11-column shell.
		let spawning = false;
		function start() {
			if (!attachChecked || live || spawning || disposed || !sized()) return;
			spawning = true;
			fit.fit();
			invoke<Attached>('pty_spawn', { key, cols: term.cols, rows: term.rows, onData: channel(), slug: slug ?? null, run: run ?? null })
				.then(connected)
				.catch(failed);
		}

		const input = term.onData((data) => {
			if (live) invoke('pty_write', { key, data }).catch(() => {});
		});
		const resized = term.onResize(({ cols, rows }) => {
			if (live) invoke('pty_resize', { key, cols, rows }).catch(() => {});
		});
		const unbindSettings = bindTerminalSettings(term, () => fit.fit());
		const observer = new ResizeObserver(() => {
			fit.fit();
			start();
		});
		observer.observe(host);

		// No pty_kill here: an unmount is also what a page reload does, and the shell must outlive it.
		return () => {
			disposed = true;
			observer.disconnect();
			unbindSettings();
			input.dispose();
			resized.dispose();
			term.dispose();
		};
	});
</script>

<div bind:this={host} class="h-full w-full px-2 pt-1"></div>
