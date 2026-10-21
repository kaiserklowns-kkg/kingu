<script lang="ts">
	// Settings › Keyboard Shortcuts (VS Code's keybindings editor): every command with its key, when
	// clause and source; search by name, id, key or a recorded keystroke (`@source:user`,
	// `@command:id`, `"⌘K ⌘T"`); change, add, remove and reset keys, edit the when clause and see
	// the commands that share a key. Edits go to keybindings.json (keybindingsEditor.ts).
	import { tick, untrack } from 'svelte';
	import { commands } from '#lib/workbench/commands.svelte.ts';
	import { keybindings, USER_KEYBINDINGS_KEY } from '#lib/workbench/keybindings.svelte.ts';
	import { isMac, keyLabel, keyOf as defaultKeyOf } from '#lib/workbench/keys.ts';
	import {
		addKeybinding,
		appendChord,
		changeKeybinding,
		chordLabels,
		chordPrefixRows,
		conflictCounts,
		filterKeybindingRows,
		keybindingRows,
		parseKeybindingQuery,
		recordedChord,
		removeKeybinding,
		resetKeybinding,
		sameKeyRows,
		sortByPrecedence,
		type KeybindingRow
	} from '#lib/workbench/keybindingsEditor.ts';
	import { parseWhen } from '#lib/workbench/contextKey.ts';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import { quick } from '#lib/workbench/quick.svelte.ts';
	import { popupMenuAt } from '#lib/workbench/popupMenuAt.ts';
	import { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { systemSettings } from '../systemSettings.svelte';

	const RECORD_KEY = 'alt+cmd+k';

	let query = $state('');
	let recording = $state(false);
	/** VS Code's Sort by Precedence toggle. */
	let byPrecedence = $state(false);
	let selected = $state(-1);
	let searchEl = $state<HTMLInputElement>();
	let listEl = $state<HTMLDivElement>();
	/** The define-keybinding widget: the row it changes (or adds to), and what has been pressed. */
	let define = $state<{ row: KeybindingRow; add: boolean; key: string } | null>(null);
	let defineEl = $state<HTMLInputElement>();

	const all = $derived(
		keybindingRows(
			commands.all.map((c) => ({ id: c.id, title: c.title, category: c.category, palette: c.palette, scope: c.scope, defaultKey: defaultKeyOf(c) ?? c.ownerKey?.(), weight: c.weight })),
			keybindings.user
		).sort((a, b) => a.title.localeCompare(b.title) || a.command.localeCompare(b.command) || a.source.localeCompare(b.source))
	);
	const conflicts = $derived(new Map(conflictCounts(all).map((n, i) => [all[i], n])));
	const rows = $derived.by(() => {
		const found = filterKeybindingRows(all, parseKeybindingQuery(query));
		return byPrecedence ? sortByPrecedence(found) : found;
	});
	const selectedRow = $derived(rows[selected] as KeybindingRow | undefined);
	const defineConflicts = $derived(define?.key ? sameKeyRows(all, define.key, define.row.scope).filter((r) => r.command !== define!.row.command) : []);
	const definePrefix = $derived(define?.key ? chordPrefixRows(all, define.key, define.row.scope, define.row.command) : []);

	$effect(() => {
		void query;
		// A new search selects its first row; an edit (rows change under the same search) keeps the place.
		selected = untrack(() => (rows.length ? 0 : -1));
	});

	async function edit(change: (text: string) => string) {
		try {
			await keybindings.edit(change);
		} catch (e) {
			notifications.error(t('keybindings.editFailed', { error: e instanceof Error ? e.message : String(e) }));
		}
	}

	async function startDefine(row: KeybindingRow, add = false) {
		define = { row, add, key: '' };
		await tick();
		defineEl?.focus();
	}

	function onDefineKey(e: KeyboardEvent) {
		if (!define || ['Meta', 'Control', 'Shift', 'Alt', 'CapsLock', 'Fn'].includes(e.key)) return;
		e.preventDefault();
		e.stopPropagation();
		const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
		if (plain && e.key === 'Escape') return closeDefine();
		if (plain && e.key === 'Enter' && define.key) return void acceptDefine();
		define.key = appendChord(define.key, recordedChord(e));
	}

	async function acceptDefine() {
		if (!define?.key) return;
		const { row, add, key } = define;
		closeDefine();
		await edit((text) => (add || !row.key ? addKeybinding(text, row.command, key, add ? undefined : row.when) : changeKeybinding(text, row, key, undefined)));
		query = `"${key}"`;
	}

	function closeDefine() {
		define = null;
		listEl?.focus();
	}

	async function changeWhen(row: KeybindingRow) {
		const when = await quick.input({
			placeholder: t('keybindings.whenPlaceholder', { command: row.title }),
			value: row.when,
			hint: (v) => {
				if (!v.trim()) return t('keybindings.whenAlways');
				try {
					parseWhen(v);
					return t('keybindings.whenOk', { when: v.trim() });
				} catch (e) {
					return t('keybindings.whenInvalid', { error: e instanceof Error ? e.message : String(e) });
				}
			}
		});
		if (when === undefined || when.trim() === row.when) return;
		try {
			if (when.trim()) parseWhen(when);
		} catch {
			return;
		}
		await edit((text) => changeKeybinding(text, row, row.key, when.trim()));
	}

	const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

	function run(id: string) {
		systemSettings.close();
		void commands.run(id);
	}

	function openJson() {
		systemSettings.close();
		editors.open(USER_KEYBINDINGS_KEY, { preview: false });
	}

	function showSame(row: KeybindingRow) {
		query = `"${row.key}"`;
	}

	function menu(e: MouseEvent, row: KeybindingRow, index: number) {
		e.preventDefault();
		selected = index;
		const bound = !!row.key;
		const items = [
			menuItem('copy', t('keybindings.copy')),
			menuItem('copyId', t('keybindings.copyId')),
			menuItem('copyTitle', t('keybindings.copyTitle')),
			menuSeparator,
			menuItem('change', t('keybindings.change')),
			menuItem('add', t('keybindings.add'), { enabled: bound }),
			menuItem('when', t('keybindings.changeWhen'), { enabled: bound }),
			menuSeparator,
			menuItem('remove', t('keybindings.remove'), { enabled: bound }),
			menuItem('reset', t('keybindings.reset'), { enabled: row.source === 'user' || keybindings.user.removed.has(row.command) }),
			menuSeparator,
			menuItem('same', t('keybindings.showSame'), { enabled: bound }),
			menuItem('run', t('keybindings.run'), { enabled: commands.enabled(row.command) })
		];
		popupMenuAt(e.clientX, e.clientY, t('keybindings.title'), items, (id) => {
			if (id === 'copy') copy(`${row.title} (${row.command})${row.key ? `  ${keyLabel(row.key)}` : ''}${row.when ? `  when: ${row.when}` : ''}`);
			else if (id === 'copyId') copy(row.command);
			else if (id === 'copyTitle') copy(row.title);
			else if (id === 'change') void startDefine(row);
			else if (id === 'add') void startDefine(row, true);
			else if (id === 'when') void changeWhen(row);
			else if (id === 'remove') void edit((text) => removeKeybinding(text, row));
			else if (id === 'reset') void edit((text) => resetKeybinding(text, row.command));
			else if (id === 'same') showSame(row);
			else if (id === 'run') run(row.command);
		});
	}

	function onListKey(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			selected = Math.max(0, Math.min(rows.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1)));
			listEl?.querySelector(`[data-row="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
		} else if (e.key === 'Enter' && selectedRow) {
			e.preventDefault();
			void startDefine(selectedRow);
		} else if ((e.key === 'Delete' || (isMac && e.key === 'Backspace' && e.metaKey)) && selectedRow?.key) {
			e.preventDefault();
			void edit((text) => removeKeybinding(text, selectedRow));
		}
	}

	function onSearchKey(e: KeyboardEvent) {
		const toggle = e.altKey && (isMac ? e.metaKey : e.ctrlKey) && e.code === 'KeyK';
		if (toggle) {
			e.preventDefault();
			recording = !recording;
			return;
		}
		if (recording) {
			if (['Meta', 'Control', 'Shift', 'Alt', 'CapsLock', 'Fn'].includes(e.key)) return;
			e.preventDefault();
			if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
				recording = false;
				return;
			}
			const current = parseKeybindingQuery(query).key ?? '';
			query = `"${appendChord(current, recordedChord(e))}"`;
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			listEl?.focus();
		}
	}

	function toggleRecording() {
		recording = !recording;
		searchEl?.focus();
	}

	const sourceLabel = (r: KeybindingRow) => (r.source === 'user' ? t('keybindings.sourceUser') : r.source === 'default' ? t('keybindings.sourceDefault') : '');
</script>

<div class="flex h-full flex-col">
	<div class="mx-auto flex w-full max-w-[1100px] shrink-0 items-center gap-3 px-8 pt-6 pb-3">
		<div class="flex-1">
			<h1 class="text-lg font-semibold">{t('keybindings.title')}</h1>
			<p class="mt-1 text-[13px] text-(--vscode-descriptionForeground)">{t('keybindings.summary', { count: rows.length })}</p>
		</div>
		<button class="rounded-md px-2 py-1 text-[13px] hover:bg-(--vscode-toolbar-hoverBackground)" class:bg-(--vscode-toolbar-activeBackground)={query.includes('@source:user')} onclick={() => (query = query.includes('@source:user') ? query.replace(/@source:user\s*/, '') : `@source:user ${query}`.trim())}>{t('keybindings.showUser')}</button>
		<button class="rounded-md px-2 py-1 text-[13px] hover:bg-(--vscode-toolbar-hoverBackground)" class:bg-(--vscode-toolbar-activeBackground)={/@conflicts\b/.test(query)} onclick={() => (query = /@conflicts\b/.test(query) ? query.replace(/@conflicts\s*/, '') : `@conflicts ${query}`.trim())}>{t('keybindings.showConflicts')}</button>
		<button class="rounded-md p-1 hover:bg-(--vscode-toolbar-hoverBackground)" class:bg-(--vscode-toolbar-activeBackground)={byPrecedence} title={t('keybindings.sortPrecedence')} aria-label={t('keybindings.sortPrecedence')} aria-pressed={byPrecedence} onclick={() => (byPrecedence = !byPrecedence)}><Icon name="sliders" size={16} /></button>
		<button class="rounded-md p-1 hover:bg-(--vscode-toolbar-hoverBackground)" title={t('keybindings.openJson')} aria-label={t('keybindings.openJson')} onclick={openJson}><Icon name="code" size={16} /></button>
	</div>
	<div class="mx-auto w-full max-w-[1100px] shrink-0 px-8 pb-3">
		<label class="relative flex items-center">
			<span class="pointer-events-none absolute left-2.5 text-(--vscode-input-placeholderForeground)"><Icon name="search" size={15} /></span>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				bind:this={searchEl}
				bind:value={query}
				autofocus
				data-keybinding-capture={recording ? '' : undefined}
				onkeydown={onSearchKey}
				placeholder={recording ? t('keybindings.searchRecording') : t('keybindings.search')}
				class="h-8 w-full rounded-md border bg-(--vscode-input-background) pr-16 pl-8 text-[13px] outline-none {recording ? 'border-(--vscode-inputOption-activeBorder)' : 'border-(--vscode-input-border) focus:border-(--vscode-focusBorder)'}"
			/>
			<span class="absolute right-1 flex gap-0.5">
				{#if query}
					<button class="rounded p-1 hover:bg-(--vscode-toolbar-hoverBackground)" title={t('keybindings.clear')} aria-label={t('keybindings.clear')} onclick={() => ((query = ''), searchEl?.focus())}><Icon name="close" size={14} /></button>
				{/if}
				<button
					class="rounded p-1 hover:bg-(--vscode-toolbar-hoverBackground) {recording ? 'bg-(--vscode-inputOption-activeBackground) text-(--vscode-inputOption-activeForeground)' : ''}"
					title={t('keybindings.recordKeys', { key: keyLabel(RECORD_KEY) })}
					aria-label={t('keybindings.recordKeys', { key: keyLabel(RECORD_KEY) })}
					aria-pressed={recording}
					onclick={toggleRecording}><Icon name="keyboard" size={14} /></button>
			</span>
		</label>
	</div>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div bind:this={listEl} class="min-h-0 flex-1 overflow-y-auto outline-none" tabindex="0" role="grid" aria-label={t('keybindings.title')} onkeydown={onListKey}>
		<table class="mx-auto w-full max-w-[1100px] table-fixed border-separate border-spacing-0 px-8 text-[13px]">
			<thead class="sticky top-0 bg-(--vscode-editor-background) text-left text-xs text-(--vscode-descriptionForeground)">
				<tr>
					<th class="border-b border-(--vscode-widget-border) py-2 pl-3 font-medium">{t('keybindings.colCommand')}</th>
					<th class="w-52 border-b border-(--vscode-widget-border) py-2 font-medium">{t('keybindings.colKey')}</th>
					<th class="w-56 border-b border-(--vscode-widget-border) py-2 font-medium">{t('keybindings.colWhen')}</th>
					<th class="w-20 border-b border-(--vscode-widget-border) py-2 pr-3 font-medium">{t('keybindings.colSource')}</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as r, i (`${r.command}\u0000${r.key}\u0000${r.source}`)}
					{@const count = conflicts.get(r) ?? 0}
					<tr
						data-row={i}
						class="group cursor-default {i === selected ? 'bg-(--vscode-list-inactiveSelectionBackground)' : 'hover:bg-(--vscode-list-hoverBackground)'}"
						onclick={() => (selected = i)}
						ondblclick={() => void startDefine(r)}
						oncontextmenu={(e) => menu(e, r, i)}
					>
						<td class="truncate rounded-l-md py-1.5 pl-3" title={r.command}>
							{r.title}
							<span class="ml-1 font-mono text-xs text-(--vscode-descriptionForeground)">{r.command}</span>
						</td>
						<td class="py-1.5">
							{#if r.key}
								<span class="flex items-center gap-1">
									{#each chordLabels(r.key) as chord, j (j)}
										<kbd class="rounded-md border border-(--vscode-widget-border) bg-(--vscode-editorGroupHeader-tabsBackground) px-1.5 py-0.5 font-sans text-xs">{chord}</kbd>
									{/each}
									{#if count}
										<button class="ml-1 text-xs text-(--vscode-textLink-foreground) hover:underline" title={t('keybindings.conflicts', { count })} onclick={(e) => (e.stopPropagation(), showSame(r))}>+{count}</button>
									{/if}
								</span>
							{:else}<span class="text-(--vscode-descriptionForeground)">—</span>{/if}
						</td>
						<td class="truncate py-1.5 font-mono text-xs" title={r.when}>{r.when || (r.key ? '—' : '')}</td>
						<td class="truncate rounded-r-md py-1.5 pr-3 text-xs text-(--vscode-descriptionForeground)">{sourceLabel(r)}</td>
					</tr>
				{:else}
					<tr><td colspan="4" class="py-8 text-center text-(--vscode-descriptionForeground)">{t('keybindings.none', { query })}</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

{#if define}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[20vh]" onclick={closeDefine}>
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="w-[420px] rounded-lg border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) p-4 shadow-lg" onclick={(e) => e.stopPropagation()}>
			<p class="text-[13px]">{t('keybindings.define')}</p>
			<p class="mt-0.5 truncate text-xs text-(--vscode-descriptionForeground)">{t('keybindings.defineFor', { command: define.row.title })}</p>
			<input
				bind:this={defineEl}
				data-keybinding-capture
				readonly
				value={define.key ? keyLabel(define.key) : ''}
				onkeydown={onDefineKey}
				aria-label={t('keybindings.define')}
				class="mt-3 h-8 w-full rounded-md border border-(--vscode-focusBorder) bg-(--vscode-input-background) px-2 text-center text-[13px] outline-none"
			/>
			{#if define.key && chordLabels(define.key).length === 1}
				<p class="mt-1.5 text-center text-xs text-(--vscode-descriptionForeground)">{t('keybindings.chordHint')}</p>
			{/if}
			{#if definePrefix.length}
				<p class="mt-2 text-xs text-(--vscode-editorWarning-foreground)">{t('keybindings.prefixConflicts', { count: definePrefix.length })}</p>
			{/if}
			{#if defineConflicts.length}
				<button class="mt-2 text-xs text-(--vscode-textLink-foreground) hover:underline" onclick={() => { const key = define!.key; closeDefine(); query = `"${key}"`; }}>
					{t('keybindings.defineConflicts', { count: defineConflicts.length })}
				</button>
			{/if}
		</div>
	</div>
{/if}
