<script lang="ts">
	// "Linear: Connect…" dialog: the personal API key is typed into a password field and handed to
	// Rust, which checks it with Linear and keeps it in the Keychain; it is never kept here.
	import { linear } from './linear.svelte.ts';

	let dialog: HTMLDialogElement | undefined = $state();
	let key = $state('');
	let error = $state('');
	let busy = $state(false);

	$effect(() => {
		if (!dialog) return;
		if (linear.connecting && !dialog.open) {
			key = '';
			error = '';
			dialog.showModal();
		} else if (!linear.connecting && dialog.open) dialog.close();
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		try {
			await linear.connect(key);
			linear.connecting = false;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			key = '';
			busy = false;
		}
	}
</script>

<dialog
	bind:this={dialog}
	aria-labelledby="kg-linear-connect-title"
	onclose={() => (linear.connecting = false)}
	class="m-auto w-[min(480px,90vw)] rounded-md border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) p-4 text-(--vscode-quickInput-foreground) shadow-[0_0_8px_2px_rgba(0,0,0,0.36)] backdrop:bg-black/40"
>
	<form onsubmit={submit} class="flex flex-col gap-3 text-[13px]">
		<h2 id="kg-linear-connect-title" class="text-sm font-semibold">เชื่อมต่อ Linear</h2>
		<p class="text-(--vscode-descriptionForeground)">
			วาง personal API key (ขึ้นต้นด้วย <code>lin_api_</code>) จาก Linear &gt; Settings &gt; Security &amp; access. Key จะถูกเก็บใน macOS Keychain เท่านั้น
		</p>
		<label class="flex flex-col gap-1">
			<span>API key</span>
			<input
				type="password"
				bind:value={key}
				autocomplete="off"
				spellcheck="false"
				required
				placeholder="lin_api_…"
				aria-invalid={error ? 'true' : undefined}
				aria-describedby={error ? 'kg-linear-connect-error' : undefined}
				class="h-[26px] rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 font-mono text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
			/>
		</label>
		{#if error}<p id="kg-linear-connect-error" role="alert" class="text-(--vscode-errorForeground)">{error}</p>{/if}
		<div class="flex justify-end gap-2">
			<button type="button" class="rounded-sm px-3 py-1 hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => (linear.connecting = false)}>ยกเลิก</button>
			<button type="submit" disabled={busy || !key.trim()} class="rounded-sm bg-(--vscode-button-background) px-3 py-1 text-(--vscode-button-foreground) disabled:opacity-50"
				>{busy ? 'กำลังตรวจสอบ…' : 'เชื่อมต่อ'}</button
			>
		</div>
	</form>
</dialog>
