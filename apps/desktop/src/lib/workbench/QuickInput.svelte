<script lang="ts">
	// Quick input (VS Code: IQuickInputService + the quick access providers). The typed prefix
	// picks the provider (quickAccess.ts): '' files with recently opened first, '>' commands,
	// ':' line, '@' / '@:' symbols in the editor, '#' workspace symbols, 'edt ' open editors,
	// 'view ' views, '%' text in files, 'task ' tasks, 'debug ' launch configurations, 'term '
	// terminals, '?' help. `quick.pick` shows a custom list instead (createQuickPick).
	import { enabledGlobs, hiddenBySibling, isExcluded, siblingClauses } from '#lib/settings/mappings.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { lsp } from '#lib/lsp/lsp.svelte.ts';
	import { Channel, invoke } from '@tauri-apps/api/core';
	import { searchSettingsFrom } from '#lib/settings/mappings.ts';
	import type { Task } from '#lib/tasks/taskConfig.ts';
	import { terminals } from '#lib/terminal/terminals.svelte.ts';
	import { focusTerminal } from '#lib/terminal/registry.ts';
	import { terminalEditorKey } from '#lib/terminal/terminalEditor.svelte.ts';
	import { search } from './search.svelte';
	import type { FileMatches, SearchEvent } from './searchResults';
	import { commands, keyOf } from './commands.svelte';
	import { editors } from './editors.svelte';
	import FileIcon from './FileIcon.svelte';
	import AgentIcon from '#lib/agent/AgentIcon.svelte';
	import { fileIcon, type FileIconSpec } from './fileIcons';
	import { quick, type PickItem, type Picker } from './quick.svelte';
	import { onMount, untrack } from 'svelte';
	import { highlightRuns, rank, type Match } from './fuzzy';
	import { isMac, keyLabel } from './keys';
	import { flattenSymbols, parseQuickInput, pickSymbols, QUICK_ACCESS_HELP, quickInputTop, rankFiles, SYMBOL_KIND_NAMES, type FlatSymbol } from './quickAccess';
	import { recentFiles } from './recentFiles.svelte';
	import { fileDetail } from '#lib/workbench/workspaceFolders.ts';
	import { workspace } from './workspace.svelte.ts';
	import { withRecentFirst } from './workbenchOptions';
	import { layout } from './layout.svelte';
	import { editorLabel } from './editorLabel';
	import { fileOf, isDiffKey } from './scm';
	import { t } from '#lib/i18n/index.ts';
	import { taskPickItems } from '#lib/tasks/taskCommands.svelte.ts';

	type Item = {
		label: string;
		detail?: string;
		key?: string;
		match?: Match;
		icon?: FileIconSpec;
		separator?: string;
		pick?: PickItem;
		/** Moves the editor while focused (symbol preview). */
		preview?: () => void;
		/** ⌘Enter: open to the side (files and symbols). */
		side?: () => void;
		/** Accepting fills the input instead of closing (the `?` help rows). */
		fill?: string;
		run: () => void;
	};

	let input: HTMLInputElement | undefined = $state();

	// Go Back (VS Code's workbench.action.quickInputBack: ⌃- on macOS, Alt+← elsewhere, over Go Back while the quick input is open).
	onMount(() =>
		commands.register({
			id: 'workbench.action.quickInputBack',
			title: 'Back',
			category: 'Quick Input',
			key: 'alt+left',
			mac: 'ctrl+-',
			palette: false,
			weight: 1,
			keyWhen: () => quick.visible,
			run: () => {
				if (quick.back()) {
					index = 0;
					input?.focus();
				}
			}
		})
	);
	let files = $state<string[]>([]);
	let index = $state(0);
	/** `#` results, fetched as the query changes. */
	let wsSymbols = $state<{ query: string; list: Awaited<ReturnType<typeof lsp.workspaceSymbols>>; busy: boolean }>({ query: '', list: [], busy: false });
	/** `@` symbols of the active file. */
	let docSymbols = $state<{ path: string | null; list: FlatSymbol[] }>({ path: null, list: [] });
	/** `task `: the tasks to run (VS Code's TasksQuickAccessProvider), loaded when the prefix is typed. */
	let taskList = $state<{ session: number; busy: boolean; list: Task[]; recent: string[]; run: (task: Task) => void }>({ session: -1, busy: false, list: [], recent: [], run: () => {} });
	/** `debug `: the launch configurations and compounds (VS Code's StartDebugQuickAccessProvider). */
	let launchList = $state<{ session: number; busy: boolean; list: { name: string; description: string }[] }>({ session: -1, busy: false, list: [] });
	/** `%`: text matches in the workspace (VS Code's TextSearchQuickAccess), from Rust's quick search slot. */
	let textHits = $state<{ query: string; busy: boolean; files: FileMatches[] }>({ query: '', busy: false, files: [] });
	/** Where the editor was before a symbol preview moved it (restored on cancel). */
	let previewFrom: { line: number; column: number } | null = null;

	const mode = $derived(quick.picker ? null : parseQuickInput(quick.value));

	let list: HTMLUListElement | undefined = $state();

	// Keep the focused row in view (the current item of a long list, arrow keys).
	$effect(() => {
		void index;
		void items.length;
		queueMicrotask(() => list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
	});

	$effect(() => {
		if (!quick.visible) return;
		void quick.session;
		const p = untrack(() => quick.picker);
		index = p?.activeId ? Math.max(0, p.items.findIndex((i) => i.id === p.activeId)) : 0;
		previewFrom = null;
		docSymbols = { path: null, list: [] };
		queueMicrotask(() => {
			input?.focus();
			// Restored input (preserveInput) starts selected, like VS Code: typing replaces it.
			if (quick.selectRestored) input?.select();
		});
		if (p) return;
		// files.exclude and search.exclude apply to Quick Open, like VS Code.
		const exclude = untrack(() => [...enabledGlobs(settings.get('files.exclude')), ...enabledGlobs(settings.get('search.exclude'))]);
		const clauses = untrack(() => siblingClauses(settings.get('files.exclude'), settings.get('search.exclude')));
		invoke<string[]>('fs_list_files').then((v) => {
			const all = new Set(v);
			files = v.filter((f) => !isExcluded(f, exclude) && !hiddenBySibling(f, clauses, (p) => all.has(p)));
		});
	});

	// `@`: the active file's document symbols (from the language server).
	$effect(() => {
		if (mode?.kind !== 'symbol') return;
		const path = editors.active;
		if (!path || docSymbols.path === path) return;
		untrack(() => {
			docSymbols = { path, list: flattenSymbols(lsp.symbols.get(path) ?? []) };
			void lsp.documentSymbolsOf(path).then((syms) => {
				if (editors.active === path) docSymbols = { path, list: flattenSymbols(syms) };
			});
		});
	});

	// `#`: workspace symbols, debounced like VS Code's symbol search; also under the file results
	// when search.quickOpen.includeSymbols is on and something is typed.
	$effect(() => {
		const withFiles = mode?.kind === 'files' && !!mode.query && settings.get<boolean>('search.quickOpen.includeSymbols');
		if (mode?.kind !== 'workspaceSymbol' && !withFiles) return;
		const q = mode?.kind === 'workspaceSymbol' || mode?.kind === 'files' ? mode.query : '';
		untrack(() => (wsSymbols = { query: q, list: wsSymbols.list, busy: true }));
		const timer = setTimeout(() => {
			void lsp.workspaceSymbols(q).then((list) => {
				if (wsSymbols.query === q) wsSymbols = { query: q, list, busy: false };
			});
		}, 150);
		return () => clearTimeout(timer);
	});

	// `task `: the task list, once per opening (tasks.json may have changed in between).
	$effect(() => {
		if (mode?.kind !== 'task') return;
		const session = quick.session;
		if (untrack(() => taskList.session) === session) return;
		untrack(() => (taskList = { session, busy: true, list: [], recent: [], run: () => {} }));
		void import('#lib/tasks/tasks.svelte.ts').then(async ({ tasks }) => {
			const { tasks: list } = await tasks.getTasks({ quiet: true });
			if (taskList.session === session) taskList = { session, busy: false, list, recent: [...tasks.recent], run: (task) => void tasks.run(task, { attachProblemMatcher: true }) };
		});
	});

	// `debug `: the launch configurations, once per opening.
	$effect(() => {
		if (mode?.kind !== 'debug') return;
		const session = quick.session;
		if (untrack(() => launchList.session) === session) return;
		untrack(() => (launchList = { session, busy: true, list: [] }));
		void import('#lib/debug/debug.svelte.ts').then(async ({ debug }) => {
			const list = await debug.launchItems().catch(() => []);
			if (launchList.session === session) launchList = { session, busy: false, list };
		});
	});

	// `%`: search as you type (debounced), at most 30 files and 10 matches each like VS Code's quick text search.
	$effect(() => {
		if (!quick.visible || mode?.kind !== 'text') return;
		const q = mode.query;
		untrack(() => (textHits = { query: q, busy: !!q, files: [] }));
		if (!q) return void invoke('search_quick_cancel').catch(() => {});
		let live = true;
		const timer = setTimeout(() => {
			const found: FileMatches[] = [];
			const onEvent = new Channel<SearchEvent>();
			onEvent.onmessage = (ev) => {
				if (!live) return;
				if (ev.kind === 'file') {
					if (found.length < QUICK_TEXT_FILES) found.push({ path: ev.path, matches: ev.matches.slice(0, QUICK_TEXT_PER_FILE) });
					textHits = { query: q, busy: true, files: [...found] };
				} else textHits = { query: q, busy: false, files: [...found] };
			};
			const options = { query: q, is_regex: false, match_case: false, whole_word: false, include: '', exclude: '', use_ignore_files: settings.get<boolean>('search.useIgnoreFiles'), ...searchSettingsFrom((id) => settings.get(id), true), max_results: QUICK_TEXT_FILES * QUICK_TEXT_PER_FILE * 4 };
			invoke('search_quick_text', { options, onEvent }).catch(() => {
				if (live) textHits = { query: q, busy: false, files: [...found] };
			});
		}, 200);
		return () => {
			live = false;
			clearTimeout(timer);
			invoke('search_quick_cancel').catch(() => {});
		};
	});

	// ⌃Tab pressed again while the editor switcher is open.
	$effect(() => {
		const step = quick.step;
		if (!step.n) return;
		untrack(() => {
			const n = items.length;
			if (n) index = (((index + step.delta) % n) + n) % n;
		});
	});

	/** Custom pick list: original order (with group labels) until the user types. */
	function pickerItems(picker: Picker, q: string): Item[] {
		const list = picker.items;
		const toItem = (pick: PickItem, match?: Match): Item => ({
			label: pick.label,
			detail: pick.description,
			separator: q ? undefined : pick.separator,
			match: match ?? (pick.positions ? { score: 0, positions: pick.positions } : undefined),
			icon: pick.icon ? fileIcon(pick.icon) : undefined,
			pick,
			run: () => picker.onAccept(pick)
		});
		if (picker.dynamic) return picker.dynamic(q).map((p) => toItem(p));
		if (!q) return list.map((p) => toItem(p));
		return rank(q, list, (p) => p.label, 100).map(({ item, match }) => toItem(item, match));
	}

	// Focus changes preview the item (VS Code's color theme picker applies the theme live, `@` reveals the symbol).
	$effect(() => {
		const item = items[index];
		const pick = item?.pick;
		const onActive = quick.picker?.onActive;
		if (pick && onActive) untrack(() => onActive(pick));
		if (item?.preview) untrack(() => item.preview!());
	});

	const QUICK_TEXT_FILES = 30;
	const QUICK_TEXT_PER_FILE = 10;

	/** `term `: the panel's terminals by group (`1`, or `1.2` in a split), then those in the editor area, then Create New Terminal. */
	function terminalItems(query: string): Item[] {
		const rows: { label: string; separator?: string; run: () => void }[] = [];
		const show = (id: number) => {
			layout.showPanel('terminal');
			terminals.active = id;
			focusTerminal(terminals.key(id));
		};
		terminals.groups.forEach((g, gi) => {
			const ids = terminals.ordered().filter((id) => terminals.groupOf(id) === gi);
			ids.forEach((id, ti) => {
				const term = terminals.get(id);
				if (term) rows.push({ label: `${ids.length > 1 ? `${gi + 1}.${ti + 1}` : gi + 1}: ${term.title}`, separator: rows.length ? undefined : 'panel', run: () => show(id) });
			});
		});
		const inEditor = terminals.list.filter((x) => x.inEditor);
		inEditor.forEach((term, i) => rows.push({ label: `${i + 1}: ${term.title}`, separator: i === 0 ? 'editor' : undefined, run: () => editors.open(terminalEditorKey(term.id), { preview: false }) }));
		const ranked = query ? rank(query, rows, (r) => r.label, 100).map(({ item, match }) => ({ ...item, separator: undefined, match })) : rows.map((r) => ({ ...r, match: undefined }));
		return [
			...ranked.map((r) => ({ label: r.label, separator: r.separator, match: r.match, run: r.run })),
			{ label: t('workbench.quickAccess.createTerminal'), separator: ranked.length ? ' ' : undefined, run: () => void commands.run('workbench.action.terminal.new') },
			{ label: t('workbench.quickAccess.createTerminalWithProfile'), run: () => void commands.run('workbench.action.terminal.newWithProfile') }
		];
	}

	const VIEWS: [string, string, () => void][] = [
		['Explorer', 'Side Bar', () => layout.showView('explorer')],
		['Search', 'Side Bar', () => layout.showView('search')],
		['Source Control', 'Side Bar', () => layout.showView('scm')],
		['Run and Debug', 'Side Bar', () => layout.showView('debug')],
		['Agents', 'Side Bar', () => layout.showView('agents')],
		['Problems', 'Panel', () => layout.showPanel('problems')],
		['Output', 'Panel', () => layout.showPanel('output')],
		['Debug Console', 'Panel', () => layout.showPanel('debugConsole')],
		['Terminal', 'Panel', () => layout.showPanel('terminal')]
	];

	function fileItem(path: string, match: Match | undefined, separator: string | undefined, line?: number, column?: number): Item {
		const slash = path.lastIndexOf('/');
		const reveal = line ? { line, column: column ?? 1, focus: true } : undefined;
		return {
			label: path.slice(slash + 1),
			icon: fileIcon(path),
			// A multi-root workspace leads with the file's root folder (VS Code's `folder • dir`).
			detail: fileDetail(path, workspace.folders),
			separator,
			match: match && { score: match.score, positions: match.positions.filter((p) => p > slash).map((p) => p - slash - 1) },
			// workbench.editor.enablePreviewFromQuickOpen (off: Quick Open keeps what it opens).
			run: () => editors.open(path, { preview: settings.get<boolean>('workbench.editor.enablePreviewFromQuickOpen'), reveal }),
			side: () => editors.openToSide(path, reveal)
		};
	}

	const items = $derived.by((): Item[] => {
		if (quick.picker) return pickerItems(quick.picker, quick.value.trim());
		const m = mode!;
		switch (m.kind) {
			case 'commands': {
				const all = commands.paletteItems();
				const label = (c: (typeof all)[number]) => (c.category ? `${c.category}: ${c.title}` : c.title);
				// workbench.commandPalette.history: recently used commands first, VS Code's "recently used" group.
				const history = quick.commandHistory.slice(0, Math.max(0, settings.get<number>('workbench.commandPalette.history')));
				const ranked = withRecentFirst(rank(m.query, all, label, 100), (r) => r.item.id, history);
				return ranked.map(({ item: { item, match }, recent }, i) => ({
					label: label(item),
					key: keyOf(item),
					match,
					separator: !history.length ? undefined : i === 0 && recent ? 'recently used' : !recent && (i === 0 || ranked[i - 1].recent) ? 'other commands' : undefined,
					run: () => {
						quick.recordCommand(item.id);
						void commands.run(item.id);
					}
				}));
			}
			case 'line': {
				if (!editors.active) return [{ label: t('legacyWorkbench.quickInput.openEditorForLine'), run: () => {} }];
				const { line, column } = m;
				return [
					{
						label: line
							? column
								? t('legacyWorkbench.quickInput.gotoLineColumn', { line, column })
								: t('legacyWorkbench.quickInput.gotoLine', { line })
							: t('legacyWorkbench.quickInput.currentLine', { line: editors.cursor.line, column: editors.cursor.column }),
						preview: line
							? () => {
									previewFrom ??= { ...editors.cursor };
									editors.peek(line, column ?? 1);
								}
							: undefined,
						run: () => line && editors.gotoLine(line, column ?? 1)
					}
				];
			}
			case 'symbol': {
				if (!editors.active || isDiffKey(editors.active)) return [{ label: t('legacyWorkbench.quickInput.openEditorForSymbol'), run: () => {} }];
				if (!docSymbols.list.length)
					return [
						{
							label: lsp.hasServer(editors.language)
								? t('legacyWorkbench.quickInput.noSymbols')
								: t('legacyWorkbench.quickInput.noSymbolServer'),
							run: () => {}
						}
					];
				return pickSymbols(docSymbols.list, m.query, m.byKind).map(({ symbol: s, match, separator }) => ({
					label: s.name,
					detail: [SYMBOL_KIND_NAMES[s.kind], s.container].filter(Boolean).join(' · '),
					match,
					separator,
					preview: () => {
						previewFrom ??= { ...editors.cursor };
						editors.peek(s.line, s.column);
					},
					run: () => editors.gotoLine(s.line, s.column),
					side: () => editors.active && editors.openToSide(editors.active, { line: s.line, column: s.column, focus: true })
				}));
			}
			case 'workspaceSymbol': {
				if (!wsSymbols.list.length)
					return [
						{
							label: wsSymbols.busy
								? t('legacyWorkbench.quickInput.searchingSymbols')
								: lsp.hasWorkspaceSymbols()
									? t('legacyWorkbench.quickInput.noMatchingSymbols')
									: t('legacyWorkbench.quickInput.noWorkspaceSymbolServer'),
							run: () => {}
						}
					];
				const ranked = m.query ? rank(m.query, wsSymbols.list, (s) => s.name, 200) : wsSymbols.list.slice(0, 200).map((item) => ({ item, match: undefined }));
				return ranked.map(({ item: s, match }) => ({
					label: s.name,
					detail: [SYMBOL_KIND_NAMES[s.kind], s.container, s.rel].filter(Boolean).join(' · '),
					icon: fileIcon(s.rel),
					match,
					run: () => editors.openAt(s.rel, s.line, s.column),
					side: () => editors.openToSide(s.rel, { line: s.line, column: s.column, focus: true })
				}));
			}
			case 'help':
				return QUICK_ACCESS_HELP.filter((h) => !m.query || h.prefix.startsWith(m.query) || h.label.toLowerCase().includes(m.query.toLowerCase())).map((h) => ({
					label: h.prefix ? `${h.prefix.trim()}` : '…',
					detail: h.label,
					fill: h.prefix,
					run: () => {}
				}));
			case 'view':
				return rank(m.query, VIEWS, ([label]) => label, 50).map(({ item: [label, where, show], match }, i, all) => ({
					label,
					match,
					separator: !m.query && (i === 0 || all[i - 1].item[1] !== where) ? where : undefined,
					run: show
				}));
			case 'editors': {
				const order = editors.order();
				const rows = order.flatMap((gid, gi) => (m.mru ? editors.mru(gid) : (editors.group(gid)?.tabs.map((t) => t.path) ?? [])).map((path) => ({ gid, gi, path })));
				return rank(m.query, rows, (r) => editorLabel(r.path), 200).map(({ item: r, match }, i, all) => ({
					label: editorLabel(r.path),
					detail: r.path.includes('://') || r.path.startsWith('untitled:') ? undefined : fileOf(r.path),
					icon: fileIcon(fileOf(r.path)),
					match,
					separator: order.length > 1 && !m.query && (i === 0 || all[i - 1].item.gid !== r.gid) ? `Group ${r.gi + 1}` : undefined,
					run: () => {
						editors.open(r.path, { group: r.gid });
						editors.focusRequest = r.gid;
					}
				}));
			}
			case 'task': {
				if (taskList.busy) return [{ label: t('workbench.quickAccess.loading'), run: () => {} }];
				const list = taskList.list;
				const byId = new Map(list.map((x) => [x.id, x]));
				// Recently used, configured, then each provider's tasks (taskCommands.svelte.ts), filtered by label.
				const picks = taskPickItems(list, taskList.recent, settings.get<boolean>('task.quickOpen.detail'));
				const shown = m.query ? rank(m.query, picks, (p) => p.label, 200).map(({ item, match }) => ({ pick: { ...item, separator: undefined }, match })) : picks.map((pick) => ({ pick, match: undefined }));
				if (!shown.length) return [{ label: t('ideTasks.pick.noTasks'), run: () => void commands.run('workbench.action.tasks.configureTaskRunner') }];
				return shown.map(({ pick, match }) => ({
					label: pick.label,
					detail: pick.description,
					separator: pick.separator,
					match,
					run: () => {
						const task = byId.get(pick.id);
						if (task) taskList.run(task);
					}
				}));
			}
			case 'debug': {
				if (launchList.busy) return [{ label: t('workbench.quickAccess.loading'), run: () => {} }];
				const ranked = m.query ? rank(m.query, launchList.list, (c) => c.name, 200) : launchList.list.map((item) => ({ item, match: undefined }));
				const start = (name: string) => void import('#lib/debug/debug.svelte.ts').then(({ debug }) => debug.start({ name }));
				return [
					...ranked.map(({ item, match }) => ({ label: item.name, detail: item.description, match, run: () => start(item.name) })),
					{ label: t('workbench.quickAccess.addConfiguration'), separator: ranked.length ? ' ' : undefined, run: () => void commands.run('debug.addConfiguration') }
				];
			}
			case 'term':
				return terminalItems(m.query);
			case 'text': {
				if (!m.query) return [{ label: t('workbench.quickAccess.textEnterTerm'), run: () => {} }];
				const rows: Item[] = [];
				for (const f of textHits.query === m.query ? textHits.files : []) {
					f.matches.forEach((hit, i) => {
						const lead = hit.preview.length - hit.preview.trimStart().length;
						const label = hit.preview.trim();
						const positions = Array.from({ length: Math.max(0, hit.preview_end - hit.preview_start) }, (_, k) => hit.preview_start - lead + k).filter((p) => p >= 0 && p < label.length);
						const reveal = { line: hit.line, column: hit.column, endColumn: hit.end_column, focus: true };
						rows.push({
							label,
							detail: String(hit.line),
							icon: i === 0 ? fileIcon(f.path) : undefined,
							separator: i === 0 ? fileDetail(f.path, workspace.folders) || f.path : undefined,
							match: { score: 0, positions },
							run: () => editors.open(f.path, { preview: settings.get<boolean>('workbench.editor.enablePreviewFromQuickOpen'), reveal }),
							side: () => editors.openToSide(f.path, reveal)
						});
					});
				}
				if (!rows.length) return [{ label: textHits.busy ? t('workbench.quickAccess.searching') : t('workbench.quickAccess.textNoResults'), run: () => {} }];
				// VS Code's "Open in Search View": the same query in Find in Files.
				rows.push({
					label: t('workbench.quickAccess.textOpenInSearch'),
					separator: ' ',
					run: () => {
						search.query = m.query;
						void search.run();
						void commands.run('workbench.view.search');
					}
				});
				return rows;
			}
			case 'files': {
				// search.quickOpen.includeHistory / search.quickOpen.history.filterSortOrder / search.quickOpen.includeSymbols.
				const ranked = rankFiles(m.query, files, recentFiles.list.filter((p) => p !== (m.query ? null : editors.active)), 60, {
					includeHistory: settings.get<boolean>('search.quickOpen.includeHistory'),
					sortOrder: settings.get<'default' | 'recency'>('search.quickOpen.history.filterSortOrder')
				});
				const fileRows = ranked.map((r, i) => fileItem(r.path, r.match, i === 0 && r.recent ? 'recently opened' : !r.recent && (i === 0 || ranked[i - 1].recent) ? 'file results' : undefined, m.line, m.column));
				if (!m.query || !settings.get<boolean>('search.quickOpen.includeSymbols') || wsSymbols.query !== m.query) return fileRows;
				const symbolRows = rank(m.query, wsSymbols.list, (s) => s.name, 30).map(({ item: s, match }, i) => ({
					label: s.name,
					detail: [SYMBOL_KIND_NAMES[s.kind], s.container, s.rel].filter(Boolean).join(' · '),
					icon: fileIcon(s.rel),
					match,
					separator: i === 0 ? 'symbol results' : undefined,
					run: () => editors.openAt(s.rel, s.line, s.column),
					side: () => editors.openToSide(s.rel, { line: s.line, column: s.column, focus: true })
				}));
				return [...fileRows, ...symbolRows];
			}
		}
	});

	function accept(i = index, side = false) {
		const item = items[i];
		if (item?.fill !== undefined) {
			quick.fill(item.fill);
			index = 0;
			input?.focus();
			return;
		}
		previewFrom = null;
		quick.hide({ accepted: true });
		if (side && item?.side) item.side();
		else item?.run();
	}

	function cancel() {
		// A symbol or line preview moved the editor: put it back (VS Code restores the view state).
		if (previewFrom) editors.peek(previewFrom.line, previewFrom.column);
		previewFrom = null;
		quick.hide();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') cancel();
		else if (e.key === 'ArrowDown') index = Math.min(index + 1, items.length - 1);
		else if (e.key === 'ArrowUp') index = Math.max(index - 1, 0);
		else if (e.key === 'Enter') accept(index, isMac ? e.metaKey : e.ctrlKey);
		else return;
		e.preventDefault();
	}

	// VS Code's quickNavigate: releasing the modifier of ⌃Tab opens the focused editor.
	function onKeyUp(e: KeyboardEvent) {
		if (quick.visible && quick.picker?.quickNavigate && (e.key === 'Control' || e.key === 'Meta')) accept();
	}

	const parts = (text: string, positions: number[] = []) => highlightRuns(text, positions);
	const placeholder = $derived(
		quick.picker?.placeholder ??
			(mode?.kind === 'symbol'
				? t('legacyWorkbench.quickInput.placeholderSymbol')
				: mode?.kind === 'workspaceSymbol'
					? t('legacyWorkbench.quickInput.placeholderWorkspaceSymbol')
					: t('legacyWorkbench.quickInput.placeholderFiles'))
	);
</script>

<svelte:window onkeyup={onKeyUp} />

{#if quick.visible}
	<!-- VS Code: 600px wide (or 62% of the window), just below the title bar, no backdrop. Above the
	     modal dialogs (z-[65]: SSH Hosts, Cleanup, …) that open it, so a click on an item reaches it
	     instead of the dialog's backdrop, which would close the dialog and cancel the question. -->
	<div
		role="dialog"
		aria-label="Quick open"
		tabindex="-1"
		style:top={quickInputTop(quick.alignment)}
		class="fixed left-1/2 z-[70] w-[min(600px,62vw)] -translate-x-1/2 rounded-xl border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) p-2 text-(--vscode-quickInput-foreground) shadow-2xl shadow-black/50"
		onfocusout={(e) => {
			// workbench.quickOpen.closeOnFocusLost
			if (!e.currentTarget.contains(e.relatedTarget as Node | null) && settings.get<boolean>('workbench.quickOpen.closeOnFocusLost')) cancel();
		}}
	>
		{#if quick.picker?.title}
			<div class="mb-1 truncate px-1 text-xs font-semibold">{quick.picker.title}</div>
		{/if}
		{#if quick.picker?.message?.length}
			<p id="quick-input-message" class="mb-2 max-h-48 overflow-y-auto px-1 text-xs leading-relaxed break-words whitespace-pre-wrap text-(--vscode-descriptionForeground) select-text"><!-- pre-wrap: no whitespace around the runs -->{#each quick.picker.message as run, k (k)}{#if run.mono}<code class="font-mono break-all text-(--vscode-quickInput-foreground)">{run.text}</code>{:else}{run.text}{/if}{/each}</p>
		{/if}
		<input
			bind:this={input}
			bind:value={quick.value}
			type={quick.picker?.password ? 'password' : 'text'}
			oninput={() => (index = 0)}
			onkeydown={onKey}
			aria-describedby={quick.picker?.message?.length ? 'quick-input-message' : undefined}
			aria-label={t('legacyWorkbench.quickInput.searchAria')}
			{placeholder}
			class="h-8 w-full rounded-lg border border-(--vscode-focusBorder) bg-(--vscode-input-background) px-2.5 text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground)"
		/>
		<ul bind:this={list} role="listbox" aria-label={t('legacyWorkbench.quickInput.results')} class="mt-1.5 max-h-[440px] overflow-y-auto">
			{#each items as item, i (i)}
				<li role="option" aria-selected={i === index} class={[item.separator && i > 0 && 'mt-px border-t border-(--vscode-widget-border)']}>
					<button
						tabindex="-1"
						class={[
							'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left',
							i === index ? 'bg-(--vscode-quickInputList-focusBackground) text-(--vscode-list-activeSelectionForeground)' : 'hover:bg-(--vscode-list-hoverBackground)'
						]}
						onmousemove={() => (index = i)}
						onclick={(e) => accept(i, isMac ? e.metaKey : e.ctrlKey)}
					>
						{#if item.pick?.agent}<AgentIcon agent={item.pick.agent} size={16} />{:else if item.icon}<FileIcon icon={item.icon} />{/if}
						<span class="truncate">
							{#each parts(item.label, item.match?.positions) as p, k (k)}<span class={p.hit ? 'font-bold text-(--vscode-list-highlightForeground)' : undefined}>{p.text}</span>{/each}
						</span>
						{#if item.detail}<span class="min-w-0 truncate text-xs text-(--vscode-descriptionForeground)">{item.detail}</span>{/if}
						{#if item.separator}<span class="ml-auto shrink-0 text-xs text-(--vscode-descriptionForeground)">{item.separator}</span>{/if}
						{#if item.key}<span class="ml-auto shrink-0 font-mono text-xs text-(--vscode-descriptionForeground)">{keyLabel(item.key)}</span>{/if}
					</button>
				</li>
			{:else}
				<li class="px-1.5 py-1 text-(--vscode-descriptionForeground)">{t('legacyWorkbench.quickInput.noResults')}</li>
			{/each}
		</ul>
	</div>
{/if}
