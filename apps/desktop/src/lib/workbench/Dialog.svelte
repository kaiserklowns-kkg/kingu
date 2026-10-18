<script lang="ts">
	// The in-window dialog: title, message, then Cancel / OK. Enter confirms, Escape cancels, and
	// Tab stays inside. A warning that confirms a destructive action shows its OK button in red.
	import Icon from './Icon.svelte';
	import { dialogs } from './dialogService.svelte';

	const d = $derived(dialogs.current!);
	const destructive = $derived(d.kind === 'warning' || d.kind === 'error');
	let box: HTMLDivElement | undefined = $state();

	$effect(() => {
		void d;
		(box?.querySelector<HTMLElement>('input[type=text], input:not([type])') ?? box?.querySelector<HTMLElement>('[data-default]'))?.focus();
	});

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') dialogs.settle(false);
		else if (e.key === 'Enter' && !e.isComposing && !(e.target instanceof HTMLButtonElement)) dialogs.settle(true);
		else if (e.key === 'Tab' && box) {
			const items = [...box.querySelectorAll<HTMLElement>('button, input')];
			const i = items.indexOf(document.activeElement as HTMLElement);
			items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
		} else return;
		e.preventDefault();
		e.stopPropagation();
	}

	const ICON = { info: 'info', warning: 'warning', error: 'error' } as const;
	const TONE = { info: 'text-(--vscode-editorInfo-foreground)', warning: 'text-(--vscode-editorWarning-foreground)', error: 'text-(--vscode-errorForeground)' };
</script>

<svelte:window onkeydowncapture={onkeydown} />

<div class="fixed inset-0 z-[70] grid place-items-center bg-black/40 p-6" role="presentation">
	<div
		bind:this={box}
		role="alertdialog"
		aria-modal="true"
		aria-labelledby="kg-dialog-title"
		aria-describedby="kg-dialog-message"
		class="kg-dialog w-full max-w-[440px] overflow-hidden rounded-xl border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) text-(--vscode-foreground) shadow-2xl shadow-black/50"
	>
		<div class="flex gap-3 px-5 pt-5 pb-4">
			<span class={['mt-0.5 shrink-0', TONE[d.kind ?? 'info']]}><Icon name={ICON[d.kind ?? 'info']} size={22} /></span>
			<div class="min-w-0 flex-1">
				<h2 id="kg-dialog-title" class="text-[14px] font-semibold">{d.title ?? 'Kingu'}</h2>
				<p id="kg-dialog-message" class="kg-selectable mt-1.5 text-[13px] leading-relaxed whitespace-pre-line text-(--vscode-descriptionForeground)">{d.message}</p>
				{#if d.input}
					<!-- svelte-ignore a11y_autofocus -->
					<input
						bind:value={d.input.value}
						placeholder={d.input.placeholder}
						autofocus
						onfocus={(e) => e.currentTarget.select()}
						class="mt-3 h-8 w-full rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2.5 text-[13px] text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
					/>
				{/if}
				{#if d.checkbox}
					<label class="mt-3 flex items-center gap-2 text-[13px]">
						<input type="checkbox" bind:checked={d.checkbox.checked} class="size-4 accent-(--vscode-focusBorder)" />
						{d.checkbox.label}
					</label>
				{/if}
			</div>
		</div>
		<div class="flex justify-end gap-2 border-t border-(--vscode-widget-border) px-4 py-3">
			{#if d.cancellable}
				<button class="h-8 rounded-md px-3.5 text-[13px] hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => dialogs.settle(false)}>{d.cancelLabel ?? 'ยกเลิก'}</button>
			{/if}
			<button
				data-default
				class={[
					'h-8 rounded-md px-3.5 text-[13px] font-medium hover:opacity-90',
					d.cancellable && destructive ? 'bg-[#C42B1C] text-white' : 'bg-(--vscode-button-background) text-(--vscode-button-foreground)'
				]}
				onclick={() => dialogs.settle(true)}>{d.okLabel ?? 'ตกลง'}</button
			>
		</div>
	</div>
</div>

<style>
	.kg-dialog {
		animation: kg-dialog-in 140ms ease-out;
	}
	@keyframes kg-dialog-in {
		from {
			opacity: 0;
			transform: scale(0.97);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.kg-dialog {
			animation: none;
		}
	}
</style>
