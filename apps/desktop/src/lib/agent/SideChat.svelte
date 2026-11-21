<script lang="ts">
	// A side chat (VS Code's Ask in Side Chat): a question about part of the chat, answered in a
	// drawer over the bottom of the list without adding to the chat. The first question forks the
	// chat (chats.fork with `side`, so the agent knows the whole conversation) and sends the excerpt
	// as a quote with it; the fork stays out of the history. Keep as Chat moves it there and opens
	// it; closing the drawer (or leaving the chat) discards it, stopped first if it runs.
	// Another harness (VS Code 1.145's nested sessions with a different harness): the side chat is a
	// new chat of that agent, with its own model and Manual permissions, told the quoted excerpt
	// instead of the whole conversation (another agent cannot resume this one's session).
	import { onDestroy, untrack } from 'svelte';
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import ChatList from './ChatList.svelte';
	import { chats } from './chats.svelte.ts';
	import { turnBusy } from './chatInput.ts';
	import { sideChatMessage } from './chatTranscript.ts';
	import { agentRuntimes } from './runtimes.svelte.ts';
	import { CLAUDE_RUNTIME, runtimeChoices } from './runtimes.ts';
	import { ARKAI_RUNTIME, arkaiDefault } from './arkai.ts';
	import { arkaiProviders } from './arkai.svelte.ts';

	let {
		parentId,
		excerpt,
		cwd = null,
		root = null,
		parentRuntime = CLAUDE_RUNTIME,
		canFork = true,
		onclose,
		onkeep
	}: {
		parentId: string;
		excerpt: string;
		cwd?: string | null;
		root?: string | null;
		/** The chat's own agent; `canFork`: it can fork the chat (rewind), so a same-agent side chat knows the whole conversation. */
		parentRuntime?: string;
		canFork?: boolean;
		onclose: () => void;
		/** Keep as Chat: the side chat is now a chat of the history; show it. */
		onkeep: (id: string) => void;
	} = $props();

	let sideId = $state<string | null>(null);
	let text = $state('');
	let busy = $state(false);
	const run = $derived(sideId ? chats.run(sideId) : undefined);
	const running = $derived(turnBusy(run));
	/** The side chat's agent, picked before its first question (VS Code's harness picker). */
	let harness = $state(untrack(() => parentRuntime));
	const harnesses = $derived(runtimeChoices(agentRuntimes.list, parentRuntime).filter((r) => !r.missing || r.id === parentRuntime));
	const harnessName = (id: string) => harnesses.find((r) => r.id === id)?.name ?? id;
	const forks = $derived(harness === parentRuntime && canFork);
	/** The model a new chat of `runtime` starts with (as a new chat in the panel would). */
	function modelFor(runtime: string): string | null {
		if (runtime === CLAUDE_RUNTIME) return chats.defaults().model;
		if (runtime === ARKAI_RUNTIME) return arkaiDefault(arkaiProviders.list, '') || null;
		return null;
	}

	async function send() {
		const question = text.trim();
		if (!question || busy) return;
		busy = true;
		try {
			if (!sideId && forks) {
				const id = await chats.fork(parentId, null, { side: true });
				if (!id) return;
				sideId = id;
				if (await chats.send(id, { text: sideChatMessage(excerpt, question), images: [] })) text = '';
				return;
			}
			if (!sideId) {
				const parent = chats.get(parentId);
				if (!parent) return;
				const message = sideChatMessage(excerpt, question);
				const id = await chats.create({ prompt: question, cwd: parent.cwd, model: modelFor(harness), permissionMode: 'default', message: { text: message, images: [] }, runtime: harness, sideOf: parentId });
				if (!id) return;
				sideId = id;
				text = '';
				return;
			}
			if ((await chats.submit(sideId, { text: question, images: [] }, question)) !== false) text = '';
		} finally {
			busy = false;
		}
	}

	/** Kept as a chat: not discarded when the drawer goes. */
	let kept = false;
	onDestroy(() => {
		if (sideId && !kept) void discard(sideId);
	});

	async function discard(id: string) {
		const live = chats.run(id);
		if (live && !live.ended) await chats.stopAndWait(id);
		await chats.remove(id);
	}

	function close() {
		onclose();
	}

	function keep() {
		if (!sideId) return;
		kept = true;
		chats.keepSideChat(sideId);
		onkeep(sideId);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void send();
		} else if (e.key === 'Escape' && !sideId) {
			e.preventDefault();
			close();
		}
	}

	const ICON_BTN = 'grid size-6 shrink-0 place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
