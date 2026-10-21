<script lang="ts">
	import { onMount, untrack } from 'svelte';
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
	import { ask } from '#lib/workbench/messageBox.ts';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import Icon from '#lib/workbench/Icon.svelte';
	import { AutoReplies, linkSchemeAllowed, Osc99, pasteNeedsWarning, rightClickAction, zoomedFontSize } from './behaviour.ts';
	import PopupMenu from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import TerminalFind from './TerminalFind.svelte';
	import { FIND_TERMINAL_OPTIONS, HIGHLIGHT_LIMIT } from './find.ts';
	import { cellText, detectLinks, linkHint, linkModifierDown, MAX_LINE, type TerminalLink } from './links.ts';
	import { linkTarget, openUrl } from './pty.ts';
	import { emitOutput, markTaskSpawned, registerTerminal, taskSpawned, touchTerminal } from './registry.ts';
	import type { TaskSpawn } from './registry.ts';
	import { bindAdeTerminal, copiedSelection, type AdeBinding } from './adeTerminal.svelte.ts';
	import { INSERT_EVENT } from '#lib/voice/target.ts';
	import { quickCommandInput, quickCommands } from './adeTerminalOptions.ts';
	import { isBuiltin, terminalMenu, type MenuState, type TerminalFlavor } from './terminalMenu.ts';
	import { ago, failed, ShellIntegration, type Command } from './shellIntegrationAddon.ts';
	import { decorationPlaces } from './shellIntegration.ts';
	import { commandInput, TerminalHistory } from './commandHistory.ts';
	import type { QuickFix } from './quickFixes.ts';
	import { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import { t as tr } from '#lib/i18n/index.ts';

	/**
	 * `key`: the PTY session (sessions.ts). A live one is re-attached with its recent output
	 * replayed, so the shell outlives a webview reload, a folder switch and (with the kingu-ptyd
	 * daemon) an app restart; unmounting never kills it, closing the tab does (the terminal stores). `slug`: start in that task's worktree instead of the folder root.
	 * `run`: a command typed into a new shell (an agent CLI, a Snap task); Rust quotes every argument.
	 * `cwdFrom`: a split pane starts in that terminal's current directory. `folder`: the root folder
	 * of a multi-root window it starts in (Rust checks it is one). `flavor`: the IDE panel
	 * (VS Code behaviour) or an ADE terminal (Orca behaviour) for find and the context menu.
	 * `task`: a task terminal (tasks.svelte.ts): Rust runs the task instead of a shell, once; it
	 * starts even while the panel is hidden (presentation.reveal never). `profile`: the terminal
	 * profile a new shell starts with (New Terminal With Profile) instead of the default one.
	 * `reportedCwd`: a split's source directory as its shell integration reported it.
	 */
	let {
		key,
		slug,
		run,
		task,
		cwdFrom,
		folder,
		floatingCwd,
		profile,
		reportedCwd,
		flavor = 'ide',
		menuState,
		keyLabels = {},
		onoutput,
		ontitle,
		onbell,
		onaction,
		onopenfile,
		onfocus
	}: {
		key: string;
		slug?: string;
		run?: string[];
		task?: TaskSpawn;
		cwdFrom?: string;
		folder?: string;
		/** A floating workspace terminal, started in that directory setting (`~` = home). */
		floatingCwd?: string;
		profile?: string;
		reportedCwd?: string;
		flavor?: TerminalFlavor;
		menuState?: () => Omit<MenuState, 'hasSelection'>;
		keyLabels?: Record<string, string | undefined>;
		onoutput?: () => void;
		/** The program set the terminal's title (OSC 0/2): agent status evidence (agentTitle.ts). */
		ontitle?: (title: string) => void;
		/** The program rang the bell (BEL), whatever terminal.integrated.enableVisualBell says. */
		onbell?: () => void;
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
	/** terminal.integrated.enableVisualBell: the bell icon, shown for terminal.integrated.bellDuration. */
	let bell = $state(false);
	/** terminal.integrated.resizeDimensionsOverlay.enabled: `cols × rows` while the terminal is resized. */
	let dimensions = $state<string | null>(null);
	/** Shell integration (shellIntegrationAddon.ts): commands, decorations, cwd. */
	let integration: ShellIntegration | undefined;
	/** terminal.integrated.stickyScroll.*: the command whose output is scrolled into view. */
	let sticky = $state<{ command: Command; lines: string[] } | null>(null);
	/** A command decoration's menu. */
	let decorationMenu = $state<{ x: number; y: number; command: Command; fixes: QuickFix[] } | null>(null);
	/** terminal.integrated.shellIntegration.decorationsEnabled: the gutter takes room left of the text. */
	const gutter = $derived(decorationPlaces(settings.get<string>('terminal.integrated.shellIntegration.decorationsEnabled')).gutter);
	const history = new TerminalHistory(typeof localStorage === 'undefined' ? undefined : localStorage);

	const setting = <T,>(id: string) => settings.get<T>(id);
	/** terminal.integrated.allowedLinkSchemes. */
	const schemeAllowed = (url: string) => linkSchemeAllowed(url, setting<string[]>('terminal.integrated.allowedLinkSchemes'));

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
			const text = copiedSelection(term, flavor === 'ade');
			if (text) void navigator.clipboard?.writeText(text).catch(() => {});
		} else if (id === 'paste') {
			pasteClipboard();
		} else if (id === 'selectAll') term.selectAll();
		else if (id === 'clear') term.clear();
		else if (id === 'reset') term.reset();
		term.focus();
	}

	/** Pastes `text`, asking first for multi-line text (terminal.integrated.enableMultiLinePasteWarning). */
	async function pasteText(text: string) {
		const t = term;
		if (!t || !text) return;
		if (pasteNeedsWarning(setting<string>('terminal.integrated.enableMultiLinePasteWarning'), text, t.modes.bracketedPasteMode)) {
			const lines = text.replace(/\r?\n$/, '').split(/\r?\n/).length;
			const ok = await ask(`วางข้อความ ${lines} บรรทัดลงใน terminal? (Are you sure you want to paste ${lines} lines of text into the terminal?)`, {
				title: 'Terminal',
				kind: 'warning',
				okLabel: 'วาง (Paste)'
			});
			if (!ok) return;
		}
		t.paste(text);
	}

	function pasteClipboard() {
		void navigator.clipboard
			?.readText()
			.then((text) => pasteText(text))
			.catch(() => status.flash('อ่าน clipboard ไม่ได้'));
	}

	function openMenu(e: MouseEvent) {
		if (!term) return;
		// terminal.integrated.rightClickBehavior (selectWord: xterm has selected the word already).
		const action = rightClickAction(setting<string>('terminal.integrated.rightClickBehavior'), term.hasSelection());
		if (action === 'none') return;
		e.preventDefault();
		if (action === 'copy') {
			void navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
			term.clearSelection();
			return;
		}
		if (action === 'paste') {
			pasteClipboard();
			return;
		}
		const labels: Record<string, string | undefined> = {
			copy: keyLabel(isMac ? 'cmd+c' : 'ctrl+shift+c'),
			paste: keyLabel(isMac ? 'cmd+v' : 'ctrl+v'),
			selectAll: isMac ? keyLabel('cmd+a') : undefined,
			clear: flavor === 'ade' || isMac ? keyLabel('cmd+k') : undefined,
			...keyLabels
		};
		const quick = flavor === 'ade' ? quickCommands(settings.get<Record<string, unknown>>('kingu.terminal.quickCommands')) : [];
		const items = terminalMenu(flavor, { hasSelection: term.hasSelection(), quick: quick.map((q) => q.label), ...menuState?.() }, (id) => labels[id]);
		menu = { x: e.clientX, y: e.clientY, items };
	}

	/** The shell this terminal runs, for its history (the script says; else the profile or $SHELL). */
	function shellName(): string {
		const said = integration?.tracker.shell;
		if (said) return said;
		const s = shellFrom((id) => settings.get(id), shellPlatform(), undefined, profile);
		return s.paths[0] ?? s.shell ?? '';
	}

	/** A command decoration's hover: when it ran and how it ended. */
	function describeCommand(c: Command): string {
		if (c.kind === 'mark') return tr('terminal.decoration.mark');
		const at = c.finishedAt ?? c.startedAt;
		if (!at || !c.end) return tr('terminal.decoration.running');
		const a = ago(at, Date.now());
		const when = tr(`terminal.ago.${a.unit}`, { count: a.count });
		const text = failed(c) ? tr('terminal.decoration.failed', { ago: when, code: c.exitCode ?? '' }) : tr('terminal.decoration.ran', { ago: when });
		return integration?.fixes?.command === c ? `${text}\n${tr('terminal.decoration.fixes')}` : text;
	}

	function fixLabel(f: QuickFix): string {
		if (f.kind === 'open') return tr('terminal.fix.open', { url: f.url });
		if (f.label.key === 'freePort') return tr('terminal.fix.freePort', { port: f.label.params.port });
		return tr('terminal.fix.run', { command: f.command });
	}

	function decorationItems(d: { command: Command; fixes: QuickFix[] }): MenuNode[] {
		const items: MenuNode[] = d.fixes.map((f, i) => menuItem(`fix:${i}`, fixLabel(f)));
		if (d.command.kind !== 'command') return items;
		if (items.length) items.push(menuSeparator);
		const output = integration?.output(d.command) ?? '';
		items.push(
			menuItem('rerun', tr('terminal.menu.rerun'), { enabled: !!d.command.command }),
			menuItem('copyCommand', tr('terminal.menu.copyCommand'), { enabled: !!d.command.command }),
			menuItem('copyOutput', tr('terminal.menu.copyOutput'), { enabled: !!output }),
			menuItem('selectOutput', tr('terminal.menu.selectOutput'), { enabled: !!output })
		);
		return items;
	}

	/** Types `text` into the shell and runs it. */
	function runCommandText(text: string, run = true) {
		if (!term || !text) return;
		invoke('pty_write', { key, data: commandInput(text, run, term.modes.bracketedPasteMode) }).catch((e) => status.flash(`รันคำสั่งไม่ได้: ${e}`));
		term.focus();
	}

	function runDecoration(node: MenuNode) {
		const d = decorationMenu;
		if (node.type !== 'item' || !d || !integration) return;
		if (node.id.startsWith('fix:')) {
			const f = d.fixes[Number(node.id.slice(4))];
			if (f?.kind === 'run') runCommandText(f.command);
			else if (f?.kind === 'open' && schemeAllowed(f.url)) void openUrl(f.url, setting<string[]>('terminal.integrated.allowedLinkSchemes')).catch((err) => status.flash(`เปิดลิงก์ไม่ได้: ${err}`));
		} else if (node.id === 'rerun') runCommandText(d.command.command);
		else if (node.id === 'copyCommand') void navigator.clipboard?.writeText(d.command.command).catch(() => {});
		else if (node.id === 'copyOutput') void navigator.clipboard?.writeText(integration.output(d.command)).catch(() => {});
		else if (node.id === 'selectOutput') integration.selectOutput(d.command);
	}

	function runMenu(node: MenuNode) {
		if (node.type !== 'item') return;
		if (isBuiltin(node.id)) runBuiltin(node.id);
		else if (node.id.startsWith('quick:')) runQuick(Number(node.id.slice(6)));
		else onaction?.(node.id);
	}

	/** A `kingu.terminal.quickCommands` entry typed into this shell (Orca's quick commands). */
	function runQuick(index: number) {
		const q = quickCommands(settings.get<Record<string, unknown>>('kingu.terminal.quickCommands'))[index];
		if (!q) return;
		invoke('pty_write', { key, data: quickCommandInput(q.command) }).catch((e) => status.flash(`รันคำสั่งไม่ได้: ${e}`));
		term?.focus();
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
					if (linkModifierDown(e, isMac, altModifier()) && schemeAllowed(uri)) void openUrl(uri, setting<string[]>('terminal.integrated.allowedLinkSchemes')).catch((err) => status.flash(`เปิดลิงก์ไม่ได้: ${err}`));
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
		const unbindSettings = bindTerminalSettings(t, () => fit.fit());
		// Orca's Terminal page (kingu.terminal.*) for ADE terminals; the IDE panel keeps VS Code's behaviour.
		const ade: AdeBinding | null = flavor === 'ade' ? bindAdeTerminal(t, host, root, () => fit.fit()) : null;

		let live = false;
		let disposed = false;
		/** The recent output of a re-attached session is being written (its bells rang long ago). */
		let replaying = false;
		// Shell integration (shellIntegrationAddon.ts): commands, decorations, cwd, sticky scroll.
		const si = new ShellIntegration(t, {
			decorations: () => setting<string>('terminal.integrated.shellIntegration.decorationsEnabled'),
			quickFixes: () => setting<boolean>('terminal.integrated.shellIntegration.quickFixEnabled'),
			replaying: () => replaying,
			describe: describeCommand,
			// terminal.integrated.shellIntegration.history: Run Recent Command and Go to Recent Directory remember them.
			onCommand: (c) => {
				const limit = setting<number>('terminal.integrated.shellIntegration.history');
				const shell = shellName();
				if (c.command) history.addCommand(shell, c.command, limit);
				if (c.cwd) history.addDirectory(shell, c.cwd, limit);
			},
			onDecorationClick: (c, e) => {
				decorationMenu = { x: e.clientX, y: e.clientY, command: c, fixes: si.fixes?.command === c ? si.fixes.fixes : [] };
			},
			onChange: scheduleSticky
		});
		integration = si;
		let stickyFrame = 0;
		function scheduleSticky() {
			if (stickyFrame || disposed) return;
			stickyFrame = requestAnimationFrame(() => {
				stickyFrame = 0;
				updateSticky();
			});
		}
		function updateSticky() {
			if (disposed) return;
			if (!setting<boolean>('terminal.integrated.stickyScroll.enabled')) {
				sticky = null;
				return;
			}
			// VS Code: never more than 40% of the viewport.
			const max = Math.min(setting<number>('terminal.integrated.stickyScroll.maxLineCount'), Math.max(1, Math.floor(t.rows * 0.4)));
			const found = si.sticky(setting<string[]>('terminal.integrated.stickyScroll.ignoredCommands'), max);
			sticky = found ? { command: found.command, lines: found.text.split('\n') } : null;
		}
		const stopIntegrationSettings = $effect.root(() => {
			$effect(() => {
				const places = decorationPlaces(settings.get<string>('terminal.integrated.shellIntegration.decorationsEnabled'));
				untrack(() => {
					t.options.overviewRuler = places.ruler ? { width: 10 } : {};
					si.redecorate();
				});
			});
			$effect(() => {
				settings.get('terminal.integrated.stickyScroll.enabled');
				settings.get('terminal.integrated.stickyScroll.maxLineCount');
				settings.get('terminal.integrated.stickyScroll.ignoredCommands');
				untrack(scheduleSticky);
			});
		});
		// terminal.integrated.autoReplies: rebuilt when the setting changes.
		let replies = new AutoReplies({});
		const stopReplies = $effect.root(() => {
			$effect(() => {
				replies = new AutoReplies(settings.get<Record<string, string | null>>('terminal.integrated.autoReplies'));
			});
		});
		// Live output can arrive before the attach or spawn call returns its replay: hold it until then.
		let early: string[] = [];
		// A fresh channel per call: Tauri ends a channel when its Rust side is dropped.
		function channel() {
			const ch = new Channel<string>();
			ch.onmessage = (chunk) => {
				if (disposed) return;
				if (live) t.write(chunk);
				else early.push(chunk);
				emitOutput(key, chunk);
				if (!replies.empty) for (const reply of replies.feed(chunk, performance.now())) invoke('pty_write', { key, data: reply }).catch(() => {});
				onoutput?.();
			};
			return ch;
		}
		function connected(a: Attached) {
			if (disposed) return;
			if (a.replay) {
				// Replayed output must not re-run an old OSC 52 clipboard write.
				if (ade) ade.replaying = true;
				replaying = true;
				t.write(a.replay, () => {
					if (ade) ade.replaying = false;
					replaying = false;
				});
			}
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
			// A task starts hidden too (80×24 until shown), but only once: a remount never runs it again.
			const launch = task && !taskSpawned(key) ? task : undefined;
			if (!attachChecked || live || spawning || disposed || (!sized() && !launch)) return;
			spawning = true;
			if (sized()) fit.fit();
			if (launch) markTaskSpawned(key);
			// terminal.integrated.shell / shellArgs / env / cwd (user settings) for the new shell.
			const terminal = {
				...shellFrom((id) => settings.get(id), shellPlatform(), undefined, profile),
				// terminal.integrated.shellIntegration.enabled: Rust injects Kingu's scripts (shell_integration.rs).
				shellIntegration: settings.get<boolean>('terminal.integrated.shellIntegration.enabled'),
				// kingu.terminal.scopeHistoryByWorktree: an ADE shell keeps its own history per worktree.
				scopeHistory: flavor === 'ade' && settings.get<boolean>('kingu.terminal.scopeHistoryByWorktree') !== false
			};
			// `${workspaceFolder}`, `${env:…}`, … in terminal.integrated.cwd resolve for this terminal's folder (VS Code).
			const cwd = terminal.cwd?.includes('${') ? import('./newTerminal.ts').then((m) => m.terminalCwdSetting(folder)) : Promise.resolve(terminal.cwd);
			cwd
				.then((resolved) => invoke<Attached>('pty_spawn', { key, cols: t.cols, rows: t.rows, onData: channel(), slug: slug ?? null, run: run ?? null, terminal: { ...terminal, cwd: resolved }, cwdFrom: cwdFrom ?? null, folder: folder ?? null, floatingCwd: floatingCwd ?? null, task: launch ?? null, reportedCwd: reportedCwd ?? null }))
				.then((a) => (connected(a), void system.refresh()))
				.catch(failed);
		}

		const input = t.onData((data) => {
			if (live) invoke('pty_write', { key, data }).catch(() => {});
		});
		let dimensionsTimer: ReturnType<typeof setTimeout> | undefined;
		const resized = t.onResize(({ cols, rows }) => {
			if (live) invoke('pty_resize', { key, cols, rows }).catch(() => {});
			// terminal.integrated.resizeDimensionsOverlay.enabled: only for a shown terminal that already runs.
			if (live && sized() && setting<boolean>('terminal.integrated.resizeDimensionsOverlay.enabled')) {
				dimensions = `${cols} × ${rows}`;
				clearTimeout(dimensionsTimer);
				dimensionsTimer = setTimeout(() => (dimensions = null), 1000);
			}
		});
		// terminal.integrated.enableVisualBell / bellDuration.
		let bellTimer: ReturnType<typeof setTimeout> | undefined;
		const rang = t.onBell(() => {
			// Not while replaying old output after a reload: that bell rang long ago.
			if (live && !replaying) onbell?.();
			if (!setting<boolean>('terminal.integrated.enableVisualBell')) return;
			bell = true;
			clearTimeout(bellTimer);
			bellTimer = setTimeout(() => (bell = false), setting<number>('terminal.integrated.bellDuration'));
		});
		const titled = t.onTitleChange((title) => ontitle?.(title));
		// terminal.integrated.enableNotifications: OSC 99 desktop notifications from programs in the terminal.
		const osc99 = new Osc99();
		const notifier = t.parser.registerOscHandler(99, (data) => {
			const n = osc99.handle(data);
			if (n && setting<boolean>('terminal.integrated.enableNotifications')) notifications.info(n.body ? `${n.title ? `${n.title}: ` : ''}${n.body}` : n.title, { source: 'Terminal' });
			return true;
		});
		// terminal.integrated.middleClickBehavior: paste on a middle click.
		const onAuxClick = (e: MouseEvent) => {
			if (e.button !== 1 || setting<string>('terminal.integrated.middleClickBehavior') !== 'paste') return;
			e.preventDefault();
			pasteClipboard();
		};
		host.addEventListener('auxclick', onAuxClick);
		// terminal.integrated.mouseWheelZoom: ⌘ (Ctrl elsewhere) + wheel changes terminal.integrated.fontSize.
		const onWheel = (e: WheelEvent) => {
			if (!setting<boolean>('terminal.integrated.mouseWheelZoom') || !(isMac ? e.metaKey : e.ctrlKey)) return;
			e.preventDefault();
			e.stopPropagation();
			const size = zoomedFontSize(setting<number>('terminal.integrated.fontSize'), e.deltaY);
			if (size !== setting<number>('terminal.integrated.fontSize')) void settings.set('terminal.integrated.fontSize', size, 'user').catch(() => {});
		};
		host.addEventListener('wheel', onWheel, { capture: true, passive: false });
		// Orca's image paste: a clipboard holding only an image is saved and its path pasted, so an
		// agent CLI attaches it; text pastes stay with xterm.
		const onPaste = (e: ClipboardEvent) => {
			const image = clipboardImage(e);
			if (!image) {
				// Text: terminal.integrated.enableMultiLinePasteWarning may ask first.
				const text = e.clipboardData?.getData('text/plain') ?? '';
				if (text && pasteNeedsWarning(setting<string>('terminal.integrated.enableMultiLinePasteWarning'), text, t.modes.bracketedPasteMode)) {
					e.preventDefault();
					e.stopImmediatePropagation();
					void pasteText(text);
				}
				return;
			}
			if (!live) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			void savePastedImage(image)
				.then((path) => invoke('pty_write', { key, data: pastedImageText(path) }))
				.catch((err) => status.flash(`วางรูปไม่ได้: ${err}`, 8000));
		};
		host.addEventListener('paste', onPaste, true);
		// Voice dictation's text (voice/target.ts) arrives as a paste.
		const onDictation = (e: Event) => {
			const text = (e as CustomEvent<{ text?: unknown }>).detail?.text;
			if (typeof text !== 'string' || !live) return;
			e.preventDefault();
			void pasteText(text);
		};
		host.addEventListener(INSERT_EVENT, onDictation);
		// Files dropped from Finder are typed as paths (images as a bracketed paste, like Orca).
		const stopDrop = onFileDrop(host, {
			drop: (paths) => {
				const text = terminalDropText(paths);
				if (!text || !live) return;
				void invoke('pty_write', { key, data: text }).catch(() => {});
				t.focus();
			}
		});
		const observer = new ResizeObserver(() => {
			fit.fit();
			start();
		});
		observer.observe(host);

		// File links are checked by Rust (the file must exist in the open folder); answers are kept 10s like VS Code's resolver cache.
		// With shell integration a relative path resolves against the directory its command ran in (VS Code).
		const targets = new Map<string, { at: number; rel: Promise<string | null> }>();
		function target(path: string, cwd: string | undefined): Promise<string | null> {
			const id = `${cwd ?? ''}\0${path}`;
			const hit = targets.get(id);
			if (hit && performance.now() - hit.at < 10_000) return hit.rel;
			const rel = linkTarget(key, path, cwd);
			targets.set(id, { at: performance.now(), rel });
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
			// terminal.integrated.enableFileLinks: `off` keeps only web links (`notRemote` is on: Kingu's terminals are local).
			const fileLinks = setting<string>('terminal.integrated.enableFileLinks') !== 'off';
			const cwd = si.cwdAt(y - 1);
			const resolved = await Promise.all(found.filter((f) => fileLinks || f.l.kind === 'url').map(async (f) => ({ ...f, rel: f.l.kind === 'file' ? await target(f.l.path, cwd) : null })));
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
					if (l.kind === 'url') {
						if (schemeAllowed(l.url)) void openUrl(l.url, setting<string[]>('terminal.integrated.allowedLinkSchemes')).catch((err) => status.flash(`เปิดลิงก์ไม่ได้: ${err}`));
					}
					else if (rel) onopenfile?.(rel, l.line, l.column);
				},
				hover: (e) => showHint(e, linkHint(l.kind, isMac, altModifier())),
				leave: () => (hint = null)
			};
		}

		const onFocus = () => {
			touchTerminal(key);
			onfocus?.();
		};
		t.textarea?.addEventListener('focus', onFocus);
		const unregister = registerTerminal({
			key,
			flavor,
			host: root,
			focus: () => t.focus(),
			find: openFind,
			clear: () => t.clear(),
			selectAll: () => t.selectAll(),
			print: (text) => t.write(text),
			lines: () => {
				const buf = t.buffer.active;
				const out: string[] = [];
				for (let i = 0; i < buf.length; i++) {
					const line = buf.getLine(i);
					const text = line?.translateToString(true) ?? '';
					// A soft-wrapped row continues the line above.
					if (line?.isWrapped && out.length) out[out.length - 1] += text;
					else out.push(text);
				}
				return out;
			},
			write: (data) => void invoke('pty_write', { key, data }).catch((e) => status.flash(`พิมพ์ลง terminal ไม่ได้: ${e}`)),
			integration: si,
			shell: shellName,
			bracketedPaste: () => t.modes.bracketedPasteMode,
			scrollPage: (direction) => t.scrollPages(direction)
		});

		// No pty_kill here: an unmount is also what a page reload does, and the shell must outlive it.
		return () => {
			disposed = true;
			if (stickyFrame) cancelAnimationFrame(stickyFrame);
			stopIntegrationSettings();
			si.dispose();
			integration = undefined;
			stopReplies();
			clearTimeout(dimensionsTimer);
			clearTimeout(bellTimer);
			rang.dispose();
			titled.dispose();
			notifier.dispose();
			host.removeEventListener('auxclick', onAuxClick);
			host.removeEventListener('wheel', onWheel, { capture: true });
			host.removeEventListener('paste', onPaste, true);
			host.removeEventListener(INSERT_EVENT, onDictation);
			stopDrop();
			unregister();
			t.textarea?.removeEventListener('focus', onFocus);
			observer.disconnect();
			unbindSettings();
			ade?.dispose();
			links.dispose();
			input.dispose();
			resized.dispose();
			t.dispose();
		};
	});

	function showHint(e: MouseEvent, text: string) {
		// terminal.integrated.showLinkHover.
		if (!setting<boolean>('terminal.integrated.showLinkHover')) return;
		const r = root.getBoundingClientRect();
		hint = { x: e.clientX - r.left, y: e.clientY - r.top, text };
	}
