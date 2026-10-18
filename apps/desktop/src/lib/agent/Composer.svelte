<script lang="ts">
	// Chat-style input like VS Code's chat input: a rounded box with an auto-growing text area and
	// a footer row (context chips + send). Enter sends, Shift+Enter adds a line (IME-safe).
	// `attach`: images and files can come along (Orca's composer attachments): paste an image,
	// drop files from Finder or pick them with the paperclip; they show as chips above the footer.
	// Chat extras (VS Code's chatInputPart), all optional: `context` chips (the active editor's file
	// as implicit context, `#`-picked files), ↑/↓ through `history` from an empty input, `#` calls
	// `onhash`, and while `running` a Stop button (Enter still sends: the panel queues it).
	import type { Snippet } from 'svelte';
	import { open } from '@tauri-apps/plugin-dialog';
	import Icon from '#lib/workbench/Icon.svelte';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { addAttachments, type Attachment } from './attachments.ts';
	import { clipboardImage, onFileDrop, savePastedImage } from './attachInput.ts';
	import { contextLabel, type ContextFile } from './chatPrompt.ts';
	import { hashTrigger, recallPrompt, type HistoryCursor } from './chatInput.ts';

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
		chips,
		contextExtra,
		context = [],
		oncontexttoggle,
		oncontextremove,
		history = [],
		running = false,
		onstop,
		onhash,
		sendLabel
	}: {
		value?: string;
		placeholder: string;
		disabled?: boolean;
		busy?: boolean;
		size?: 'sm' | 'lg';
		autofocus?: boolean;
		attach?: boolean;
		attachments?: Attachment[];
		onsubmit: (text: string, attachments: Attachment[]) => void;
		chips?: Snippet;
		/** More of the context row after the files (the chat's rules chip); the row shows when it renders anything. */
		contextExtra?: Snippet;
		/** Attached files; an implicit one (the active editor's) can be turned off and on. */
		context?: (ContextFile & { disabled?: boolean })[];
		oncontexttoggle?: (file: ContextFile) => void;
		oncontextremove?: (file: ContextFile) => void;
		/** This chat's earlier prompts, oldest first (↑/↓). */
		history?: string[];
		/** A turn is running: show Stop. */
		running?: boolean;
		onstop?: () => void;
		/** `#` typed at the start of a word: attach a file. */
		onhash?: () => void;
		sendLabel?: string;
	} = $props();

	let area: HTMLTextAreaElement | undefined = $state();
	let box: HTMLDivElement | undefined = $state();
	let dragOver = $state(false);
	let cursor: HistoryCursor = null;

	export function focus() {
		area?.focus();
	}

	$effect(() => {
		if (!attach || !box) return;
		return onFileDrop(box, { drop: (paths) => (attachments = addAttachments(attachments, paths)), hover: (v) => (dragOver = v) });
	});

	async function onpaste(e: ClipboardEvent) {
		const image = attach ? clipboardImage(e) : null;
		if (!image) return;
		e.preventDefault();
		try {
			attachments = addAttachments(attachments, [await savePastedImage(image)]);
		} catch (err) {
			status.flash(t('chatView.pasteFailed', { error: String(err) }), 8000);
		}
	}

	async function pick() {
		const picked = await open({ multiple: true, directory: false, title: t('chatView.attach') }).catch(() => null);
		if (picked) attachments = addAttachments(attachments, Array.isArray(picked) ? picked : [picked]);
	}
	const maxRows = $derived(size === 'lg' ? 12 : 8);

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
		const line = parseFloat(getComputedStyle(area).lineHeight) || 20;
		area.style.height = `${Math.min(area.scrollHeight, line * maxRows + 8)}px`;
	});

	$effect(() => {
		if (autofocus) area?.focus();
	});

	function send() {
		const text = value.trim();
		if (!text || disabled || busy) return;
		cursor = null;
		onsubmit(text, $state.snapshot(attachments));
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
			return;
		}
		if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !e.isComposing && area) {
			// Only from the first / last line, so the caret still moves inside a long prompt.
			const before = value.slice(0, area.selectionStart);
			const after = value.slice(area.selectionEnd);
			if (e.key === 'ArrowUp' ? before.includes('\n') : after.includes('\n')) return;
			const next = recallPrompt(history, cursor, e.key === 'ArrowUp' ? 'up' : 'down', value);
			if (!next) return;
			e.preventDefault();
			cursor = next.cursor;
			value = next.text;
			queueMicrotask(() => area?.setSelectionRange(value.length, value.length));
		}
	}

	function oninput() {
		if (!onhash || !area) return;
		const at = hashTrigger(value, area.selectionStart);
		if (at < 0) return;
		value = value.slice(0, at) + value.slice(at + 1);
		queueMicrotask(() => area?.setSelectionRange(at, at));
		onhash();
	}

	const CHIP_BTN = 'grid size-4 shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)';
</script>

