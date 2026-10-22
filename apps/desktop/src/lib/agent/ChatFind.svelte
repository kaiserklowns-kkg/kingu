<script lang="ts">
	// Find in Chat (VS Code's chat find widget): a bar over the top right of the list. Typing
	// highlights every match in the rendered transcript (chatFindDom.ts), Enter / ⇧Enter (and
	// ⌘G / ⇧⌘G) step through them, Aa / ab / .* toggle Match Case, Whole Word and Regex
	// (⌥⌘C / ⌥⌘W / ⌥⌘R), Escape closes. New output is searched again as it streams in. Text
	// folded away ("Worked for", a closed thinking block) is not in the page and is not found.
	import { onMount, untrack } from 'svelte';
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { isMac } from '#lib/workbench/keys.ts';
	import { t } from '#lib/i18n/index.ts';
	import { findMatches, keepMatch, stepMatch, type FindOptions, type Match } from './chatTranscript.ts';
	import { clearPaint, indexText, paint, rangeAt, reveal, type TextIndex } from './chatFindDom.ts';
	import { transcriptSignals } from './chatTranscriptCommands.svelte.ts';

	let { scroller, seed = '', request, onclose }: { scroller: () => HTMLElement | null; seed?: string; request: number; onclose: () => void } = $props();

	let input: HTMLInputElement;
	let query = $state('');
	let opts = $state<FindOptions>({ caseSensitive: false, wholeWord: false, regex: false });
	let index = $state(-1);
	let count = $state(0);
	let invalid = $state(false);
	let found: { index: TextIndex; matches: Match[] } = { index: { text: '', nodes: [] }, matches: [] };

	const statusText = $derived(invalid ? t('chatTranscript.find.invalid') : !query ? '' : count ? t('chatTranscript.find.count', { index: index + 1, count }) : t('chatTranscript.find.noResults'));

	/** Searches the list again; `keep`: keep the current match by its offset (new output), else start at the first. */
	function search(keep: boolean, scroll = true) {
		const el = scroller();
		if (!el || !query) {
			found = { index: { text: '', nodes: [] }, matches: [] };
			index = -1;
			count = 0;
			invalid = false;
			clearPaint();
			return;
		}
		const prev = keep && index >= 0 ? (found.matches[index]?.start ?? null) : null;
		const idx = indexText(el);
		const r = findMatches(idx.text, query, opts);
		found = { index: idx, matches: r.matches };
		invalid = r.invalid;
		count = r.matches.length;
		index = keepMatch(r.matches, prev);
		show(scroll);
	}

	function show(scroll: boolean) {
		const ranges = found.matches.map((m) => rangeAt(found.index, m.start, m.end)).filter((r): r is Range => !!r);
		const m = found.matches[index];
		const current = m ? rangeAt(found.index, m.start, m.end) : null;
		paint(ranges, current);
		const el = scroller();
		if (scroll && current && el) reveal(el, current);
	}

	function step(dir: 1 | -1) {
		if (!query) return;
		// The list may have changed since the last search (a fold opened, new output).
		search(true, false);
		index = stepMatch(index, count, dir);
		show(true);
	}

	function toggle(k: keyof FindOptions) {
		opts[k] = !opts[k];
		search(false);
		input?.focus();
	}

	function onkeydown(e: KeyboardEvent) {
		const mod = isMac ? e.metaKey && e.altKey : e.altKey && !e.ctrlKey;
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		} else if (e.key === 'Enter' && !e.isComposing) {
			e.preventDefault();
			step(e.shiftKey ? -1 : 1);
		} else if (mod && (e.code === 'KeyC' || e.code === 'KeyW' || e.code === 'KeyR')) {
			e.preventDefault();
			toggle(e.code === 'KeyC' ? 'caseSensitive' : e.code === 'KeyW' ? 'wholeWord' : 'regex');
		} else return;
		e.stopPropagation();
	}

	// ⌘F again while open refocuses the input, seeded with a one-line selection (VS Code).
	$effect(() => {
		void request;
		untrack(() => {
			if (seed && !seed.includes('\n')) query = seed;
			input?.focus();
			input?.select();
			if (query) search(false);
		});
	});

	let seenStep = transcriptSignals.step?.n;
	let seenToggle = transcriptSignals.toggle?.n;
	$effect(() => {
		const s = transcriptSignals.step;
		if (!s || s.n === seenStep) return;
		seenStep = s.n;
		untrack(() => step(s.dir));
	});
	$effect(() => {
		const s = transcriptSignals.toggle;
		if (!s || s.n === seenToggle) return;
		seenToggle = s.n;
		untrack(() => toggle(s.key));
	});

	onMount(() => {
		// Streaming output and opened folds change the text: search again, keeping the current match.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const el = scroller();
		const observer = new MutationObserver(() => {
			clearTimeout(timer);
			timer = setTimeout(() => query && search(true, false), 200);
		});
		if (el) observer.observe(el, { childList: true, subtree: true, characterData: true });
		return () => {
			observer.disconnect();
			clearTimeout(timer);
			clearPaint();
		};
	});

	// VS Code's find toggles and buttons, by their product icons (kingu-old's chat find widget).
	const TOGGLES: { key: keyof FindOptions; icon: string; title: () => string; code: string }[] = [
		{ key: 'caseSensitive', icon: 'case-sensitive', title: () => t('chatTranscript.find.caseSensitive'), code: 'C' },
		{ key: 'wholeWord', icon: 'whole-word', title: () => t('chatTranscript.find.wholeWord'), code: 'W' },
		{ key: 'regex', icon: 'regex', title: () => t('chatTranscript.find.regex'), code: 'R' }
	];
	const keyHint = (code: string) => (isMac ? `⌥⌘${code}` : `Alt+${code}`);
	const toggleClass = (on: boolean) => [
		'flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] border font-mono text-[12px] leading-none',
		on
			? 'border-[var(--vscode-inputOption-activeBorder,#2488DB)] bg-[var(--vscode-inputOption-activeBackground,#2489DB82)] text-[var(--vscode-inputOption-activeForeground,#FFFFFF)]'
			: 'border-transparent text-(--vscode-icon-foreground) hover:bg-[var(--vscode-inputOption-hoverBackground,#5A5D5E80)]'
	];
	const ICON = 'grid size-6 shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
