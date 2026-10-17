<script lang="ts">
	// Agent panel (secondary side bar): quick task entry, the open folder's tasks, and the selected
	// task's run. Tasks are created through the ADE task store (worktree + tasks.json, then
	// `agents.start`), so a run started here shows up in the Agents view and board too. Runs live
	// in the `agents` store and outlive this panel; follow-ups resume the task's session.
	import AgentTimeline from './AgentTimeline.svelte';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import { runtime } from '#lib/ade/runtime.svelte.ts';
	import { STATUS_LABEL, type RunStatus } from './events';

	let title = $state('');
	let prompt = $state('');
	let followUp = $state('');
	let selected = $state<string | null>(null);
	let busy = $state(false);

	const run = $derived(selected ? runtime.run(selected) : undefined);
	const rt = $derived(selected ? runtime.get(selected) : undefined);
	const meta = $derived(selected ? adeTasks.list.find((t) => t.slug === selected) : undefined);

	// Default to the most recent run of this folder, else the newest task; drop a removed task.
	$effect(() => {
		if (selected !== null && !adeTasks.list.some((t) => t.slug === selected) && adeTasks.loaded) selected = null;
		if (selected === null) selected = runtime.all()[0]?.slug ?? adeTasks.list.at(-1)?.slug ?? null;
	});

	async function start(e: SubmitEvent) {
		e.preventDefault();
		const task = title.trim();
		if (!task || busy) return;
		busy = true;
		try {
			const created = await adeTasks.create({ title: task, prompt, base: '' });
			if (created) {
				selected = created;
				title = '';
				prompt = '';
			}
		} finally {
			busy = false;
		}
	}

	async function send(e?: Event) {
		e?.preventDefault();
		const text = followUp.trim();
		if (!text || !selected || run?.status === 'starting') return;
		followUp = '';
		await adeTasks.followUp(selected, text);
	}

	function composerKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) send(e);
	}

	const BADGE: Record<RunStatus, string> = {
		starting: 'bg-neutral-700 text-neutral-200',
		running: 'bg-sky-800 text-sky-100',
		waiting: 'bg-amber-600 text-black',
		idle: 'bg-emerald-800 text-emerald-100',
		stopped: 'bg-neutral-700 text-neutral-300',
		failed: 'bg-red-800 text-red-100',
		done: 'bg-neutral-700 text-neutral-300'
	};
</script>

{#snippet badge(status: RunStatus)}
	<span class={['shrink-0 rounded px-1.5 py-px text-[10px] leading-4', BADGE[status]]}>{STATUS_LABEL[status]}</span>
{/snippet}

<div class="flex h-full flex-col text-xs">
	<form class="space-y-2 border-b border-neutral-800 p-3" onsubmit={start}>
		<input
			class="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 outline-none focus:border-sky-600"
			placeholder="ชื่องานใหม่ เช่น fix login bug"
			aria-label="ชื่องาน"
			bind:value={title}
			disabled={busy}
		/>
		<textarea
			class="h-16 w-full resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1 outline-none focus:border-sky-600"
			placeholder="คำสั่งให้ agent (เว้นว่างเพื่อใช้ชื่องาน)"
			aria-label="คำสั่งให้ agent"
			bind:value={prompt}
			disabled={busy}
		></textarea>
		<button type="submit" class="rounded bg-sky-700 px-3 py-1 text-white hover:bg-sky-600 disabled:opacity-50" disabled={!title.trim() || busy}>{busy ? 'กำลังสร้าง…' : 'เริ่มงาน'}</button>
	</form>

	{#if adeTasks.list.length}
		<div class="max-h-32 shrink-0 overflow-y-auto border-b border-neutral-800 p-2">
			{#each adeTasks.views as v (v.meta.slug)}
				{@const r = runtime.run(v.meta.slug)}
				<div class={['flex items-center gap-2 rounded px-1', v.meta.slug === selected && 'bg-white/5']}>
					<button class="flex min-w-0 flex-1 items-center gap-2 text-left" onclick={() => (selected = v.meta.slug)}>
						<span class="flex-1 truncate text-neutral-300" title="kingu/{v.meta.slug}">{v.meta.title}</span>
						{#if r}
							{@render badge(r.status)}
							{#if r.pending.length}<span class="text-amber-400" title="คำขออนุญาตที่รออยู่">{r.pending.length}</span>{/if}
						{/if}
					</button>
					<button class="text-neutral-500 hover:text-red-400 disabled:opacity-30" disabled={!!r && !r.ended} onclick={() => adeTasks.remove(v.meta.slug)}>ลบ</button>
				</div>
			{/each}
		</div>
	{/if}

	{#if selected && meta}
		<div class="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-3 py-1.5">
			<button class="flex-1 truncate text-left font-mono text-neutral-400 hover:underline" title="เปิดหน้างาน" onclick={() => adeTasks.openTask(meta.slug)}
				>kingu/{meta.slug}{(run?.model ?? meta.model) ? ` · ${run?.model ?? meta.model}` : ''}</button
			>
			{#if run}{@render badge(run.status)}{/if}
			{#if rt?.working && run?.runId !== undefined}
				<button class="rounded bg-red-700 px-2 py-0.5 text-white hover:bg-red-600" title="หยุดรอบนี้ (Interrupt)" onclick={() => adeTasks.interrupt(meta.slug)}>หยุด</button>
			{/if}
			{#if rt?.live}
				<button class="text-neutral-400 hover:text-red-400" title="จบ session (Stop the run)" onclick={() => adeTasks.stop(meta.slug)}>จบงาน</button>
			{/if}
		</div>
	{/if}

	<AgentTimeline {run} onanswer={(p, decision, message) => selected && adeTasks.answer(selected, p.request_id, decision, message)} class="flex-1 p-3">
		{#snippet empty()}
			{#if meta}
				<p class="text-neutral-600">
					ยังไม่มีบันทึกของรอบนี้{meta.session_id ? ' — พิมพ์ด้านล่างเพื่อทำงานต่อใน session เดิม' : ''}
				</p>
			{:else}
				<p class="text-neutral-600">ยังไม่มีงาน — ตั้งชื่องานแล้วกด "เริ่มงาน" เพื่อสร้าง worktree และรัน Claude (ดูทุกงานได้ที่มุมมอง Agents)</p>
			{/if}
		{/snippet}
	</AgentTimeline>

	{#if selected && meta}
		<form class="flex shrink-0 gap-2 border-t border-neutral-800 p-2" onsubmit={send}>
			<textarea
				class="h-14 min-w-0 flex-1 resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1 outline-none focus:border-sky-600"
				placeholder={rt?.live
					? 'ส่งข้อความเพิ่มเติม (Enter ส่ง, Shift+Enter ขึ้นบรรทัดใหม่)'
					: (run?.sessionId ?? meta.session_id)
						? 'พิมพ์เพื่อทำงานต่อใน session เดิม…'
						: 'พิมพ์เพื่อเริ่มใหม่…'}
				aria-label="ข้อความถึง agent"
				bind:value={followUp}
				onkeydown={composerKey}
			></textarea>
			<button type="submit" class="self-end rounded bg-sky-700 px-3 py-1 text-white hover:bg-sky-600 disabled:opacity-50" disabled={!followUp.trim() || run?.status === 'starting'}>ส่ง</button>
		</form>
	{/if}
</div>
