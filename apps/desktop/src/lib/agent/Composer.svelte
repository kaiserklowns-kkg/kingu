<script lang="ts">
	// Chat-style input like VS Code's chat input: a rounded box with an auto-growing text area and
	// a footer row (context chips + send). Enter sends, Shift+Enter adds a line (IME-safe).
	// `attach`: images and files can come along (Orca's composer attachments): paste an image,
	// drop files from Finder or pick them with the paperclip; they show as chips above the footer.
	import type { Snippet } from 'svelte';
	import { open } from '@tauri-apps/plugin-dialog';
	import Icon from '#lib/workbench/Icon.svelte';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { addAttachments, type Attachment } from './attachments.ts';
	import { clipboardImage, onFileDrop, savePastedImage } from './attachInput.ts';

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
		chips
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
	} = $props();

	let area: HTMLTextAreaElement | undefined = $state();
	let box: HTMLDivElement | undefined = $state();
	let dragOver = $state(false);

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
			status.flash(`วางรูปไม่ได้: ${err}`, 8000);
		}
	}

	async function pick() {
		const picked = await open({ multiple: true, directory: false, title: 'แนบไฟล์หรือรูป' }).catch(() => null);
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
		onsubmit(text, $state.snapshot(attachments));
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
		}
	}
</script>

<div
	bind:this={box}
	class={[
		'flex flex-col rounded-xl border bg-(--vscode-input-background) transition-colors focus-within:border-(--vscode-focusBorder)',
		dragOver ? 'border-(--vscode-focusBorder) border-dashed' : 'border-(--vscode-input-border,var(--vscode-widget-border))',
		size === 'lg' ? 'p-2.5 shadow-[0_2px_12px_rgba(0,0,0,0.25)]' : 'p-1.5'
	]}
>
	<textarea
		bind:this={area}
		bind:value
		{placeholder}
		{disabled}
		rows={size === 'lg' ? 3 : 2}
		aria-label={placeholder}
		{onkeydown}
		{onpaste}
		style="outline: none; box-shadow: none"
		class={[
			'w-full resize-none bg-transparent px-1 text-(--vscode-input-foreground) outline-none focus-visible:outline-none placeholder:text-(--vscode-input-placeholderForeground)',
			size === 'lg' ? 'text-[14px] leading-6' : 'text-[13px] leading-5'
		]}
	></textarea>
	{#if attachments.length}
		<ul class="flex flex-wrap gap-1 px-1 pt-1" aria-label="ไฟล์แนบ">
			{#each attachments as a (a.path)}
				<li class="flex max-w-56 items-center gap-1 rounded border border-(--vscode-widget-border) px-1.5 py-0.5 text-xs text-(--vscode-foreground)" title={a.path}>
					<Icon name={a.image ? 'image' : 'file'} size={12} />
					<span class="truncate">{a.name}</span>
					<button
						type="button"
						class="grid size-4 shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)"
						aria-label="เอา {a.name} ออก"
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
				aria-label="แนบไฟล์หรือรูป"
				title="แนบไฟล์หรือรูป (วางรูปหรือลากไฟล์มาวางก็ได้)"
				class="grid size-6 shrink-0 place-items-center rounded text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50"
				{disabled}
				onclick={pick}><Icon name="attach" size={14} /></button
			>
		{/if}
		<button
			type="button"
			aria-label="ส่ง (Enter)"
			title="ส่ง (Enter) · ขึ้นบรรทัดใหม่ (Shift+Enter)"
			class="grid size-7 shrink-0 place-items-center rounded-full bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:opacity-90 disabled:bg-transparent disabled:text-(--vscode-descriptionForeground) disabled:opacity-60"
			disabled={!value.trim() || disabled || busy}
			onclick={send}
		>
			{#if busy}<span class="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"></span>{:else}<Icon name="send" size={14} />{/if}
		</button>
	</div>
</div>