</script>

<div
	class="absolute top-0 right-3 z-30 flex w-[320px] max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-b-[4px] border border-t-0 border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) p-1 text-[13px] text-(--vscode-editorWidget-foreground) shadow-[0_2px_8px_var(--vscode-widget-shadow)]"
	role="search"
	aria-label={t('chatTranscript.find.label')}
	data-chat-find-skip
>
	<div class="flex h-[26px] min-w-0 flex-1 items-center rounded-[2px] border border-(--vscode-input-border) bg-(--vscode-input-background) text-(--vscode-input-foreground) focus-within:border-(--vscode-focusBorder)">
		<input
			bind:this={input}
			bind:value={query}
			oninput={() => search(false)}
			{onkeydown}
			aria-label={t('chatTranscript.find.label')}
			placeholder={t('chatTranscript.find.placeholder')}
			spellcheck="false"
			class="h-full min-w-0 flex-1 bg-transparent px-1.5 outline-none placeholder:text-(--vscode-input-placeholderForeground)"
		/>
		<div class="flex shrink-0 gap-0.5 pr-0.5">
			{#each TOGGLES as o (o.key)}
				<button type="button" class={toggleClass(opts[o.key])} title="{o.title()} ({keyHint(o.code)})" aria-label={o.title()} aria-pressed={opts[o.key]} onclick={() => toggle(o.key)}>
					<Codicon id={o.icon} />
				</button>
			{/each}
		</div>
	</div>
	<span class={['min-w-14 shrink-0 px-1 text-xs whitespace-nowrap', (invalid || (query && !count)) ? 'text-(--vscode-errorForeground)' : 'text-(--vscode-descriptionForeground)']} aria-live="polite">{statusText}</span>
	<button type="button" class={ICON} title={t('chatTranscript.find.previous')} aria-label={t('chatTranscript.find.previous')} disabled={!count} onclick={() => step(-1)}><Codicon id="find-previous-match" /></button>
	<button type="button" class={ICON} title={t('chatTranscript.find.next')} aria-label={t('chatTranscript.find.next')} disabled={!count} onclick={() => step(1)}><Codicon id="find-next-match" /></button>
	<button type="button" class={ICON} title={t('chatTranscript.find.close')} aria-label={t('chatTranscript.find.close')} onclick={onclose}><Codicon id="widget-close" /></button>
</div>

<style>
	/* The matches and the current one (VS Code's findMatchHighlight / findMatch colours). */
	:global(::highlight(kg-chat-find)) {
		background-color: var(--vscode-chat-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
	}
	:global(::highlight(kg-chat-find-current)) {
		background-color: var(--vscode-chat-findMatchBackground, #515c6a);
	}
</style>
