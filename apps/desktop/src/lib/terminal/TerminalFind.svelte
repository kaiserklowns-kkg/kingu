<script lang="ts">
	// The find widget over a terminal (find.ts has the behaviour per layout).
	import { onMount, untrack } from 'svelte';
	import type { Terminal } from '@xterm/xterm';
	import type { SearchAddon } from '@xterm/addon-search';
	import Icon from '#lib/workbench/Icon.svelte';
	import { isMac } from '#lib/workbench/keys.ts';
	import { findDecorations, findKey, findStatus, type FindOptions } from './find.ts';
	import type { TerminalFlavor } from './terminalMenu.ts';

	let { term, search, flavor, seed = '', request, onclose }: { term: Terminal; search: SearchAddon; flavor: TerminalFlavor; seed?: string; request: number; onclose: () => void } = $props();

	let input: HTMLInputElement;
	let query = $state('');
	let opts = $state<FindOptions>({ caseSensitive: false, wholeWord: false, regex: false });
	let index = $state(-1);
	let count = $state(0);

	const status = $derived(findStatus(flavor, query, index, count));
	const noResults = $derived(query !== '' && count === 0);

	function run(dir: 'next' | 'previous', incremental = false) {
		if (!query) {
			search.clearDecorations();
			index = -1;
			count = 0;
			return;
		}
		const o = { ...opts, incremental, decorations: findDecorations(flavor) };
		if (dir === 'next') search.findNext(query, o);
		else search.findPrevious(query, o);
	}
	/** Typing searches from the current match: upward in the IDE (VS Code), downward in the ADE (Orca). */
	const typed = () => run(flavor === 'ide' ? 'previous' : 'next', true);

	function toggle(k: keyof FindOptions) {
		opts[k] = !opts[k];
		typed();
	}

	function onkeydown(e: KeyboardEvent) {
		const action = findKey(flavor, e, isMac);
		if (!action) return;
		e.preventDefault();
		e.stopPropagation();
		if (action === 'close') onclose();
		else if (action === 'next' || action === 'previous') run(action);
		else toggle(action);
	}

	// ⌘F again while open refocuses the input (Orca), seeded with a one-line selection (VS Code).
	$effect(() => {
		void request;
		untrack(() => {
			if (seed && !seed.includes('\n')) query = seed;
			input?.focus();
			input?.select();
			if (query) typed();
		});
	});

	onMount(() => {
		const sub = search.onDidChangeResults((r) => {
			index = r.resultIndex;
			count = r.resultCount;
		});
		return () => {
			sub.dispose();
			search.clearDecorations();
			term.focus();
		};
	});

	const TOGGLES: { key: keyof FindOptions; label: string; title: string }[] = [
		{ key: 'caseSensitive', label: 'Aa', title: isMac ? 'Match Case (⌥⌘C)' : 'Match Case (Alt+C)' },
		{ key: 'wholeWord', label: 'ab', title: isMac ? 'Match Whole Word (⌥⌘W)' : 'Match Whole Word (Alt+W)' },
		{ key: 'regex', label: '.*', title: isMac ? 'Use Regular Expression (⌥⌘R)' : 'Use Regular Expression (Alt+R)' }
	];
	const toggleClass = (on: boolean) => [
		'flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] border font-mono text-[12px] leading-none',
		on
			? 'border-[var(--vscode-inputOption-activeBorder,#2488DB)] bg-[var(--vscode-inputOption-activeBackground,#2489DB82)] text-[var(--vscode-inputOption-activeForeground,#FFFFFF)]'
			: 'border-transparent text-(--vscode-icon-foreground) hover:bg-[var(--vscode-inputOption-hoverBackground,#5A5D5E80)]'
	];
	const ICON = 'grid size-6 shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	class="absolute top-0 right-4 z-20 flex w-[340px] max-w-[calc(100%-2rem)] items-center gap-1 rounded-b-[4px] border border-t-0 border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) p-1 text-[13px] text-(--vscode-editorWidget-foreground) shadow-[0_2px_8px_var(--vscode-widget-shadow)]"
	role="search"
	aria-label="ค้นหาใน terminal"
	onmousedown={(e) => e.stopPropagation()}
>
	<div class="flex h-[26px] min-w-0 flex-1 items-center rounded-[2px] border border-(--vscode-input-border) bg-(--vscode-input-background) text-(--vscode-input-foreground) focus-within:border-(--vscode-focusBorder)">
		<input
			bind:this={input}
			bind:value={query}
			oninput={typed}
			{onkeydown}
			aria-label="ค้นหา"
			placeholder="ค้นหา"
			spellcheck="false"
			class="h-full min-w-0 flex-1 bg-transparent px-1.5 outline-none placeholder:text-(--vscode-input-placeholderForeground)"
		/>
		<div class="flex shrink-0 gap-0.5 pr-0.5">
			{#each TOGGLES as t (t.key)}
				<button class={toggleClass(opts[t.key])} title={t.title} aria-label={t.title} aria-pressed={opts[t.key]} onclick={() => toggle(t.key)}>
					<span class={t.key === 'wholeWord' ? 'underline decoration-1 underline-offset-2' : undefined}>{t.label}</span>
				</button>
			{/each}
		</div>
	</div>
	<span class={['min-w-14 shrink-0 px-1 text-xs whitespace-nowrap', noResults ? 'text-(--vscode-errorForeground)' : 'text-(--vscode-descriptionForeground)']} aria-live="polite">{status}</span>
	<button class={ICON} title={flavor === 'ide' ? 'Previous Match (Enter)' : 'Previous Match (⇧Enter)'} aria-label="Previous Match" disabled={!query} onclick={() => run('previous')}><Icon name="chevronUp" size={16} /></button>
	<button class={ICON} title={flavor === 'ide' ? 'Next Match (⇧Enter)' : 'Next Match (Enter)'} aria-label="Next Match" disabled={!query} onclick={() => run('next')}><Icon name="chevronDown" size={16} /></button>
	<button class={ICON} title="Close (Escape)" aria-label="Close" onclick={onclose}><Icon name="close" size={14} /></button>
</div>
