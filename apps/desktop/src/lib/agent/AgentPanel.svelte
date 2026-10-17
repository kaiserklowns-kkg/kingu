<script lang="ts">
	// Quick task entry in the secondary side bar. Tasks are created and run through the ADE task
	// store (same worktrees, tasks.json and runtime as the Agents view), so a run started here
	// shows up there too; the timeline is the shared AgentTimeline.
	import AgentTimeline from './AgentTimeline.svelte';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import { runtime } from '#lib/ade/runtime.svelte.ts';

	let title = $state('');
	let prompt = $state('');
	let slug = $state('');
	let busy = $state(false);

	const running = $derived(slug !== '' && runtime.isRunning(slug));
	const events = $derived(slug ? runtime.events(slug) : []);

	async function start(e: SubmitEvent) {
		e.preventDefault();
		const task = title.trim();
		if (!task || running || busy) return;
		busy = true;
		try {
			const created = await adeTasks.create({ title: task, prompt, base: '' });
			if (created) {
				slug = created;
				title = '';
				prompt = '';
			}
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex h-full flex-col">
	<form class="space-y-2 border-b border-neutral-800 p-3" onsubmit={start}>
		<input
			class="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 outline-none focus:border-sky-600"
			placeholder="ชื่องาน เช่น fix login bug"
			aria-label="ชื่องาน"
			bind:value={title}
			disabled={busy}
		/>
		<textarea
			class="h-20 w-full resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1 outline-none focus:border-sky-600"
			placeholder="คำสั่งให้ agent (เว้นว่างเพื่อใช้ชื่องาน)"
			aria-label="คำสั่งให้ agent"
			bind:value={prompt}
			disabled={busy}
		></textarea>
		<div class="flex items-center gap-2">
			<button type="submit" class="rounded bg-sky-700 px-3 py-1 text-white hover:bg-sky-600 disabled:opacity-50" disabled={!title.trim() || busy}>เริ่มงาน</button>
			{#if running}
				<button type="button" class="rounded bg-red-700 px-3 py-1 text-white hover:bg-red-600" onclick={() => adeTasks.stop(slug)}>หยุด</button>
				<span class="truncate text-xs text-neutral-400">กำลังทำงานใน kingu/{slug}…</span>
			{:else if slug}
				<button type="button" class="truncate text-xs text-neutral-400 hover:underline" onclick={() => adeTasks.openTask(slug)}>เปิดหน้างาน kingu/{slug}</button>
			{/if}
		</div>
	</form>

	<AgentTimeline {events} class="flex-1 p-3">
		{#snippet empty()}
			<p class="text-neutral-600">ยังไม่มีงาน — ตั้งชื่องานแล้วกด "เริ่มงาน" เพื่อสร้าง worktree และรัน Claude Code (ดูทุกงานได้ที่มุมมอง Agents)</p>
		{/snippet}
	</AgentTimeline>
</div>
