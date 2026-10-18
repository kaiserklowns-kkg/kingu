<script lang="ts">
	import { onMount } from 'svelte';
	import { Channel, invoke } from '@tauri-apps/api/core';
	import { Terminal } from '@xterm/xterm';
	import { FitAddon } from '@xterm/addon-fit';
	import '@xterm/xterm/css/xterm.css';
	import { bindTerminalSettings } from '#lib/settings/apply.svelte.ts';
	import { shellFrom, shellPlatform, terminalOptionsFrom } from '#lib/settings/mappings.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { system } from '#lib/workbench/system.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { clipboardImage, onFileDrop, savePastedImage } from '#lib/agent/attachInput.ts';
	import { pastedImageText, terminalDropText } from '#lib/agent/attachments.ts';

	/**
	 * `key`: the PTY session (sessions.ts). A live one is re-attached with its recent output
	 * replayed, so the shell outlives a webview reload, a folder switch and (with the kingu-ptyd
	 * daemon) an app restart; unmounting never kills it, closing the tab does (the terminal stores). `slug`: start in that task's worktree instead of the folder root.
	 * `run`: a command typed into a new shell (an agent CLI, a Snap task); Rust quotes every argument.
	 */
	let { key, slug, run, onoutput }: { key: string; slug?: string; run?: string[]; onoutput?: () => void } = $props();
	let host: HTMLDivElement;

	type Attached = { replay: string; spawned: boolean };

	onMount(() => {
		const term = new Terminal({
			// The terminal settings from the start (scrollback sizes the buffer); bindTerminalSettings keeps them live.
			...terminalOptionsFrom((id) => settings.get(id)),
			// The color theme's colors replace this first-paint background.
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
			// terminal.integrated.shell / shellArgs / env / cwd (user settings) for the new shell.
			const terminal = shellFrom((id) => settings.get(id), shellPlatform());
			invoke<Attached>('pty_spawn', { key, cols: term.cols, rows: term.rows, onData: channel(), slug: slug ?? null, run: run ?? null, terminal })
				.then((a) => (connected(a), void system.refresh()))
				.catch(failed);
		}

		const input = term.onData((data) => {
			if (live) invoke('pty_write', { key, data }).catch(() => {});
		});
		const resized = term.onResize(({ cols, rows }) => {
			if (live) invoke('pty_resize', { key, cols, rows }).catch(() => {});
		});
		// Orca's image paste: a clipboard holding only an image is saved and its path pasted, so an
		// agent CLI attaches it; text pastes stay with xterm.
		const onPaste = (e: ClipboardEvent) => {
			const image = clipboardImage(e);
			if (!image || !live) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			void savePastedImage(image)
				.then((path) => invoke('pty_write', { key, data: pastedImageText(path) }))
				.catch((err) => status.flash(`วางรูปไม่ได้: ${err}`, 8000));
		};
		host.addEventListener('paste', onPaste, true);
		// Files dropped from Finder are typed as paths (images as a bracketed paste, like Orca).
		const stopDrop = onFileDrop(host, {
			drop: (paths) => {
				const text = terminalDropText(paths);
				if (!text || !live) return;
				void invoke('pty_write', { key, data: text }).catch(() => {});
				term.focus();
			}
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
			host.removeEventListener('paste', onPaste, true);
			stopDrop();
			observer.disconnect();
			unbindSettings();
			input.dispose();
			resized.dispose();
			term.dispose();
		};
	});
</script>

<div bind:this={host} class="h-full w-full px-2 pt-1"></div>
