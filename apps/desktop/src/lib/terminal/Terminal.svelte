<script lang="ts">
	import { onMount } from 'svelte';
	import { Channel, invoke } from '@tauri-apps/api/core';
	import { Terminal, type ILink } from '@xterm/xterm';
	import { FitAddon } from '@xterm/addon-fit';
	import { SearchAddon } from '@xterm/addon-search';
	import '@xterm/xterm/css/xterm.css';
	import { bindTerminalSettings } from '#lib/settings/apply.svelte.ts';
	import { shellFrom, shellPlatform, terminalOptionsFrom } from '#lib/settings/mappings.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { system } from '#lib/workbench/system.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { clipboardImage, onFileDrop, savePastedImage } from '#lib/agent/attachInput.ts';
	import { pastedImageText, terminalDropText } from '#lib/agent/attachments.ts';
	import { isMac, keyLabel } from '#lib/workbench/keys.ts';
	import PopupMenu from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import TerminalFind from './TerminalFind.svelte';
	import { FIND_TERMINAL_OPTIONS, HIGHLIGHT_LIMIT } from './find.ts';
	import { cellText, detectLinks, linkHint, linkModifierDown, MAX_LINE, type TerminalLink } from './links.ts';
	import { linkTarget, openUrl } from './pty.ts';
	import { registerTerminal } from './registry.ts';
	import { isBuiltin, terminalMenu, type MenuState, type TerminalFlavor } from './terminalMenu.ts';

	/**
	 * `key`: the PTY session (sessions.ts). A live one is re-attached with its recent output
	 * replayed, so the shell outlives a webview reload, a folder switch and (with the kingu-ptyd
	 * daemon) an app restart; unmounting never kills it, closing the tab does (the terminal stores). `slug`: start in that task's worktree instead of the folder root.
	 * `run`: a command typed into a new shell (an agent CLI, a Snap task); Rust quotes every argument.
	 * `cwdFrom`: a split pane starts in that terminal's current directory. `flavor`: the IDE panel
	 * (VS Code behaviour) or an ADE terminal (Orca behaviour) for find and the context menu.
	 */
	let {
		key,
		slug,
		run,
		cwdFrom,
		floatingCwd,
		flavor = 'ide',
		menuState,
		keyLabels = {},
		onoutput,
		onaction,
		onopenfile,
		onfocus
	}: {
		key: string;
		slug?: string;
		run?: string[];
		cwdFrom?: string;
		/** A floating workspace terminal, started in that directory setting (`~` = home). */
		floatingCwd?: string;
		flavor?: TerminalFlavor;
		menuState?: () => Omit<MenuState, 'hasSelection'>;
		keyLabels?: Record<string, string | undefined>;
		onoutput?: () => void;
		/** A context menu item the terminal does not run itself (split, rename, kill…). */
		onaction?: (id: string) => void;
		/** A file link was followed: `rel` is relative to the open folder. */
		onopenfile?: (rel: string, line?: number, column?: number) => void;
		onfocus?: () => void;
	} = $props();
	let root: HTMLDivElement;
	let host: HTMLDivElement;

	type Attached = { replay: string; spawned: boolean };

	let term: Terminal | undefined = $state();
	let search: SearchAddon | undefined = $state();
	let finding = $state(false);
	let findRequest = $state(0);
	let findSeed = $state('');
	let menu = $state<{ x: number; y: number; items: MenuNode[] } | null>(null);
	let hint = $state<{ x: number; y: number; text: string } | null>(null);

	/** VS Code: Alt follows links when editor.multiCursorModifier is ctrlCmd, else ⌘ (Ctrl off macOS). */
	const altModifier = () => settings.get<string>('editor.multiCursorModifier') === 'ctrlCmd';

	function openFind() {
		if (!term) return;
		findSeed = term.getSelection();
		finding = true;
		findRequest++;
	}

	function runBuiltin(id: string) {
		if (!term) return;
		if (id === 'copy') {
			const text = term.getSelection();
			if (text) void navigator.clipboard?.writeText(text).catch(() => {});
		} else if (id === 'paste') {
			void navigator.clipboard
				?.readText()
				.then((text) => text && term?.paste(text))
				.catch(() => status.flash('อ่าน clipboard ไม่ได้'));
		} else if (id === 'selectAll') term.selectAll();
		else if (id === 'clear') term.clear();
		else if (id === 'reset') term.reset();
		term.focus();
	}

	function openMenu(e: MouseEvent) {
		e.preventDefault();
		if (!term) return;
		const labels: Record<string, string | undefined> = {
			copy: keyLabel(isMac ? 'cmd+c' : 'ctrl+shift+c'),
			paste: keyLabel(isMac ? 'cmd+v' : 'ctrl+v'),
			selectAll: isMac ? keyLabel('cmd+a') : undefined,
			clear: flavor === 'ade' || isMac ? keyLabel('cmd+k') : undefined,
			...keyLabels
		};
		const items = terminalMenu(flavor, { hasSelection: term.hasSelection(), ...menuState?.() }, (id) => labels[id]);
		menu = { x: e.clientX, y: e.clientY, items };
	}

	function runMenu(node: MenuNode) {
		if (node.type !== 'item') return;
		if (isBuiltin(node.id)) runBuiltin(node.id);
		else onaction?.(node.id);
	}

	onMount(() => {
		const t = new Terminal({
			// The terminal settings from the start (scrollback sizes the buffer); bindTerminalSettings keeps them live.
			...terminalOptionsFrom((id) => settings.get(id)),
			...FIND_TERMINAL_OPTIONS,
			// The color theme's colors replace this first-paint background.
			theme: { background: '#181818', foreground: '#CCCCCC' },
			// OSC 8 hyperlinks follow the same modifier rule as detected links.
			linkHandler: {
				activate: (e, uri) => {
					if (linkModifierDown(e, isMac, altModifier()) && /^https?:/i.test(uri)) void openUrl(uri).catch((err) => status.flash(`เปิดลิงก์ไม่ได้: ${err}`));
				},
				hover: (e, uri) => showHint(e, linkHint('url', isMac, altModifier()) + ` ${uri}`),
				leave: () => (hint = null)
			}
		});
		term = t;
		const fit = new FitAddon();
		const finder = new SearchAddon({ highlightLimit: HIGHLIGHT_LIMIT });
		search = finder;
		t.loadAddon(fit);
		t.loadAddon(finder);
		t.open(host);
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
				if (live) t.write(chunk);
				else early.push(chunk);
				onoutput?.();
			};
			return ch;
		}
		function connected(a: Attached) {
			if (disposed) return;
			if (a.replay) t.write(a.replay);
			for (const chunk of early) t.write(chunk);
			early = [];
			live = true;
		}
		const failed = (e: unknown) => t.write(`\r\nเปิด terminal ไม่ได้: ${e}\r\n`);
		const sized = () => host.clientWidth > 0 && host.clientHeight > 0;

		// Re-attach first, even while hidden, so a running agent CLI's output keeps reaching the page.
		let attachChecked = false;
		const shown = sized();
		invoke<Attached | null>('pty_attach', { key, cols: shown ? t.cols : null, rows: shown ? t.rows : null, onData: channel() })
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
			invoke<Attached>('pty_spawn', { key, cols: t.cols, rows: t.rows, onData: channel(), slug: slug ?? null, run: run ?? null, terminal, cwdFrom: cwdFrom ?? null, floatingCwd: floatingCwd ?? null })
				.then((a) => (connected(a), void system.refresh()))
				.catch(failed);
		}

		const input = t.onData((data) => {
			if (live) invoke('pty_write', { key, data }).catch(() => {});
		});
		const resized = t.onResize(({ cols, rows }) => {
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
				t.focus();
			}
		});
				const unbindSettings = bindTerminalSettings(t, () => fit.fit());
		const observer = new ResizeObserver(() => {
			fit.fit();
			start();
		});
		observer.observe(host);

		// File links are checked by Rust (the file must exist in the open folder); answers are kept 10s like VS Code's resolver cache.
		const targets = new Map<string, { at: number; rel: Promise<string | null> }>();
		function target(path: string): Promise<string | null> {
			const hit = targets.get(path);
			if (hit && performance.now() - hit.at < 10_000) return hit.rel;
			const rel = linkTarget(key, path);
			targets.set(path, { at: performance.now(), rel });
			if (targets.size > 500) targets.delete(targets.keys().next().value!);
			return rel;
		}
		const links = t.registerLinkProvider({
			provideLinks(y, callback) {
				void lineLinks(t, y).then(callback, () => callback(undefined));
			}
		});
		async function lineLinks(t: Terminal, y: number): Promise<ILink[] | undefined> {
			const buf = t.buffer.active;
			// The whole wrapped line, so a path cut by the terminal width is still one link.
			let first = y - 1;
			while (first > 0 && buf.getLine(first)?.isWrapped) first--;
			let last = y - 1;
			while (buf.getLine(last + 1)?.isWrapped) last++;
			const cells: string[] = [];
			const pos: { x: number; y: number }[] = [];
			for (let row = first; row <= last && cells.length <= MAX_LINE; row++) {
				const line = buf.getLine(row);
				if (!line) break;
				for (let x = 0; x < line.length; x++) {
					const cell = line.getCell(x);
					if (!cell) continue;
					cells.push(cell.getChars() || (cell.getWidth() === 0 ? '' : ' '));
					pos.push({ x: x + 1, y: row + 1 });
				}
			}
			const { text, cellAt } = cellText(cells);
			const found = detectLinks(text)
				.map((l) => ({ l, from: pos[cellAt[l.start]], to: pos[cellAt[l.end - 1]] }))
				.filter(({ from, to }) => from && to && from.y <= y && to.y >= y);
			const resolved = await Promise.all(found.map(async (f) => ({ ...f, rel: f.l.kind === 'file' ? await target(f.l.path) : null })));
			const out = resolved.filter((f) => f.l.kind === 'url' || f.rel !== null).map(({ l, from, to, rel }) => toLink(l, from, to, rel, text));
			return out.length ? out : undefined;
		}
		function toLink(l: TerminalLink, from: { x: number; y: number }, to: { x: number; y: number }, rel: string | null, text: string): ILink {
			return {
				range: { start: from, end: to },
				text: text.slice(l.start, l.end),
				decorations: { pointerCursor: true, underline: true },
				activate(e) {
					if (!linkModifierDown(e, isMac, altModifier())) return;
					if (l.kind === 'url') void openUrl(l.url).catch((err) => status.flash(`เปิดลิงก์ไม่ได้: ${err}`));
					else if (rel) onopenfile?.(rel, l.line, l.column);
				},
				hover: (e) => showHint(e, linkHint(l.kind, isMac, altModifier())),
				leave: () => (hint = null)
			};
		}

		const onFocus = () => onfocus?.();
		t.textarea?.addEventListener('focus', onFocus);
		const unregister = registerTerminal({
			key,
			flavor,
			host: root,
			focus: () => t.focus(),
			find: openFind,
			clear: () => t.clear(),
			selectAll: () => t.selectAll()
		});

		// No pty_kill here: an unmount is also what a page reload does, and the shell must outlive it.
		return () => {
			disposed = true;
			host.removeEventListener('paste', onPaste, true);
			stopDrop();
			unregister();
			t.textarea?.removeEventListener('focus', onFocus);
			observer.disconnect();
			unbindSettings();
			links.dispose();
			input.dispose();
			resized.dispose();
			t.dispose();
		};
	});

	function showHint(e: MouseEvent, text: string) {
		const r = root.getBoundingClientRect();
		hint = { x: e.clientX - r.left, y: e.clientY - r.top, text };
	}
</script>

<div bind:this={root} class="relative h-full w-full" role="presentation" oncontextmenu={openMenu}>
	<div bind:this={host} class="h-full w-full px-2 pt-1"></div>
	{#if finding && term && search}
		<TerminalFind {term} {search} {flavor} seed={findSeed} request={findRequest} onclose={() => (finding = false)} />
	{/if}
	{#if hint}
		<div
			class="pointer-events-none absolute z-30 max-w-[80%] truncate rounded-[3px] border border-(--vscode-editorHoverWidget-border,var(--vscode-widget-border)) bg-(--vscode-editorHoverWidget-background,var(--vscode-editorWidget-background)) px-2 py-0.5 text-xs text-(--vscode-editorHoverWidget-foreground,var(--vscode-foreground)) shadow"
			style:left="{hint.x}px"
			style:top="{Math.max(0, hint.y - 28)}px"
		>
			{hint.text}
		</div>
	{/if}
</div>
{#if menu}
	<PopupMenu items={menu.items} label="Terminal" x={menu.x} y={menu.y} onRun={runMenu} onClose={() => (menu = null)} />
{/if}