</script>

<section
	class="absolute inset-x-0 bottom-0 z-20 flex h-[60%] min-h-40 flex-col border-t border-(--vscode-widget-border) bg-(--vscode-sideBar-background) shadow-[0_-2px_8px_var(--vscode-widget-shadow)]"
	aria-label={t('chatTranscript.side.header')}
	data-chat-find-skip
>
	<header class="flex h-[30px] shrink-0 items-center gap-1 px-2">
		<Codicon id="comment-discussion" size={13} />
		<span class="min-w-0 flex-1 truncate font-medium" title={harness !== parentRuntime ? t('chatTranscript.side.harnessHint', { name: harnessName(harness) }) : undefined}
			>{t('chatTranscript.side.header')}{#if harness !== parentRuntime}<span class="font-normal text-(--vscode-descriptionForeground)"> · {harnessName(harness)}</span>{/if}</span
		>
		{#if !sideId && harnesses.length > 1}
			<select
				class="h-[22px] max-w-40 rounded-sm border border-(--vscode-dropdown-border,transparent) bg-(--vscode-dropdown-background) px-1 text-xs text-(--vscode-dropdown-foreground) outline-none focus:border-(--vscode-focusBorder)"
				aria-label={t('chatTranscript.side.harness')}
				title={t('chatTranscript.side.harness')}
				bind:value={harness}
			>
				{#each harnesses as r (r.id)}<option value={r.id}>{r.id === parentRuntime && canFork ? t('chatTranscript.side.harnessFork', { name: r.name }) : r.name}</option>{/each}
			</select>
		{/if}
		{#if sideId}
			<button type="button" class="shrink-0 rounded px-1.5 py-0.5 text-xs text-(--vscode-textLink-foreground) hover:bg-(--vscode-toolbar-hoverBackground)" title={t('chatTranscript.side.keepHint')} onclick={keep}>{t('chatTranscript.side.keep')}</button>
		{/if}
		<button type="button" class={ICON_BTN} title={t('chatTranscript.side.discard')} aria-label={t('chatTranscript.side.discard')} onclick={() => close()}><Codicon id="close" size={14} /></button>
	</header>
	{#if excerpt.trim()}
		<blockquote class="mx-2 mb-1 line-clamp-3 shrink-0 border-l-2 border-(--vscode-textBlockQuote-border,var(--vscode-widget-border)) pl-2 text-xs whitespace-pre-wrap text-(--vscode-descriptionForeground)" title={t('chatTranscript.side.about')}>{excerpt.trim()}</blockquote>
	{/if}
	{#if sideId && run}
		<ChatList {run} chatId={sideId} {cwd} {root} actions={{ stop: () => sideId && void chats.interrupt(sideId) }} onanswer={(p, decision, message, answers) => sideId && chats.answer(sideId, p.request_id, decision, message, answers)} class="min-h-0 flex-1 px-2 py-1" />
	{:else}
		<p class="min-h-0 flex-1 px-2 py-1 text-xs text-(--vscode-descriptionForeground)">{t('chatTranscript.side.empty')}</p>
	{/if}
	<div class="flex shrink-0 items-end gap-1 p-2 pt-1">
		<textarea
			class="max-h-28 min-h-[30px] min-w-0 flex-1 resize-none rounded-md border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-2 py-1 text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
			rows="1"
			aria-label={t('chatTranscript.side.placeholder')}
			placeholder={t('chatTranscript.side.placeholder')}
			bind:value={text}
			disabled={busy}
			{onkeydown}
			{@attach (el) => (el as HTMLTextAreaElement).focus()}
		></textarea>
		<button type="button" class={ICON_BTN} title={t('chatTranscript.side.send')} aria-label={t('chatTranscript.side.send')} disabled={busy || !text.trim() || running} onclick={() => void send()}><Codicon id="arrow-up-compact" size={14} /></button>
	</div>
</section>
