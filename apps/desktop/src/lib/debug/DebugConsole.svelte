<script lang="ts">
	// Debug Console (VS Code: repl.ts): the session's output and an expression input evaluated in
	// the selected stack frame. ↑/↓ walk the input history; earlier inputs that start with what is
	// typed are suggested (debug.console.historySuggestions: Tab accepts, and Enter too with
	// debug.console.acceptSuggestionOnEnter on). Font, line height, wrapping and collapsing of
	// identical lines follow the debug.console.* settings. While debugging, the adapter's completions
	// (DAP `completions`) come first, as you type and on ⌃Space (VS Code's REPL suggest widget).
	import Icon from '#lib/workbench/Icon.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { debug } from './debug.svelte.ts';
	import { collapseLines, consoleFont, historyMatches } from './debugSettings.ts';
	import type { CompletionItem } from './protocol.ts';
	import { applyCompletion, rankCompletions, wordBefore } from './replCompletion.ts';

	let input = $state('');
	let history = $state<string[]>([]);
	let historyAt = -1;
	let scroller: HTMLDivElement | undefined = $state();
	let suggestionAt = $state(0);
	let browsing = $state(false);

	const output = $derived(collapseLines(debug.model?.output ?? [], settings.get<boolean>('debug.console.collapseIdenticalLines')));
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

<div class="flex h-full flex-col">
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
							title="{line.count} ครั้ง">{line.count}</span
						>{/if}{line.text}</span
				>{/each}
		{:else}
			<span class="text-(--vscode-descriptionForeground)">{debug.active ? '' : 'เริ่ม debug (F5) แล้ว output ของโปรแกรมจะแสดงที่นี่'}</span>
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
			placeholder={debug.stopped ? 'ประเมินนิพจน์ใน frame ที่เลือก' : 'Debug Console'}
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