</script>

<div bind:this={root} class="relative h-full w-full" role="presentation" data-ade-terminal={flavor === 'ade' ? '' : undefined} oncontextmenu={openMenu}>
	<!-- terminal.integrated.shellIntegration.decorationsEnabled: command marks sit in the left gutter. -->
	<div bind:this={host} class="h-full w-full px-2 pt-1" style:padding-left={gutter ? '18px' : undefined}></div>
	{#if sticky}
		{@const s = sticky}
		<!-- terminal.integrated.stickyScroll.enabled: the command of the output in view; a click goes to it. -->
		<button
			type="button"
			class="absolute top-0 right-3 left-0 z-20 cursor-pointer overflow-hidden border-b border-(--vscode-terminalStickyScroll-border,var(--vscode-widget-border)) bg-(--vscode-terminalStickyScroll-background,var(--vscode-terminal-background,#181818)) pt-1 pr-2 text-left whitespace-pre text-(--vscode-terminal-foreground,var(--vscode-foreground)) shadow hover:bg-(--vscode-terminalStickyScrollHover-background,var(--vscode-list-hoverBackground))"
			style:padding-left={gutter ? '18px' : '8px'}
			style:font-family={term?.options.fontFamily}
			style:font-size="{term?.options.fontSize ?? 12}px"
			style:line-height={term?.options.lineHeight ?? 1}
			onclick={() => (integration?.reveal(s.command), term?.focus())}
		>
			{#each s.lines as line, i (i)}<div class="truncate">{line || ' '}</div>{/each}
		</button>
	{/if}
	{#if finding && term && search}
		<TerminalFind {term} {search} {flavor} seed={findSeed} request={findRequest} onclose={() => (finding = false)} />
	{/if}
	{#if bell}
		<div class="pointer-events-none absolute top-1 right-3 z-30 text-(--vscode-terminal-foreground,var(--vscode-foreground))" role="status" aria-label="Terminal bell">
			<Icon name="bell" size={14} />
		</div>
	{/if}
	{#if dimensions}
		<div
			class="pointer-events-none absolute top-1/2 left-1/2 z-30 -translate-x-1/2 -translate-y-1/2 rounded-[3px] border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) px-2 py-0.5 font-mono text-xs text-(--vscode-editorWidget-foreground,var(--vscode-foreground)) shadow"
		>
			{dimensions}
		</div>
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
{#if decorationMenu}
	<PopupMenu items={decorationItems(decorationMenu)} label="Command" x={decorationMenu.x} y={decorationMenu.y} onRun={runDecoration} onClose={() => (decorationMenu = null)} />
{/if}

<style>
	/* kingu.terminal.mouseHideWhileTyping */
	:global(.kingu-mouse-hidden),
	:global(.kingu-mouse-hidden *) {
		cursor: none !important;
	}
	/* Shell integration's command decorations (VS Code's terminalCommandDecoration.* colors). */
	:global(.kingu-command-decoration) {
		margin-left: -14px;
		width: 10px !important;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		pointer-events: auto;
	}
	:global(.kingu-command-decoration::before) {
		content: '';
		width: 8px;
		height: 8px;
		border-radius: 50%;
		box-sizing: border-box;
	}
	:global(.kingu-command-success::before) {
		background: var(--vscode-terminalCommandDecoration-successBackground, #1b81a8);
	}
	:global(.kingu-command-error::before) {
		background: var(--vscode-terminalCommandDecoration-errorBackground, #f14c4c);
	}
	:global(.kingu-command-default::before) {
		border: 1px solid var(--vscode-terminalCommandDecoration-defaultBackground, #ffffff40);
	}
	:global(.kingu-command-quickfix::before) {
		width: 9px;
		height: 9px;
		border-radius: 50% 50% 35% 35%;
		background: var(--vscode-editorLightBulb-foreground, #ffcc00);
	}
</style>