<div
	bind:this={box}
	class={[
		'flex flex-col rounded-xl border bg-(--vscode-input-background) transition-colors focus-within:border-(--vscode-focusBorder)',
		dragOver ? 'border-(--vscode-focusBorder) border-dashed' : 'border-(--vscode-input-border,var(--vscode-widget-border))',
		size === 'lg' ? 'p-2.5 shadow-[0_2px_12px_rgba(0,0,0,0.25)]' : 'p-1.5'
	]}
>
	{#if context.length || contextExtra}
		<ul class="hidden flex-wrap gap-1 px-1 pb-1 has-[>li:not(:empty)]:flex" aria-label={t('chatView.context')}>
			{#each context as f (f.path + (f.implicit ? ':implicit' : ''))}
				{@const label = contextLabel(f)}
				<li
					class={[
						'flex max-w-64 items-center gap-1 rounded border px-1.5 py-0.5 text-xs text-(--vscode-foreground)',
						f.disabled ? 'border-dashed border-(--vscode-widget-border) opacity-60' : 'border-(--vscode-widget-border)'
					]}
					title={f.path}
				>
					<Icon name="file" size={12} />
					<span class={['truncate', f.disabled && 'line-through']}>{label}</span>
					{#if f.implicit}
						<span class="shrink-0 text-(--vscode-descriptionForeground)">{f.range ? t('chatView.currentSelection') : t('chatView.currentFile')}</span>
						<button
							type="button"
							class={CHIP_BTN}
							aria-label={f.disabled ? t('chatView.includeFile', { name: label }) : t('chatView.excludeFile', { name: label })}
							title={f.disabled ? t('chatView.includeFile', { name: label }) : t('chatView.excludeFile', { name: label })}
							onclick={() => oncontexttoggle?.(f)}><Icon name={f.disabled ? 'plus' : 'eyeOff'} size={10} /></button
						>
					{:else}
						<button type="button" class={CHIP_BTN} aria-label={t('chatView.removeAttachment', { name: label })} onclick={() => oncontextremove?.(f)}
							><Icon name="close" size={10} /></button
						>
					{/if}
				</li>
			{/each}
			{#if contextExtra}<li class="contents">{@render contextExtra()}</li>{/if}
		</ul>
	{/if}
	<textarea
		bind:this={area}
		bind:value
		{placeholder}
		{disabled}
		rows={size === 'lg' ? 3 : 2}
		aria-label={placeholder}
		{onkeydown}
		{onpaste}
		{oninput}
		style="outline: none; box-shadow: none"
		class={[
			'w-full resize-none bg-transparent px-1 text-(--vscode-input-foreground) outline-none focus-visible:outline-none placeholder:text-(--vscode-input-placeholderForeground)',
			size === 'lg' ? 'text-[14px] leading-6' : 'text-[13px] leading-5'
		]}
	></textarea>
	{#if attachments.length}
		<ul class="flex flex-wrap gap-1 px-1 pt-1" aria-label={t('chatView.attachments')}>
			{#each attachments as a (a.path)}
				<li class="flex max-w-56 items-center gap-1 rounded border border-(--vscode-widget-border) px-1.5 py-0.5 text-xs text-(--vscode-foreground)" title={a.path}>
					<Icon name={a.image ? 'image' : 'file'} size={12} />
					<span class="truncate">{a.name}</span>
					<button
						type="button"
						class={CHIP_BTN}
						aria-label={t('chatView.removeAttachment', { name: a.name })}
						onclick={() => (attachments = attachments.filter((x) => x.path !== a.path))}><Icon name="close" size={10} /></button
					>
				</li>
			{/each}
		</ul>
	{/if}
	<div class="flex min-h-6 items-center gap-1.5 pt-1">
		<div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs text-(--vscode-descriptionForeground)">
			{@render chips?.()}
		</div>
		{#if attach}
			<button
				type="button"
				aria-label={t('chatView.attach')}
				title={t('chatView.attachHint')}
				class="grid size-6 shrink-0 place-items-center rounded text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50"
				{disabled}
				onclick={pick}><Icon name="attach" size={14} /></button
			>
		{/if}
		{#if running && onstop}
			<button
				type="button"
				aria-label={t('chatView.stop')}
				title={t('chatView.stop')}
				class="grid size-7 shrink-0 place-items-center rounded-full text-(--vscode-foreground) hover:bg-(--vscode-toolbar-hoverBackground)"
				onclick={() => onstop?.()}><Icon name="stop" size={14} /></button
			>
		{/if}
		{#if !(running && onstop) || value.trim()}
			<button
				type="button"
				aria-label={sendLabel ?? t('chatView.send')}
				title={`${sendLabel ?? t('chatView.send')} · ${t('chatView.newLine')}`}
				class="grid size-7 shrink-0 place-items-center rounded-full bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:opacity-90 disabled:bg-transparent disabled:text-(--vscode-descriptionForeground) disabled:opacity-60"
				disabled={!value.trim() || disabled || busy}
				onclick={send}
			>
				{#if busy}<span class="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"></span>{:else}<Icon name="send" size={14} />{/if}
			</button>
		{/if}
	</div>
</div>
