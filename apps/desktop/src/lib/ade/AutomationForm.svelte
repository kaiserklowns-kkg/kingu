<script lang="ts">
	// Automation editor: name, prompt, schedule (with a live preview of the next 3 runs), base
	// branch. Automations always launch the configured terminal agent; a new automation is saved
	// off and enabling it is a separate, confirmed step.
	import { onMount, untrack } from 'svelte';
	import { keyLabel } from '#lib/workbench/keys.ts';
	import { automations } from './automations.svelte.ts';
	import { formatWhen } from './automations.ts';
	import { nextRuns, parseSchedule } from './schedule.ts';
	import { adeTasks } from './tasks.svelte.ts';
	import { BUTTON, BUTTON_SECONDARY, INPUT } from './ui.ts';

	let { id }: { id: string | null } = $props();

	// The page remounts the form per automation (`{#key}`), so the initial values are enough.
	const existing = untrack(() => (id ? automations.find(id) : undefined));
	let name = $state(existing?.name ?? '');
	let prompt = $state(existing?.prompt ?? '');
	let schedule = $state(existing?.schedule ?? 'weekdays 09:00');
	let base = $state(existing?.base ?? '');
	let catchUp = $state(existing?.catch_up ?? true);
	let busy = $state(false);
	let input: HTMLInputElement | undefined = $state();
	const mac = keyLabel('cmd+a').startsWith('⌘');

	const parsed = $derived(parseSchedule(schedule));
	const preview = $derived(parsed.ok ? nextRuns(parsed.schedule, new Date(automations.now), 3) : []);
	const error = $derived(automations.validate({ name, prompt, schedule, base: base || null, mode: 'terminal', catch_up: catchUp }));

	onMount(() => {
		void adeTasks.refreshBranches();
		input?.focus();
	});

	async function submit(e?: Event) {
		e?.preventDefault();
		if (error || busy) return;
		busy = true;
		try {
			if (await automations.save(id, { name, prompt, schedule, base: base || null, mode: 'terminal', catch_up: catchUp })) automations.editing = null;
		} finally {
			busy = false;
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			automations.editing = null;
		} else if (e.key === 'Enter' && (mac ? e.metaKey : e.ctrlKey)) void submit(e);
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape / ⌘Enter from any field) -->
<form class="space-y-2 rounded border border-(--vscode-widget-border) p-3 text-xs" onsubmit={submit} onkeydown={onKey} aria-label={id ? 'แก้ไข automation' : 'automation ใหม่'}>
	<input bind:this={input} class={INPUT} placeholder="ชื่อ เช่น ตรวจ dependency ทุกเช้า" aria-label="ชื่อ automation" bind:value={name} disabled={busy} />
	<textarea class={[INPUT, 'h-24 resize-y']} placeholder="สั่ง agent ว่าให้ทำอะไรทุกรอบ" aria-label="คำสั่งให้ agent" bind:value={prompt} disabled={busy}></textarea>
	<label class="block space-y-1">
		<span class="text-(--vscode-descriptionForeground)">ตารางเวลา (เวลาท้องถิ่น)</span>
		<input class={[INPUT, 'font-mono']} placeholder="weekdays 09:00" aria-label="ตารางเวลา" aria-invalid={!parsed.ok} bind:value={schedule} disabled={busy} />
	</label>
	{#if parsed.ok}
		<p class="text-(--vscode-descriptionForeground)" aria-live="polite">รอบถัดไป: {preview.map((d) => formatWhen(d.getTime(), automations.now)).join(' · ') || '—'}</p>
	{:else}
		<p class="text-(--vscode-errorForeground)" aria-live="polite">{parsed.error}</p>
	{/if}
	<div class="flex flex-wrap items-center gap-3">
		<label class="flex items-center gap-1.5">
			<span class="shrink-0 text-(--vscode-descriptionForeground)">แตกจาก</span>
			<select class={[INPUT, 'w-auto py-0.5']} bind:value={base} aria-label="base branch" disabled={busy}>
				<option value="">branch ปัจจุบัน</option>
				{#each adeTasks.branches as b (b)}<option value={b}>{b}</option>{/each}
			</select>
		</label>
		<span class="text-(--vscode-descriptionForeground)">รันผ่าน terminal ของ worktree</span>
		<label class="flex items-center gap-1.5" title="ถ้าถึงเวลาตอนที่ Kingu ปิดอยู่ ให้รันหนึ่งรอบเมื่อเปิดขึ้นมา">
			<input type="checkbox" bind:checked={catchUp} disabled={busy} />
			<span>รันรอบที่พลาดเมื่อเปิด Kingu</span>
		</label>
	</div>
	<div class="flex items-center gap-1.5">
		<button type="submit" class={BUTTON} disabled={!!error || busy} title={error ?? `บันทึก (${mac ? '⌘' : 'Ctrl+'}Enter)`}>{busy ? 'กำลังบันทึก…' : 'บันทึก'}</button>
		<button type="button" class={BUTTON_SECONDARY} onclick={() => (automations.editing = null)}>ยกเลิก</button>
		{#if !id}<span class="text-(--vscode-descriptionForeground)">สร้างแล้วยังปิดอยู่ เปิดเองเมื่อพร้อม</span>{/if}
	</div>
</form>
