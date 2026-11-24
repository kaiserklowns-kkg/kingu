<script lang="ts">
	// Debug Console (VS Code: repl.ts): the session's output and an expression input evaluated in
	// the selected stack frame. ↑/↓ walk the input history; earlier inputs that start with what is
	// typed are suggested (debug.console.historySuggestions: Tab accepts, and Enter too with
	// debug.console.acceptSuggestionOnEnter on). Font, line height, wrapping and collapsing of
	// identical lines follow the debug.console.* settings. While debugging, the adapter's completions
	// (DAP `completions`) come first, as you type and on ⌃Space (VS Code's REPL suggest widget).
	import { untrack } from 'svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { debug } from './debug.svelte.ts';
	import { collapseLines, consoleFont, historyMatches } from './debugSettings.ts';
	import type { CompletionItem } from './protocol.ts';
	import { applyCompletion, rankCompletions, wordBefore } from './replCompletion.ts';
	import { replFilter } from './debugViewKeys.ts';
	import { findInLines, pieces, stepMatch } from './replFind.ts';
	import { t } from '#lib/i18n/index.ts';

	let input = $state('');
	let history = $state<string[]>([]);
	let historyAt = -1;
	let scroller: HTMLDivElement | undefined = $state();
	let suggestionAt = $state(0);
	let browsing = $state(false);

	// The filter (VS Code's repl filter, ⌘F with focus in the console): `text, !exclude`.
	let filter = $state('');
	let filterEl: HTMLInputElement | undefined = $state();
	const allOutput = $derived(collapseLines(debug.model?.output ?? [], settings.get<boolean>('debug.console.collapseIdenticalLines')));
	const output = $derived.by(() => {
		const keep = replFilter(filter);
		return filter.trim() ? allOutput.filter((l) => keep(l.text)) : allOutput;
	});
	// Find (repl.ts `repl.action.find`, ⌥⌘F): highlights every match in the shown lines; ↵ / ⇧↵ move
	// between them, Escape closes the box and goes back to the input.
	let findOpen = $state(false);
	let findQuery = $state('');
	let findAt = $state(-1);
	let findEl: HTMLInputElement | undefined = $state();
	const matches = $derived(findOpen ? findInLines(output.map((l) => l.text), findQuery) : []);
	/** The index of each line's first match (for cutting the line into pieces). */
	const firstMatch = $derived.by(() => {
		const first = new Map<number, number>();
		matches.forEach((m, i) => first.has(m.line) || first.set(m.line, i));
		return first;
	});
	$effect(() => {
		if (!debug.consoleFindRequested) return;
		debug.consoleFindRequested = false;
		findOpen = true;
		queueMicrotask(() => (findEl?.focus(), findEl?.select()));
	});
	// A new query starts at the first match; matches that went away clamp the current one.
	$effect(() => {
		void findQuery;
		findAt = untrack(() => matches.length) ? 0 : -1;
		revealMatch();
	});
	$effect(() => {
		if (findAt >= matches.length) findAt = matches.length ? matches.length - 1 : -1;
	});
	function revealMatch() {
		queueMicrotask(() => scroller?.querySelector('[data-current-match]')?.scrollIntoView({ block: 'nearest' }));
	}
	function onFindKey(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			findAt = stepMatch(findAt, matches.length, !e.shiftKey);
			revealMatch();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			closeFind();
		}
	}
	function closeFind() {
		findOpen = false;
		findQuery = '';
		inputEl?.focus();
	}

	const MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
	function onConsoleKey(e: KeyboardEvent) {
		if (e.key.toLowerCase() !== 'f' || !(MAC ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return;
		filterEl?.focus();
		filterEl?.select();
		e.preventDefault();
		e.stopPropagation();
	}
	const font = $derived(consoleFont(settings.get<string>('debug.console.fontFamily'), settings.get<number>('debug.console.fontSize'), settings.get<number>('debug.console.lineHeight')));
	const wrap = $derived(settings.get<boolean>('debug.console.wordWrap'));
	let completions = $state<CompletionItem[]>([]);
	let inputEl: HTMLInputElement | undefined = $state();
	let caret = $state(0);
	type Suggestion = { label: string; detail?: string; item?: CompletionItem };
	const suggestions = $derived<Suggestion[]>(
		browsing
			? []
			: [
					...rankCompletions(completions, wordBefore(input, caret).word).map((item) => ({ label: item.label, detail: item.type, item })),
					...historyMatches(history, input, settings.get<boolean>('debug.console.historySuggestions')).map((h) => ({ label: h }))
				].slice(0, 30)
	);

	let completionTimer: ReturnType<typeof setTimeout> | undefined;
	/** Asks the adapter for completions at the caret (debounced while typing). */
	function requestCompletions(now = false) {
		clearTimeout(completionTimer);
		const text = input;
		const at = inputEl?.selectionStart ?? text.length;
		caret = at;
		if (!debug.capabilities.supportsCompletionsRequest || !debug.active) {
			completions = [];
			return;
		}
		const run = async () => {
			const items = await debug.completions(text, at + 1);
			if (input === text) completions = items;
		};
		if (now) void run();
		else completionTimer = setTimeout(run, 120);
	}

	// Follow the output while scrolled to the bottom.
	$effect(() => {
		void output.length;
		const el = scroller;
		if (!el) return;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		if (atBottom) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
	});

	function accept(i = suggestionAt) {
		const s = suggestions[i];
		if (s?.item) {
			const next = applyCompletion(input, caret, s.item);
			input = next.text;
			caret = next.cursor;
			queueMicrotask(() => inputEl?.setSelectionRange(next.cursor, next.cursor));
		} else if (s !== undefined) input = s.label;
		completions = [];
		suggestionAt = 0;
	}

	function onKey(e: KeyboardEvent) {
		const suggesting = suggestions.length > 0;
		if (e.key === ' ' && e.ctrlKey) {
			e.preventDefault();
			browsing = false;
			requestCompletions(true);
		} else if (suggesting && e.key === 'Tab') {
			e.preventDefault();
			accept();
		} else if (suggesting && e.key === 'Enter' && settings.get<string>('debug.console.acceptSuggestionOnEnter') === 'on') {
			e.preventDefault();
			accept();
		} else if (e.key === 'Enter' && input.trim()) {
			const expr = input.trim();
			history = [expr, ...history.filter((h) => h !== expr)].slice(0, 100);
			historyAt = -1;
			input = '';
			browsing = false;
			completions = [];
			void debug.repl(expr);
		} else if (suggesting && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
			e.preventDefault();
			suggestionAt = (suggestionAt + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length;
		} else if (e.key === 'Escape' && suggesting) {
			browsing = true;
		} else if (e.key === 'ArrowUp' && history.length) {
			e.preventDefault();
			browsing = true;
			historyAt = Math.min(historyAt + 1, history.length - 1);
			input = history[historyAt];
		} else if (e.key === 'ArrowDown' && historyAt >= 0) {
			e.preventDefault();
			browsing = true;
			historyAt -= 1;
			input = historyAt >= 0 ? history[historyAt] : '';
		}
	}

	const color: Record<string, string> = {
		stderr: 'text-(--vscode-errorForeground)',
		important: 'text-(--vscode-editorWarning-foreground)',
		input: 'text-(--vscode-descriptionForeground)',
		console: 'text-(--vscode-descriptionForeground)'
	};
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex h-full flex-col" data-debug-console onkeydown={onConsoleKey}>
	{#if allOutput.length || filter || findOpen || debug.sessions.length > 1}
		<div class="flex shrink-0 flex-wrap items-center justify-end gap-1 px-2 pt-1">
			{#if debug.sessions.length > 1}
				<!-- VS Code's Select Debug Console (repl.ts `workbench.action.debug.selectRepl`), shown with several sessions. -->
				<select
					aria-label={t('debugger.console.select')}
					title={t('debugger.console.select')}
					value={debug.focusedKey}
					onchange={(e) => debug.focusSession(Number(e.currentTarget.value))}
					class="mr-auto h-[22px] max-w-56 rounded-sm border border-(--vscode-dropdown-border,transparent) bg-(--vscode-dropdown-background) px-1 text-xs text-(--vscode-dropdown-foreground) outline-none focus:border-(--vscode-focusBorder)"
				>
					{#each debug.sessions as s (s.key)}<option value={s.key}>{s.parentKey !== null ? `\u00a0\u00a0${s.name}` : s.name}</option>{/each}
				</select>
			{/if}
			{#if findOpen}
				<div class="flex items-center gap-0.5 rounded-sm border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) pr-0.5 focus-within:border-(--vscode-focusBorder)">
					<input
						bind:this={findEl}
						bind:value={findQuery}
						aria-label={t('debugger.console.find')}
						placeholder={t('debugger.console.find')}
						spellcheck="false"
						onkeydown={onFindKey}
						class="h-[20px] w-40 bg-transparent px-1.5 text-xs text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground)"
					/>
					<span class="min-w-14 px-1 text-[11px] whitespace-nowrap text-(--vscode-descriptionForeground)" role="status">
						{findQuery ? (matches.length ? t('debugger.console.findCount', { current: findAt + 1, count: matches.length }) : t('debugger.console.findNone')) : ''}
					</span>
					<button class="grid size-5 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40" aria-label={t('debugger.console.findPrevious')} title={t('debugger.console.findPrevious')} disabled={!matches.length} onclick={() => ((findAt = stepMatch(findAt, matches.length, false)), revealMatch())}><Icon name="arrowUp" size={14} /></button>
					<button class="grid size-5 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40" aria-label={t('debugger.console.findNext')} title={t('debugger.console.findNext')} disabled={!matches.length} onclick={() => ((findAt = stepMatch(findAt, matches.length, true)), revealMatch())}><Icon name="arrowDown" size={14} /></button>
					<button class="grid size-5 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={t('common.close')} title={t('common.close')} onclick={closeFind}><Icon name="close" size={14} /></button>
				</div>
			{/if}
			<input
				bind:this={filterEl}
				bind:value={filter}
				aria-label={t('debugger.console.filter')}
				placeholder={t('debugger.console.filter')}
				spellcheck="false"
				onkeydown={(e) => e.key === 'Escape' && filter && ((filter = ''), e.stopPropagation())}
				class="h-[22px] w-56 max-w-full rounded-sm border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) px-1.5 text-xs text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground) focus:border-(--vscode-focusBorder)"
			/>
		</div>
	{/if}
	<div
		bind:this={scroller}
		class={['relative min-h-0 flex-1 overflow-auto px-5 py-1', !font.family && 'font-mono', wrap ? 'whitespace-pre-wrap' : 'whitespace-pre']}
		style:font-family={font.family}
		style:font-size={font.size}
		style:line-height={font.lineHeight}
	>
		{#if output.length}
			<button aria-label="Clear Console" title="Clear Console" class="sticky top-0 float-right grid size-5 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => debug.clearConsole()}>
				<Icon name="trash" size={14} />
			</button>
			{#each output as line, i (i)}<span class={color[line.category]}>{#if line.count > 1}<span
							class="mr-1 rounded-full bg-(--vscode-badge-background) px-1.5 text-[11px] text-(--vscode-badge-foreground)"
							title={t('legacySettings.debugConsole.repeated', { count: line.count })}>{line.count}</span
						>{/if}{#if firstMatch.has(i)}{#each pieces(line.text, matches, i, firstMatch.get(i) ?? 0) as p, j (j)}{#if p.match === null}{p.text}{:else}<mark
								data-current-match={p.match === findAt ? '' : undefined}
								class={p.match === findAt ? 'bg-(--vscode-editor-findMatchBackground) text-inherit outline outline-1 outline-(--vscode-editor-findMatchBorder,transparent)' : 'bg-(--vscode-editor-findMatchHighlightBackground) text-inherit'}>{p.text}</mark
							>{/if}{/each}{:else}{line.text}{/if}</span
				>{/each}
		{:else}
			<span class="text-(--vscode-descriptionForeground)">{filter.trim() && allOutput.length ? t('debugger.console.filterNone') : debug.active ? '' : t('legacySettings.debugConsole.empty')}</span>
		{/if}
	</div>
	<div class="relative flex shrink-0 items-center gap-1 border-t border-(--vscode-panel-border) px-2">
		{#if suggestions.length}
			<ul role="listbox" aria-label="History suggestions" class="absolute bottom-full left-6 z-10 max-w-[60%] min-w-48 rounded-sm border border-(--vscode-editorSuggestWidget-border,var(--vscode-widget-border)) bg-(--vscode-editorSuggestWidget-background,var(--vscode-editorWidget-background)) py-0.5 font-mono text-xs shadow-lg">
				{#each suggestions as s, i (`${s.item ? 'c' : 'h'}:${s.label}`)}
					<li role="option" aria-selected={i === suggestionAt}>
						<button
							class={['flex w-full items-center gap-2 px-2 py-0.5 text-left', i === suggestionAt && 'bg-(--vscode-editorSuggestWidget-selectedBackground,var(--vscode-list-activeSelectionBackground))']}
							onmousedown={(e) => (e.preventDefault(), accept(i))}
							><span class="min-w-0 flex-1 truncate">{s.label}</span>{#if s.detail}<span class="shrink-0 text-(--vscode-descriptionForeground)">{s.detail}</span>{/if}</button
						>
					</li>
				{/each}
			</ul>
		{/if}
		<Icon name="chevronRight" size={14} />
		<input
			aria-label="Debug Console input"
			placeholder={debug.stopped ? t('legacySettings.debugConsole.evaluatePlaceholder') : 'Debug Console'}
			bind:value={input}
			bind:this={inputEl}
			oninput={() => ((browsing = false), (suggestionAt = 0), requestCompletions())}
			onclick={() => (caret = inputEl?.selectionStart ?? input.length)}
			onkeydown={onKey}
			spellcheck="false"
			class="h-[26px] min-w-0 flex-1 bg-transparent font-mono text-xs text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground)"
		/>
	</div>
</div>
