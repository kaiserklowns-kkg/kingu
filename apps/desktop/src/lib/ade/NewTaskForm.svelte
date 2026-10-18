<script lang="ts">
	// "งานใหม่": title, prompt and base branch. Creating makes the worktree `kingu/<slug>` from the
	// base and starts the agent in it. ⌘Enter submits, Escape closes.
	import { onMount } from 'svelte';
	import { keyLabel } from '#lib/workbench/keys.ts';
	import { uniqueSlug } from './model';
	import { adeTasks } from './tasks.svelte';
	import { BUTTON, BUTTON_SECONDARY, INPUT } from './ui';

	let title = $state('');
	let prompt = $state('');
	let base = $state('');
	let busy = $state(false);
	let input: HTMLInputElement | undefined = $state();

	const taken = $derived(new Set([...adeTasks.list.map((t) => t.slug), ...adeTasks.worktrees.map((w) => w.slug ?? '')]));
	const slug = $derived(title.trim() ? uniqueSlug(title, taken) : '');
	const mac = keyLabel('cmd+a').startsWith('⌘');

	onMount(() => {
		void adeTasks.refreshBranches().then(() => {
			if (!base) base = adeTasks.defaultBase();
		});
		input?.focus();
	});

	async function submit(e?: Event) {
		e?.preventDefault();
		if (!title.trim() || busy) return;
		busy = true;
		try {
			const created = await adeTasks.create({ title, prompt, base });
			if (created) adeTasks.composing = false;
		} finally {
			busy = false;
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			adeTasks.composing = false;
		} else if (e.key === 'Enter' && (mac ? e.metaKey : e.ctrlKey)) void submit(e);
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape / ⌘Enter from any field) -->
<form class="space-y-1.5 border-b border-(--vscode-sideBarSectionHeader-border) p-2 text-xs" onsubmit={submit} onkeydown={onKey}>
	<input bind:this={input} class={INPUT} placeholder="ชื่องาน เช่น แก้บั๊กหน้า login" aria-label="ชื่องาน" bind:value={title} disabled={busy} />
	<textarea class={[INPUT, 'h-20 resize-none']} placeholder="สั่ง agent ว่าให้ทำอะไร (เว้นว่างเพื่อใช้ชื่องาน)" aria-label="คำสั่งให้ agent" bind:value={prompt} disabled={busy}></textarea>
	<label class="flex items-center gap-2">
		<span class="shrink-0 text-(--vscode-descriptionForeground)">แตกจาก</span>
		<select class={[INPUT, 'py-0.5']} bind:value={base} aria-label="base branch" disabled={busy}>
			{#each adeTasks.branches as b (b)}<option value={b}>{b}</option>{/each}
			{#if !adeTasks.branches.length}<option value="">HEAD</option>{/if}
		</select>
	</label>
	{#if slug}<div class="truncate font-mono text-[11px] text-(--vscode-descriptionForeground)">→ kingu/{slug}</div>{/if}
	<div class="flex items-center gap-1.5">
		<button type="submit" class={BUTTON} disabled={!title.trim() || busy} title="สร้าง worktree แล้วเริ่ม agent ({mac ? '⌘' : 'Ctrl+'}Enter)">{busy ? 'กำลังสร้าง…' : 'สร้างและเริ่ม'}</button>
		<button type="button" class={BUTTON_SECONDARY} onclick={() => (adeTasks.composing = false)}>ยกเลิก</button>
	</div>
</form>
