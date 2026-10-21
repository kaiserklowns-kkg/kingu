<script lang="ts">
	// VS Code's Search Editor (searchEditor.ts): the query widget (query, Match Case / Whole Word /
	// Regex, context lines, files to include / exclude behind "…") above a read-only Monaco editor
	// holding the results in the `.code-search` text format. Result and file lines open their
	// location per search.searchEditor.singleClickBehaviour / doubleClickBehaviour. The results are
	// editable like VS Code's (typing makes the editor dirty; Save writes the `.code-search` file).
	import { onMount, untrack } from 'svelte';
	import type * as Monaco from 'monaco-editor';
	import Icon from './Icon.svelte';
	import { editors } from './editors.svelte';
	import { keyLabel } from './keys';
	import { searchEditors } from './searchEditor.svelte.ts';
	import { locationAt, modifyContextLines } from './searchEditor';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { t } from '#lib/i18n/index.ts';

	let { editorKey, group }: { editorKey: string; group: number } = $props();

	// The group re-mounts this view per key (`{#key}`), so the state is read once.
	const s = untrack(() => searchEditors.get(editorKey));
	let showDetails = $state(untrack(() => s.config.showIncludesExcludes));
	let input: HTMLInputElement | undefined = $state();
	let host: HTMLDivElement;
	let editor = $state<Monaco.editor.IStandaloneCodeEditor | undefined>();
	let decorations: Monaco.editor.IEditorDecorationsCollection | undefined;
	/** The matches, apart: Monaco moves them with the user's edits, and they become the state's ranges. */
	let matchDecorations: Monaco.editor.IEditorDecorationsCollection | undefined;

	/** The results text's line decorations: `path:` lines and line number gutters. */
	function decorate(m: typeof Monaco, text: string) {
		const lines = text.split('\n');
		const out: Monaco.editor.IModelDeltaDecoration[] = [];
		lines.forEach((line, i) => {
			if (/^\S.*:$/.test(line)) out.push({ range: new m.Range(i + 1, 1, i + 1, line.length + 1), options: { inlineClassName: 'kg-search-editor-file' } });
			const num = /^(\s+\d+)(: |  )/.exec(line);
			if (num) out.push({ range: new m.Range(i + 1, 1, i + 1, num[1].length + 2), options: { inlineClassName: 'kg-search-editor-lineno' } });
		});
		return out;
	}

	const matchOptions = (m: typeof Monaco): Monaco.editor.IModelDecorationOptions => ({
		inlineClassName: 'kg-search-editor-match',
		stickiness: m.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		overviewRuler: { color: 'rgba(234, 92, 0, 0.6)', position: m.editor.OverviewRulerLane.Center }
	});

	/** The status bar's Ln/Col and language follow this editor while it is the active one. */
	function reportStatus(ed: Monaco.editor.IStandaloneCodeEditor) {
		if (editors.active !== s.key) return;
		const pos = ed.getPosition();
		const model = ed.getModel();
		if (pos) editors.cursor = { line: pos.lineNumber, column: pos.column };
		if (!model) return;
		const opts = model.getOptions();
		editors.language = model.getLanguageId();
		editors.indent = opts.insertSpaces ? `Spaces: ${opts.indentSize}` : `Tab Size: ${opts.tabSize}`;
		editors.eol = model.getEOL() === '\n' ? 'LF' : 'CRLF';
		editors.selection = { chars: 0, count: 1 };
	}

	onMount(() => {
		let gone = false;
		let model: Monaco.editor.ITextModel | undefined;
		void import('#lib/editor/monaco.ts').then(async (mod) => {
			await mod.setupTextMate();
			if (gone) return;
			const m = mod.monaco;
			model = m.editor.createModel(s.text, 'search-result', m.Uri.from({ scheme: 'search-editor', path: '/' + editorKey }));
			const ed = m.editor.create(host, {
				model,
				theme: mod.THEME_ID,
				automaticLayout: true,
				// No bracket pair colors, guides or matching: result lines are fragments of other files.
				bracketPairColorization: { enabled: false },
				guides: { bracketPairs: false, indentation: false },
				matchBrackets: 'never',
				lineNumbers: 'off',
				glyphMargin: false,
				folding: false,
				minimap: { enabled: false },
				renderLineHighlight: 'line',
				scrollBeyondLastLine: false,
				wordWrap: 'off',
				fontFamily: settings.get<string>('editor.fontFamily'),
				fontSize: settings.get<number>('editor.fontSize'),
				ariaLabel: t('searchEditor.resultsLabel')
			});
			decorations = ed.createDecorationsCollection(decorate(m, s.text));
			matchDecorations = ed.createDecorationsCollection(s.matchRanges.map((range) => ({ range, options: matchOptions(m) })));
			// Typing in the results: the state takes the text (dirty) and the moved match ranges.
			ed.onDidChangeModelContent(() => {
				const current = ed.getModel();
				if (!current || current.getValue() === s.text) return;
				const ranges = (matchDecorations?.getRanges() ?? []).filter((r) => !r.isEmpty()).map((r) => ({ startLineNumber: r.startLineNumber, startColumn: r.startColumn, endLineNumber: r.endLineNumber, endColumn: r.endColumn }));
				searchEditors.setText(s.key, current.getValue(), ranges);
			});
			ed.onDidChangeCursorPosition(() => reportStatus(ed));
			ed.onDidFocusEditorText(() => {
				editors.activateGroup(group);
				reportStatus(ed);
			});
			ed.onMouseUp((e) => {
				const pos = e.target.position;
				if (!pos) return;
				const lines = ed.getModel()?.getLinesContent() ?? [];
				const loc = locationAt(lines, pos.lineNumber, pos.column);
				if (!loc) return;
				if (e.event.detail === 1) {
					if (settings.get<string>('search.searchEditor.singleClickBehaviour') !== 'peekDefinition' || loc.kind !== 'line') return;
					// Kingu has no peek widget for files without a tab: the location shows to the side, focus stays here.
					editors.openToSide(loc.path, { line: loc.line, column: loc.column, focus: false });
					editors.activateGroup(group);
				} else if (e.event.detail === 2) {
					const behaviour = settings.get<string>('search.searchEditor.doubleClickBehaviour');
					if (behaviour === 'selectWord') return;
					const reveal = loc.kind === 'line' ? { line: loc.line, column: loc.column, focus: true } : undefined;
					if (behaviour === 'openLocationToSide') editors.openToSide(loc.path, reveal);
					else editors.open(loc.path, { preview: false, reveal });
				}
			});
			editor = ed;
		});
		return () => {
			gone = true;
			editor?.dispose();
			model?.dispose();
		};
	});

	// The results text and match ranges follow the state.
	$effect(() => {
		const text = s.text;
		void s.matchRanges;
		const ed = editor;
		if (!ed) return;
		untrack(() => {
			const model = ed.getModel();
			// A new search replaces the text (and the matches); the user's own edits are already in the model.
			const replaced = !!model && model.getValue() !== text;
			if (replaced) model.setValue(text);
			const ranges = s.matchRanges;
			void import('#lib/editor/monaco.ts').then((mod) => {
				decorations?.set(decorate(mod.monaco, text));
				if (replaced || !matchDecorations?.length) matchDecorations?.set(ranges.map((range) => ({ range, options: matchOptions(mod.monaco) })));
			});
		});
	});

	// The status bar items follow this editor when its tab becomes the active one.
	$effect(() => {
		const ed = editor;
		if (ed && editors.active === s.key) untrack(() => reportStatus(ed));
	});

	// A saved search with includes or excludes opens with its details shown (VS Code's showIncludesExcludes).
	$effect(() => {
		if (s.loaded && s.config.showIncludesExcludes) untrack(() => (showDetails = true));
	});

	$effect(() => {
		if (!s.focusInput || !input) return;
		input.focus();
		input.select();
	});
	$effect(() => {
		if (s.focusResults) editor?.focus();
	});

	/** The view's handle for the commands (Delete File Results, Select All Matches). */
	$effect(() => {
		const ed = editor;
		if (!ed) return;
		return registerView(editorKey, ed);
	});

	function onQueryKey(e: KeyboardEvent) {
		if (e.key === 'Enter') void searchEditors.run(editorKey);
		else if (e.key === 'ArrowDown') editor?.focus();
		else return;
		e.preventDefault();
	}

	function toggle(flag: 'isCaseSensitive' | 'matchWholeWord' | 'isRegexp' | 'useExcludeSettingsAndIgnoreFiles') {
		s.config[flag] = !s.config[flag];
		void searchEditors.run(editorKey);
	}

	const toggles = $derived([
		{ key: 'isCaseSensitive', label: 'Aa', title: `${t('searchEditor.matchCase')} (${keyLabel('alt+cmd+c')})` },
		{ key: 'matchWholeWord', label: 'ab', title: `${t('searchEditor.wholeWord')} (${keyLabel('alt+cmd+w')})` },
		{ key: 'isRegexp', label: '.*', title: `${t('searchEditor.regex')} (${keyLabel('alt+cmd+r')})` }
	] as const);

	const toggleClass = (on: boolean) => [
		'flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] border font-mono text-[12px] leading-none',
		on
			? 'border-[var(--vscode-inputOption-activeBorder,#2488DB)] bg-[var(--vscode-inputOption-activeBackground,#2489DB82)] text-[var(--vscode-inputOption-activeForeground,#FFFFFF)]'
			: 'border-transparent text-(--vscode-icon-foreground) hover:bg-[var(--vscode-inputOption-hoverBackground,#5A5D5E80)]'
	];
	const inputBox =
		'flex h-[26px] items-center rounded-[2px] border border-(--vscode-input-border) bg-(--vscode-input-background) text-(--vscode-input-foreground) focus-within:border-(--vscode-focusBorder)';
	const inputField = 'h-full min-w-0 flex-1 bg-transparent px-1.5 outline-none placeholder:text-(--vscode-input-placeholderForeground)';
