<script lang="ts">
	// Create pull request (Orca's New PR composer): title, description, base and draft, seeded
	// once from the branch's commits and the task, then pushed and created with `gh` (Rust).
	// Errors stay in the form so nothing typed is lost.
	import AdeDialog from './AdeDialog.svelte';
	import { adeTasks } from './tasks.svelte.ts';
	import { prFormProblem, prSubmitLabel, type PrForm } from './prForm.ts';
	import { BUTTON, BUTTON_SECONDARY, INPUT } from './ui.ts';

	let { slug, onClose }: { slug: string; onClose: () => void } = $props();

	const branch = $derived(adeTasks.branchOf(slug));
	const stat = $derived(adeTasks.stats[slug]);
	let form = $state<PrForm | null>(null);
	let error = $state('');
	let busy = $state(false);

	$effect(() => {
		const s = slug;
		void adeTasks.prDefaults(s).then((f) => {
			if (s === slug && !form) form = f;
		});
	});

	const problem = $derived(form ? prFormProblem(form, branch) : 'กำลังเตรียม…');
	const bases = $derived(form && !adeTasks.branches.includes(form.base) ? [form.base, ...adeTasks.branches] : adeTasks.branches);

	async function submit(e?: Event) {
		e?.preventDefault();
		if (!form || problem || busy) return;
		busy = true;
		error = '';
		const err = await adeTasks.submitPr(slug, $state.snapshot(form));
		busy = false;
		if (err) error = err;
		else onClose();
	}

	// The form appears after the commits are read, so the dialog's first focus missed it.
	function focusTitle(node: HTMLInputElement) {
		node.focus();
		node.select();
	}

	function onBodyKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e);
	}
</script>

<AdeDialog title="สร้าง Pull Request" {busy} {onClose} width={560}>
	{#if !form}
		<p class="py-6 text-center text-(--vscode-descriptionForeground)">กำลังอ่าน commit ของ {branch}…</p>
	{:else}
		<form class="space-y-2.5" onsubmit={submit}>
			<p class="text-xs text-(--vscode-descriptionForeground)">push <span class="font-mono">{branch}</span> ไปที่ origin แล้วเปิด PR</p>
			<label class="block space-y-1">
				<span class="text-xs text-(--vscode-descriptionForeground)">ชื่อ (Title)</span>
				<input class={INPUT} bind:value={form.title} placeholder="Title" use:focusTitle disabled={busy} />
			</label>
			<label class="block space-y-1">
				<span class="text-xs text-(--vscode-descriptionForeground)">รายละเอียด (Description)</span>
				<textarea class={[INPUT, 'h-40 resize-y font-mono text-xs']} bind:value={form.body} placeholder="Description (optional)" disabled={busy} onkeydown={onBodyKey}></textarea>
			</label>
			<div class="flex flex-wrap items-center gap-3">
				<label class="flex items-center gap-1.5">
					<span class="text-xs text-(--vscode-descriptionForeground)">เข้า (base)</span>
					<select class={[INPUT, 'w-auto max-w-56']} bind:value={form.base} disabled={busy}>
						{#each bases as b (b)}<option value={b}>{b}</option>{/each}
					</select>
				</label>
				<label class="flex items-center gap-1.5">
					<input type="checkbox" bind:checked={form.draft} disabled={busy} />
					<span>สร้างเป็น draft</span>
				</label>
			</div>
			{#if stat?.dirty}
				<p class="rounded border border-(--vscode-editorWarning-foreground) px-2 py-1 text-xs text-(--vscode-editorWarning-foreground)">มีการแก้ไขที่ยังไม่ commit ซึ่งจะไม่อยู่ใน PR</p>
			{/if}
			{#if error}
				<p role="alert" class="rounded border border-(--vscode-errorForeground) px-2 py-1 text-xs whitespace-pre-wrap text-(--vscode-errorForeground)">{error}</p>
			{/if}
		</form>
	{/if}
	{#snippet footer()}
		{#if form && problem}<span class="mr-auto text-xs text-(--vscode-descriptionForeground)">{problem}</span>{/if}
		<button class={BUTTON_SECONDARY} disabled={busy} onclick={onClose}>ยกเลิก</button>
		<button class={BUTTON} disabled={!!problem || busy} title="{prSubmitLabel(form?.draft ?? false, false)} (⌘Enter)" onclick={() => submit()}>{prSubmitLabel(form?.draft ?? false, busy)}</button>
	{/snippet}
</AdeDialog>
