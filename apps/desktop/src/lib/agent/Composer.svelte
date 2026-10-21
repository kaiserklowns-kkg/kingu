<script lang="ts" module>
	import type { IconName } from '#lib/workbench/Icon.svelte';

	/**
	 * A context chip inline in the input (a file, the current file, problems, a diff…). Its icon
	 * turns into × on hover; `toggle` chips (the current file) are turned off instead, then shown
	 * dimmed with + to turn them back on.
	 */
	export type ComposerChip = { key: string; label: string; icon: IconName; title?: string; note?: string; off?: boolean; toggle?: boolean };
</script>

<script lang="ts">
	// The chat input, Cursor's agent composer: one rounded box with the context chips inline before
	// the text (Backspace at the start removes the last one), a row of image thumbnails above it,
	// and a bottom bar: the caller's controls on the left (`left`: the mode pill, the model name),
	// then `right` (the context ring), the paperclip and one round button that sends, queues (a
	// turn is running and there is text) or stops (a turn is running, no text); muted while empty.
	// `top`: the composer sits at the top of an empty chat: taller, its menus open below it.
	// Esc closes a menu, else `onescape` (focus goes back to the editor). Keys typed while focus
	// is on the bar's own buttons go to the text (composer.ts `chromeKey`), ⇧Tab still cycles.
	//   Enter sends, ⇧Enter adds a line; with `cmdEnter` ⌘Enter sends and Enter adds a line.
	//   While a turn runs Enter runs `queueDefault`, ⌥Enter the other of queue / steer, ⌘Enter
	//   stops and sends; right-click on the round button lists them.
	//   ⌥↑ / ⌥↓ browse this chat's earlier prompts (the draft comes back); ↑ / ↓ too from an empty
	//   input. ⇧Tab and ⌘. call `oncyclemode`. ⌘⇧⌫ (⌃C on macOS) calls `onstop`.
	//   `approval`: a tool call waits; with the input empty ⏎ runs it, ⇧⏎ allowlists it, Esc skips.
	//   `/` at the start lists `commands` in sections (Skills, folded to 3 with "Show N more", then
	//   Commands, Modes, Actions); `#` or `@` lists `mentions` (the current file, then the context
	//   sources; Files & Folders, Terminals and Past Chats open in place), `preview` beside it.
	// Images can be pasted, dropped (an overlay shows while dragging) or picked with the paperclip.
	// `onpastetext` may take a long pasted text instead (chat.pasteAsAttachmentThreshold). With
	// kingu.voice.enabled a microphone before the paperclip dictates into the text (chatVoice.svelte.ts).
	// `vscode`: VS Code's chat input look (the chat panel): an 8px box, no paperclip (the caller's
	// Add Context offers files from disk through `pickFiles`), a plain send / stop icon button.
	import type { Snippet } from 'svelte';
	import { dictation } from '#lib/voice/dictation.svelte.ts';
	import { chatDictationShown, toggleChatDictation } from './chatVoice.svelte.ts';
	import { invoke } from '@tauri-apps/api/core';
	import { open } from '@tauri-apps/plugin-dialog';
	import Icon from '#lib/workbench/Icon.svelte';
	import PopupMenu, { menuItem } from '#lib/workbench/PopupMenu.svelte';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { addAttachments, type Attachment } from './attachments.ts';
	import { clipboardImage, onFileDrop, savePastedImage } from './attachInput.ts';
	import { hashTrigger } from './chatInput.ts';
	import SlashSuggest, { type SuggestItem } from './SlashSuggest.svelte';
	import { mentionQuery, removeMention, type MentionScope } from './chatContext.ts';
	import { completeCommand, filterCommands, moveActive, slashQuery, type SlashItem } from './slashCommands.ts';
	import { sendHowFor, sendMenu, type QueueDefault, type SendHow } from './requestQueuing.ts';
	import {
		approvalKey,
		browseHistory,
		composerLayout,
		enterAction,
		modeCycleKey,
		NO_HISTORY,
		plainArrowBrowses,
		primaryAction,
		chromeKey,
		slashMenu,
		stopKey,
		type HistoryNav
	} from './composer.ts';

	type Layout = ReturnType<typeof composerLayout>;

	let {
		value = $bindable(''),
		placeholder,
		disabled = false,
		busy = false,
		size = 'sm',
		autofocus = false,
		attach = false,
		attachments = $bindable([]),
		onsubmit,
		left,
		right,
		chips = [],
		chipsExtra,
		onchip,
		history = [],
		running = false,
		onstop,
		onhash,
		sendLabel,
		commands = [],
		onpickcommand,
		queueDefault = 'queue',
		cmdEnter = false,
		mentions,
		onmention,
		onmentionopen,
		oncyclemode,
		onescape,
		preview,
		top = false,
		approval,
		stacked = false,
		tint,
		onpastetext,
		vscode = false
	}: {
		value?: string;
		placeholder: string;
		disabled?: boolean;
		busy?: boolean;
		size?: 'sm' | 'lg';
		autofocus?: boolean;
		attach?: boolean;
		attachments?: Attachment[];
		/** `how`: what to do while a turn runs (only given then). */
		onsubmit: (text: string, attachments: Attachment[], how?: SendHow) => void;
		/** The bottom bar's left controls (the mode pill, the model label), told what fits. */
		left?: Snippet<[Layout]>;
		/** More bottom-bar controls before Add Context and the paperclip (the context ring). */
		right?: Snippet<[Layout]>;
		/** Context chips inline before the text. */
		chips?: ComposerChip[];
		/** More inline chips after them (the chat's rules chip). */
		chipsExtra?: Snippet;
		onchip?: (chip: ComposerChip, action: 'remove' | 'toggle') => void;
		/** This chat's earlier prompts, oldest first. */
		history?: string[];
		/** A turn is running: the round button stops it while the input is empty. */
		running?: boolean;
		onstop?: () => void;
		/** `#` typed at the start of a word, when there is no `mentions` list: attach a file. */
		onhash?: () => void;
		sendLabel?: string;
		/** The `/` list. */
		commands?: SlashItem[];
		/** A `/` row picked: true when the caller ran it (a mode): the `/word` is taken out instead of completed. */
		onpickcommand?: (item: SlashItem) => boolean;
		/** What Enter does while a turn runs. */
		queueDefault?: QueueDefault;
		/** Submit with ⌘Enter (Enter adds a line). */
		cmdEnter?: boolean;
		/** The `#` / `@` list for what follows the trigger; `scope` is a list drilled into. */
		mentions?: (query: string, scope: MentionScope | null) => SuggestItem[];
		onmention?: (item: SuggestItem) => void;
		/** The `#` / `@` list just opened (a moment to refresh what it lists). */
		onmentionopen?: () => void;
		/** Esc with no menu open: focus leaves the composer. */
		onescape?: () => void;
		/** The highlighted `@` row's file preview. */
		preview?: (item: SuggestItem) => Promise<string | null>;
		/** At the top of an empty chat: taller, menus open below. */
		top?: boolean;
		/** ⇧Tab / ⌘.: the next mode. */
		oncyclemode?: () => void;
		/** A tool call waits: keys answer it while the input is empty. */
		approval?: { answer: (action: 'allow' | 'allowlist' | 'skip') => void };
		/** A toolbar sits right on top: square top corners. */
		stacked?: boolean;
		/** The mode's colour: the round button takes it (Cursor tints it per mode). */
		tint?: string;
		/** A pasted text: true when the caller took it (attached it) instead of the input. */
		onpastetext?: (text: string) => boolean;
		/** VS Code's chat input look (see the top). */
		vscode?: boolean;
	} = $props();

	const MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
	const KEYS = MAC ? { alt: '⌥⏎', cmd: '⌘⏎', stop: '⌘⇧⌫' } : { alt: 'Alt+Enter', cmd: 'Ctrl+Enter', stop: 'Ctrl+Shift+Backspace' };

	let area: HTMLTextAreaElement | undefined = $state();
	let box: HTMLDivElement | undefined = $state();
	let dragOver = $state(false);
	let width = $state(0);
	const layout = $derived(composerLayout(width));
	let nav: HistoryNav = NO_HISTORY;
	/** The caret, so the `/` list knows whether it is still in the command word. */
	let caret = $state(0);
	let slashActive = $state(0);
	/** Esc closed the list for this command word. */
	let slashClosed = $state<string | null>(null);
	const slashText = $derived(commands.length ? slashQuery(value, caret) : null);
	/** "Show N more" unfolded the Skills for this `/` word. */
	let slashExpanded = $state(false);
	const slashRows = $derived(slashText === null ? [] : slashMenu(filterCommands(commands, slashText), { query: slashText, expanded: slashExpanded }));
	const SECTION_LABEL = { skills: () => t('composer.slash.skills'), commands: () => t('composer.slash.commands'), modes: () => t('composer.slash.modes'), actions: () => t('composer.slash.actions') } as const;
	const slashItems = $derived<(SlashItem & SuggestItem)[]>(
		slashRows.map((r) =>
			r.kind === 'more'
				? { name: t('composer.slash.more', { count: r.count }), description: '', argumentHint: '', source: 'project-skill', key: 'more:skills', more: true }
				: { ...r.item, key: `${r.item.source}:${r.item.name}`, section: r.item.first ? SECTION_LABEL[r.item.section]() : undefined }
		)
	);
	const slashOpen = $derived(slashItems.length > 0 && slashClosed !== value.split(/\s/, 1)[0]);
	const listId = `slash-${Math.random().toString(36).slice(2, 8)}`;
	// `#` / `@` (only while the `/` list is closed).
	const mention = $derived(mentions && !slashOpen ? mentionQuery(value, caret) : null);
	let mentionActive = $state(0);
	/** A list drilled into (Files & Folders), for the mention starting at `start`. */
	let mentionScope = $state<{ start: number; scope: MentionScope; title: string } | null>(null);
	const scope = $derived(mention && mentionScope?.start === mention.start ? mentionScope : null);
	/** Esc closed the list for the mention starting here. */
	let mentionClosed = $state<number | null>(null);
	const mentionItems = $derived(mention && mentions ? mentions(mention.query, scope?.scope ?? null) : []);
	const mentionOpen = $derived(!!mention && (mentionItems.length > 0 || !!scope) && mentionClosed !== mention.start);
	const mentionStart = $derived(mention?.start ?? null);
	const images = $derived(attachments.filter((a) => a.image));
	const fileChips = $derived(attachments.filter((a) => !a.image));
	const hasText = $derived(!!value.trim());
	const action = $derived(primaryAction({ running, hasText, canStop: !!onstop }));
	let sendMenuAt = $state<{ x: number; y: number } | null>(null);

	$effect(() => {
		void mention?.query;
		void scope;
		mentionActive = 0;
	});
	$effect(() => {
		if (mentionStart === null) {
			mentionClosed = null;
			mentionScope = null;
		} else onmentionopen?.();
	});
	$effect(() => {
		void slashText;
		slashActive = 0;
	});
	$effect(() => {
		if (slashText === null) slashExpanded = false;
	});

	// The bottom bar keeps its labels while there is room (composerLayout).
	$effect(() => {
		if (!box || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver((entries) => (width = entries[0]?.contentRect.width ?? 0));
		ro.observe(box);
		return () => ro.disconnect();
	});

	function trackCaret() {
		if (area) caret = area.selectionStart;
	}

	function setText(text: string, at: number) {
		value = text;
		caret = at;
		queueMicrotask(() => area?.setSelectionRange(at, at));
	}

	function pickMention(item: SuggestItem | undefined) {
		if (!mention || !item) return;
		if (item.drill) {
			// The query typed so far stays; the list now shows only that source's rows.
			mentionScope = { start: mention.start, scope: item.drill as MentionScope, title: item.name };
			return;
		}
		const next = removeMention(value, mention.start, caret);
		setText(next.text, next.caret);
		mentionScope = null;
		onmention?.(item);
	}

	function pickCommand(item: (SlashItem & SuggestItem) | undefined) {
		if (!item) return;
		if (item.more) {
			slashExpanded = true;
			return;
		}
		if (onpickcommand?.(item)) {
			const end = value.search(/\s/);
			const rest = end < 0 ? '' : value.slice(end).replace(/^[ \t]+/, '');
			setText(rest, 0);
			return;
		}
		const next = completeCommand(value, item.name);
		setText(next.text, next.caret);
	}

	export function focus() {
		area?.focus();
	}

	$effect(() => {
		if (!attach || !box) return;
		return onFileDrop(box, { drop: (paths) => (attachments = addAttachments(attachments, paths)), hover: (v) => (dragOver = v) });
	});

	// Image thumbnails: each attached image read once as a data: URL (Rust checks it is an image).
	const previews = $state<Record<string, string>>({});
	const requested = new Set<string>();
	$effect(() => {
		for (const a of images) {
			if (requested.has(a.path)) continue;
			requested.add(a.path);
			invoke<string>('chat_attachment_preview', { path: a.path })
				.then((url) => (previews[a.path] = url))
				.catch(() => {});
		}
	});

	async function onpaste(e: ClipboardEvent) {
		const pasted = onpastetext ? (e.clipboardData?.getData('text/plain') ?? '') : '';
		if (pasted && onpastetext?.(pasted)) {
			e.preventDefault();
			return;
		}
		const image = attach ? clipboardImage(e) : null;
		if (!image) return;
		e.preventDefault();
		try {
			attachments = addAttachments(attachments, [await savePastedImage(image)]);
		} catch (err) {
			status.flash(t('chatView.pasteFailed', { error: String(err) }), 8000);
		}
		area?.focus();
	}

	/** Attach files from disk (the paperclip's dialog). */
	export function pickFiles() {
		void pick();
	}

	async function pick() {
		const picked = await open({ multiple: true, directory: false, title: t('chatView.attach') }).catch(() => null);
		if (picked) attachments = addAttachments(attachments, Array.isArray(picked) ? picked : [picked]);
		area?.focus();
	}
	const maxRows = $derived(size === 'lg' ? 12 : 10);

	// Grow with the content up to `maxRows`, then scroll.
	$effect(() => {
		void value;
		if (!area) return;
		// Not rendered (a hidden layout): keep the `rows` height instead of measuring 0.
		if (!area.getClientRects().length) {
			area.style.height = '';
			return;
		}
		area.style.height = 'auto';
		const line = parseFloat(getComputedStyle(area).lineHeight) || 22;
		area.style.height = `${Math.min(area.scrollHeight, line * maxRows + 4)}px`;
	});

	$effect(() => {
		if (autofocus) area?.focus();
	});

	function send(how?: SendHow) {
		const text = value.trim();
		if (!text || disabled || busy) return;
		nav = NO_HISTORY;
		onsubmit(text, $state.snapshot(attachments), running ? (how ?? queueDefault) : undefined);
	}

	function removeChip(c: ComposerChip) {
		onchip?.(c, c.toggle ? 'toggle' : 'remove');
	}

	/** Backspace at the very start: the last chip goes (an attached file, else a context chip). */
	function backspaceChip(): boolean {
		const lastFile = fileChips.at(-1);
		if (lastFile) {
			attachments = attachments.filter((a) => a.path !== lastFile.path);
			return true;
		}
		const last = [...chips].reverse().find((c) => !c.off);
		if (!last) return false;
		removeChip(last);
		return true;
	}

	function onkeydown(e: KeyboardEvent) {
		// Esc drops a dictation into this input (VS Code's Cancel Dictation).
		if (e.key === 'Escape' && micActive && dictation.state === 'listening') {
			e.preventDefault();
			e.stopPropagation();
			dictation.cancel();
			return;
		}
		if (mentionOpen && mention && !e.isComposing) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				mentionActive = moveActive(mentionActive, mentionItems.length, e.key === 'ArrowDown' ? 'down' : 'up');
				return;
			}
			if ((e.key === 'Enter' && !e.shiftKey && !e.altKey) || e.key === 'Tab') {
				e.preventDefault();
				pickMention(mentionItems[mentionActive] ?? mentionItems[0]);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				if (scope) mentionScope = null;
				else mentionClosed = mention.start;
				return;
			}
			if (e.key === 'Backspace' && scope && !mention.query) {
				e.preventDefault();
				mentionScope = null;
				return;
			}
		}
		if (slashOpen && !e.isComposing) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				slashActive = moveActive(slashActive, slashItems.length, e.key === 'ArrowDown' ? 'down' : 'up');
				return;
			}
			if ((e.key === 'Enter' && !e.shiftKey && !e.altKey) || e.key === 'Tab') {
				e.preventDefault();
				pickCommand(slashItems[slashActive] ?? slashItems[0]);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				slashClosed = value.split(/\s/, 1)[0];
				return;
			}
		}
		if (approval) {
			const a = approvalKey(e, !value.trim());
			if (a) {
				e.preventDefault();
				e.stopPropagation();
				approval.answer(a);
				return;
			}
		}
		if (oncyclemode && modeCycleKey(e, MAC)) {
			e.preventDefault();
			oncyclemode();
			return;
		}
		if (e.key === 'Escape' && !e.isComposing && onescape) {
			e.preventDefault();
			onescape();
			return;
		}
		if (running && onstop && area && stopKey(e, MAC, area.selectionStart !== area.selectionEnd)) {
			e.preventDefault();
			onstop();
			return;
		}
		const enter = enterAction(e, { cmdEnter, mac: MAC });
		if (enter) {
			e.preventDefault();
			if (enter === 'ignore') return;
			if (!running) return send();
			send(enter === 'submitStop' ? 'stop' : sendHowFor(queueDefault, enter === 'submitAlt'));
			return;
		}
		if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.isComposing && area) {
			const dir = e.key === 'ArrowUp' ? 'up' : 'down';
			const before = value.slice(0, area.selectionStart);
			const after = value.slice(area.selectionEnd);
			if (!e.altKey && !plainArrowBrowses(value, nav, history, dir, before, after)) return;
			const next = browseHistory(history, nav, dir, value);
			if (!next) return;
			e.preventDefault();
			nav = next.nav;
			value = next.text;
			queueMicrotask(() => area?.setSelectionRange(value.length, value.length));
			return;
		}
		if (e.key === 'Backspace' && area && area.selectionStart === 0 && area.selectionEnd === 0 && !e.isComposing && backspaceChip()) e.preventDefault();
	}

	function oninput() {
		trackCaret();
		if (mentions || !onhash || !area) return;
		const at = hashTrigger(value, area.selectionStart);
		if (at < 0) return;
		value = value.slice(0, at) + value.slice(at + 1);
		queueMicrotask(() => area?.setSelectionRange(at, at));
		onhash();
	}

	/**
	 * A key on the composer's own buttons (the mode pill, the model name, the paperclip): ⇧Tab
	 * still switches the mode and a typed character goes into the text, so `@` opens the context
	 * menu instead of acting on whichever button has focus.
	 */
	function onchromekey(e: KeyboardEvent) {
		if (!area || e.target === area || !(e.target instanceof HTMLElement) || e.target.closest('[role="listbox"],input')) return;
		const k = chromeKey(e);
		if (k === 'cycle' && oncyclemode) {
			e.preventDefault();
			oncyclemode();
			area.focus();
		} else if (k === 'type' && !disabled) {
			e.preventDefault();
			const at = area.selectionStart ?? value.length;
			const end = area.selectionEnd ?? at;
			area.focus();
			setText(value.slice(0, at) + e.key + value.slice(end), at + e.key.length);
		}
	}

	function onboxdown(e: MouseEvent) {
		// Clicks on the box's empty space go to the text (Cursor's `cursor: text`).
		if (e.target === e.currentTarget) {
			e.preventDefault();
			area?.focus();
		}
	}

	const SEND_LABEL: Record<SendHow, () => string> = { queue: () => t('chatInput.send.queue'), steer: () => t('chatInput.send.steer'), stop: () => t('chatInput.send.stop') };
	const sendItems = $derived(sendMenu(queueDefault).map((r) => menuItem(r.how, SEND_LABEL[r.how](), { keyLabel: r.how === 'stop' ? KEYS.cmd : r.key === 'enter' ? '⏎' : KEYS.alt })));
	const primaryTitle = $derived(
		action === 'stop'
			? `${t('chatView.stop')} (${KEYS.stop})`
			: action === 'queue'
				? t('composer.send.queueTitle', { action: SEND_LABEL[queueDefault](), alt: KEYS.alt, stop: KEYS.cmd })
				: `${sendLabel ?? t('chatView.send')} (${cmdEnter ? KEYS.cmd : '⏎'})`
	);

	function onprimary() {
		if (action === 'stop') onstop?.();
		else if (action === 'send' || action === 'queue') send();
	}

	function onprimarymenu(e: MouseEvent) {
		if (action !== 'queue') return;
		e.preventDefault();
		sendMenuAt = { x: e.clientX - 200, y: Math.max(4, e.clientY - sendItems.length * 26 - 14) };
	}

	// The microphone: lit while a dictation it (or a command, with the text focused) started runs.
	let micStarted = $state(false);
	let textFocused = $state(false);
	$effect(() => {
		if (dictation.state === 'idle') micStarted = false;
	});
	const micActive = $derived(dictation.state !== 'idle' && (micStarted || textFocused));
	function onmic() {
		if (dictation.state === 'idle') micStarted = true;
		toggleChatDictation(() => area?.focus());
	}

	const CHIP = 'group/chip inline-flex h-5 max-w-52 shrink-0 items-center gap-1 rounded-md bg-[color-mix(in_srgb,var(--vscode-foreground)_9%,transparent)] px-1 text-xs text-(--vscode-foreground)';
	const BAR_BTN = 'grid size-6 shrink-0 place-items-center rounded-md text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:opacity-50';
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={box}
	class={[
		'relative flex cursor-text flex-col gap-1.5 border bg-(--vscode-input-background) px-2.5 pt-2 pb-1.5 transition-[border-color,box-shadow] duration-100 focus-within:border-(--vscode-focusBorder)',
		vscode ? (stacked ? 'rounded-b-[8px]' : 'rounded-[8px]') : stacked ? 'rounded-b-xl' : 'rounded-xl',
		'border-(--vscode-input-border,var(--vscode-widget-border))',
		top && 'min-h-[120px]',
		size === 'lg' && 'shadow-[0_2px_12px_rgba(0,0,0,0.25)]'
	]}
	onmousedown={onboxdown}
	onkeydown={onchromekey}