</script>

<script lang="ts" module>
	import type * as MonacoTypes from 'monaco-editor';
	/** The mounted results editors by key, for the Search Editor commands. */
	const views = new Map<string, MonacoTypes.editor.IStandaloneCodeEditor>();
	function registerView(key: string, ed: MonacoTypes.editor.IStandaloneCodeEditor) {
		views.set(key, ed);
		return () => {
			if (views.get(key) === ed) views.delete(key);
		};
	}
	export const searchEditorView = (key: string) => views.get(key);
</script>

<section data-search-editor aria-label={t('searchEditor.query')} class="flex h-full flex-col bg-(--vscode-editor-background)">
	<div class="flex shrink-0 flex-col gap-1 border-b border-(--vscode-editorGroup-border) py-2 pr-4 pl-4">
		<div class="flex items-center gap-1">
			<div class={[inputBox, 'min-w-0 flex-1']}>
				<input
					bind:this={input}
					bind:value={s.config.query}
					onkeydown={onQueryKey}
					aria-label={t('searchEditor.query')}
					placeholder={t('searchEditor.query')}
					spellcheck="false"
					class={inputField}
				/>
				<div class="flex shrink-0 gap-0.5 pr-0.5">
					{#each toggles as tg (tg.key)}
						<button class={toggleClass(s.config[tg.key])} title={tg.title} aria-label={tg.title} aria-pressed={s.config[tg.key]} onclick={() => toggle(tg.key)}>
							<span class={tg.key === 'matchWholeWord' ? 'underline decoration-1 underline-offset-2' : undefined}>{tg.label}</span>
						</button>
					{/each}
					<button
						class={toggleClass(s.config.contextLines > 0)}
						title="{t('searchEditor.contextLines')} ({keyLabel('alt+cmd+l')})"
						aria-label={t('searchEditor.contextLines')}
						aria-pressed={s.config.contextLines > 0}
						onclick={() => searchEditors.toggleContextLines(editorKey)}><Icon name="rows" size={14} /></button
					>
				</div>
			</div>
			{#if s.config.contextLines > 0}
				<div class={[inputBox, 'w-14 shrink-0']}>
					<input
						type="number"
						min="0"
						value={s.config.contextLines}
						onchange={(e) => {
							s.config.contextLines = Math.max(0, Math.floor(Number(e.currentTarget.value)) || 0);
							void searchEditors.run(editorKey);
						}}
						onkeydown={(e) => {
							if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
							e.preventDefault();
							s.config.contextLines = modifyContextLines(s.config.contextLines, e.key === 'ArrowUp');
							void searchEditors.run(editorKey);
						}}
						aria-label={t('searchEditor.contextLinesInput')}
						title={t('searchEditor.contextLinesInput')}
						class={inputField}
					/>
				</div>
			{/if}
			<button
				class="grid size-[22px] shrink-0 place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground)"
				title="{t('searchEditor.searchAgain')} ({keyLabel('cmd+shift+r')})"
				aria-label={t('searchEditor.searchAgain')}
				onclick={() => searchEditors.run(editorKey)}><Icon name="refresh" size={15} /></button
			>
			<button
				class="h-[22px] shrink-0 rounded-[3px] px-1 text-[13px] leading-none tracking-widest text-(--vscode-icon-foreground) hover:bg-(--vscode-list-hoverBackground)"
				title={t('searchEditor.details')}
				aria-label={t('searchEditor.details')}
				aria-expanded={showDetails}
				onclick={() => (showDetails = !showDetails)}>…</button
			>
		</div>
		{#if showDetails}
			<label class="flex flex-col gap-0.5">
				<span class="text-[11px]">{t('searchEditor.include')}</span>
				<div class={inputBox}>
					<input bind:value={s.config.filesToInclude} onkeydown={(e) => e.key === 'Enter' && searchEditors.run(editorKey)} placeholder={t('searchEditor.includePlaceholder')} spellcheck="false" class={inputField} />
				</div>
			</label>
			<label class="flex flex-col gap-0.5">
				<span class="text-[11px]">{t('searchEditor.exclude')}</span>
				<div class={inputBox}>
					<input bind:value={s.config.filesToExclude} onkeydown={(e) => e.key === 'Enter' && searchEditors.run(editorKey)} placeholder={t('searchEditor.excludePlaceholder')} spellcheck="false" class={inputField} />
					<button
						class={[toggleClass(s.config.useExcludeSettingsAndIgnoreFiles), 'mr-0.5']}
						title={t('searchEditor.useIgnore')}
						aria-label={t('searchEditor.useIgnore')}
						aria-pressed={s.config.useExcludeSettingsAndIgnoreFiles}
						onclick={() => toggle('useExcludeSettingsAndIgnoreFiles')}><Icon name="file" size={14} /></button
					>
				</div>
			</label>
		{/if}
		{#if s.error}
			<p class="whitespace-pre-wrap text-(--vscode-errorForeground)">{s.error}</p>
		{:else if s.running}
			<p class="text-(--vscode-descriptionForeground)" aria-live="polite">{t('searchEditor.searching')}</p>
		{/if}
	</div>
	<div bind:this={host} data-search-editor-results class="min-h-0 flex-1"></div>
</section>

<style>
	:global(.kg-search-editor-file) {
		font-weight: 600;
		color: var(--vscode-foreground);
	}
	:global(.kg-search-editor-lineno) {
		color: var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground));
	}
	:global(.kg-search-editor-match) {
		background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
		border-radius: 2px;
	}
</style>
