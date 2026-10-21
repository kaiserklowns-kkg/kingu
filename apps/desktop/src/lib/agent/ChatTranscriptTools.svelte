<script lang="ts">
	// The Agent panel's transcript tools over its ChatList (placed in the same positioned box):
	// Find in Chat (ChatFind), Previous / Next User Prompt (scrolls to the request rows ChatList
	// marks with `data-chat-turn`) and the selection's Quote / Ask in Side Chat bar. They follow
	// `transcriptSignals` (chatTranscriptCommands.svelte.ts) while `active`.
	import { untrack } from 'svelte';
	import ChatFind from './ChatFind.svelte';
	import ChatSelectionQuote from './ChatSelectionQuote.svelte';
	import { promptStep } from './chatTranscript.ts';
	import { transcriptSignals } from './chatTranscriptCommands.svelte.ts';

	let {
		host,
		active = true,
		onquote,
		onside
	}: {
		/** The positioned box holding the ChatList. */
		host: () => HTMLElement | null;
		/** Follows the commands (the side bar's panel; not a chat in an editor tab). */
		active?: boolean;
		onquote: (text: string) => void;
		onside?: (text: string) => void;
	} = $props();

	const scroller = () => host()?.querySelector<HTMLElement>('[data-chat-scroll]') ?? null;
	let findOpen = $state(false);
	let findRequest = $state(0);
	let seed = $state('');

	$effect(() => {
		if (active) transcriptSignals.findOpen = findOpen;
	});
	$effect(() => () => {
		if (active) transcriptSignals.findOpen = false;
	});

	let seenFind = transcriptSignals.find;
	let seenHide = transcriptSignals.hideFind;
	let seenPrompt = transcriptSignals.prompt?.n;
	$effect(() => {
		const n = transcriptSignals.find;
		if (n === seenFind || !active) return;
		seenFind = n;
		untrack(() => {
			const sel = getSelection();
			const el = scroller();
			seed = sel && !sel.isCollapsed && el?.contains(sel.anchorNode) ? sel.toString().trim() : '';
			findOpen = true;
			findRequest++;
		});
	});
	$effect(() => {
		const n = transcriptSignals.hideFind;
		if (n === seenHide || !active) return;
		seenHide = n;
		untrack(() => closeFind());
	});
	$effect(() => {
		const p = transcriptSignals.prompt;
		if (!p || p.n === seenPrompt || !active) return;
		seenPrompt = p.n;
		untrack(() => goToPrompt(p.dir));
	});

	function closeFind() {
		if (!findOpen) return;
		findOpen = false;
		// Back to the chat input (VS Code returns focus to the widget's input).
		host()?.closest('[data-chat-view]')?.querySelector<HTMLElement>('textarea, [contenteditable="true"]')?.focus();
	}

	/** Previous / Next User Prompt: the request row before / after the top of the view. */
	function goToPrompt(dir: 1 | -1) {
		const el = scroller();
		if (!el) return;
		const box = el.getBoundingClientRect();
		const rows = [...el.querySelectorAll<HTMLElement>('[data-chat-turn]')];
		const targets = rows.map((r) => Math.max(0, Math.round(r.getBoundingClientRect().top - box.top + el.scrollTop - 8)));
		const i = promptStep(targets, el.scrollTop, dir);
		if (i === null) return;
		el.scrollTop = targets[i];
		rows[i].querySelector<HTMLElement>('[data-chat-request]')?.focus({ preventScroll: true });
	}
</script>

{#if findOpen}
	<ChatFind {scroller} {seed} request={findRequest} onclose={closeFind} />
{/if}
<ChatSelectionQuote {host} {scroller} {onquote} {onside} />