>
	{#if slashOpen}
		<SlashSuggest items={slashItems} active={slashActive} id={listId} below={top} onpick={(item) => pickCommand(item as SlashItem & SuggestItem)} />
	{:else if mentionOpen}
		<SlashSuggest
			items={mentionItems}
			active={mentionActive}
			id={listId}
			onpick={(item) => pickMention(item)}
			kind="mention"
			below={top}
			{preview}
			label={t('chatContext.list')}
			back={scope ? { title: scope.title, go: () => (mentionScope = null) } : undefined}
		/>
	{/if}
	{#if images.length}
		<ul class="flex flex-wrap gap-1" aria-label={t('chatView.attachments')}>
			{#each images as a (a.path)}
				<li class="group/thumb relative size-8 shrink-0 overflow-hidden rounded-md border border-(--vscode-widget-border)" title={a.path}>
					{#if previews[a.path]}
						<img src={previews[a.path]} alt={a.name} class="size-full object-cover" />
					{:else}
						<span class="grid size-full place-items-center text-(--vscode-descriptionForeground)"><Icon name="image" size={14} /></span>
					{/if}
					<button
						type="button"
						class="absolute inset-0 grid place-items-center bg-black/55 text-white opacity-0 group-hover/thumb:opacity-100 focus-visible:opacity-100"
						aria-label={t('chatView.removeAttachment', { name: a.name })}
						title={t('chatView.removeAttachment', { name: a.name })}
						onclick={() => (attachments = attachments.filter((x) => x.path !== a.path))}><Icon name="close" size={12} /></button
					>
				</li>
			{/each}
		</ul>
	{/if}
	<div class="flex flex-wrap items-start gap-1" onmousedown={onboxdown}>
		{#each chips as c (c.key)}
			<span class={[CHIP, c.off && 'opacity-50']} title={c.title ?? c.label}>
				<button
					type="button"
					class="relative grid size-3.5 shrink-0 place-items-center"
					aria-label={c.toggle ? (c.off ? t('chatView.includeFile', { name: c.label }) : t('chatView.excludeFile', { name: c.label })) : t('chatView.removeAttachment', { name: c.label })}
					title={c.toggle ? (c.off ? t('chatView.includeFile', { name: c.label }) : t('chatView.excludeFile', { name: c.label })) : t('chatView.removeAttachment', { name: c.label })}
					{disabled}
					onclick={() => removeChip(c)}
				>
					<span class="grid place-items-center group-hover/chip:opacity-0 group-focus-within/chip:opacity-0"><Icon name={c.icon} size={12} /></span>
					<span class="absolute inset-0 grid place-items-center opacity-0 group-hover/chip:opacity-100 group-focus-within/chip:opacity-100"><Icon name={c.off ? 'plus' : 'close'} size={11} /></span>
				</button>
				<span class={['truncate', c.off && 'line-through']}>{c.label}</span>
				{#if c.note}<span class="shrink-0 text-(--vscode-descriptionForeground)">{c.note}</span>{/if}
			</span>
		{/each}
		{#each fileChips as a (a.path)}
			<span class={CHIP} title={a.path}>
				<button
					type="button"
					class="relative grid size-3.5 shrink-0 place-items-center"
					aria-label={t('chatView.removeAttachment', { name: a.name })}
					title={t('chatView.removeAttachment', { name: a.name })}
					onclick={() => (attachments = attachments.filter((x) => x.path !== a.path))}
				>
					<span class="grid place-items-center group-hover/chip:opacity-0 group-focus-within/chip:opacity-0"><Icon name="file" size={12} /></span>
					<span class="absolute inset-0 grid place-items-center opacity-0 group-hover/chip:opacity-100 group-focus-within/chip:opacity-100"><Icon name="close" size={11} /></span>
				</button>
				<span class="truncate">{a.name}</span>
			</span>
		{/each}
		{@render chipsExtra?.()}
		<textarea
			bind:this={area}
			bind:value
			{placeholder}
			{disabled}
			rows={size === 'lg' || top ? 3 : 1}
			aria-label={placeholder}
			{onkeydown}
			{onpaste}
			{oninput}
			onkeyup={trackCaret}
			onclick={trackCaret}
			onfocus={() => (textFocused = true)}
			onblur={() => (textFocused = false)}
			role={commands.length || mentions ? 'combobox' : undefined}
			aria-expanded={commands.length || mentions ? slashOpen || mentionOpen : undefined}
			aria-controls={slashOpen || mentionOpen ? listId : undefined}
			aria-autocomplete={commands.length || mentions ? 'list' : undefined}
			aria-activedescendant={slashOpen ? `${listId}-${slashActive}` : mentionOpen ? `${listId}-${mentionActive}` : undefined}
			style="outline: none; box-shadow: none"
			class={[
				'min-w-32 flex-1 basis-40 resize-none bg-transparent text-(--vscode-input-foreground) outline-none focus-visible:outline-none placeholder:text-(--vscode-input-placeholderForeground)',
				size === 'lg' ? 'text-[14px] leading-[22px]' : 'text-[13px] leading-5',
				(chips.length || fileChips.length) && 'min-h-5',
				top && 'min-h-[66px]'
			]}
		></textarea>
	</div>
	<div class={['mt-px flex min-h-6 items-center gap-1', top && 'mt-auto']} onmousedown={onboxdown}>
		<div class="flex min-w-0 flex-1 items-center gap-1 text-xs text-(--vscode-descriptionForeground)" onmousedown={onboxdown}>
			{@render left?.(layout)}
		</div>
		{@render right?.(layout)}
		{#if chatDictationShown()}
			<button
				type="button"
				aria-label={micActive && dictation.state === 'listening' ? t('chatRender.voice.stop') : t('chatRender.voice.start')}
				aria-pressed={micActive}
				title={micActive ? (dictation.state === 'transcribing' ? t('chatRender.voice.transcribing') : t('chatRender.voice.listening', { time: dictation.elapsed })) : t('chatRender.voice.start')}
				class={[BAR_BTN, micActive && 'text-(--vscode-errorForeground) hover:text-(--vscode-errorForeground)']}
				disabled={disabled || (dictation.state !== 'idle' && !micActive) || dictation.state === 'starting' || dictation.state === 'transcribing'}
				onmousedown={(e) => e.preventDefault()}
				onclick={onmic}
			>
				{#if micActive && dictation.state === 'transcribing'}<span class="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"></span>{:else}<span class={micActive ? 'animate-pulse' : undefined}><Icon name="mic" size={14} /></span>{/if}
			</button>
		{/if}
		{#if attach && !vscode}
			<button type="button" aria-label={t('chatView.attach')} title={t('chatView.attachHint')} class={BAR_BTN} {disabled} onclick={pick}><Icon name="attach" size={14} /></button>
		{/if}
		<button
			type="button"
			aria-label={action === 'stop' ? t('chatView.stop') : action === 'queue' ? SEND_LABEL[queueDefault]() : (sendLabel ?? t('chatView.send'))}
			title={primaryTitle}
			class={vscode
				? 'grid size-6 shrink-0 place-items-center rounded-md text-(--vscode-foreground) hover:bg-(--vscode-toolbar-hoverBackground) disabled:text-(--vscode-descriptionForeground) disabled:opacity-60 disabled:hover:bg-transparent'
				: 'ml-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--vscode-foreground)_85%,transparent)] text-(--vscode-sideBar-background,var(--vscode-input-background)) transition-opacity hover:opacity-90 disabled:opacity-30'}
			style:background={!vscode && action !== 'none' && tint ? tint : undefined}
			disabled={busy || disabled || action === 'none'}
			onclick={onprimary}
			oncontextmenu={onprimarymenu}
		>
			{#if busy}<span class="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"></span>{:else if action === 'stop'}<span class={vscode ? 'size-2.5 rounded-[2px] border-[1.5px] border-current' : 'size-2.5 rounded-[2px] bg-current'}></span>{:else}<Icon name="send" size={vscode ? 15 : 14} />{/if}
		</button>
	</div>
	{#if dragOver}
		<div class="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-[inherit] border border-dashed border-(--vscode-focusBorder) bg-[color-mix(in_srgb,var(--vscode-editor-background)_50%,transparent)] text-xs text-(--vscode-foreground)">
			<span class="flex items-center gap-1.5"><Icon name="attach" size={14} />{t('composer.drop')}</span>
		</div>
	{/if}
</div>
{#if sendMenuAt}
	<PopupMenu items={sendItems} label={t('chatInput.send.more')} x={sendMenuAt.x} y={sendMenuAt.y} onRun={(n) => n.type === 'item' && send(n.id as SendHow)} onClose={() => (sendMenuAt = null)} />
{/if}
