<script lang="ts">
	import { Channel, invoke } from '@tauri-apps/api/core';
	import { clientLog } from '#lib/client-log.ts';
	import { firstLine, slugify, toolArg, type AgentEvent, type WorktreeInfo } from '#lib/agent/events.ts';

	let title = $state('');
	let prompt = $state('');
	let slug = $state('');
	let runId = $state<number | undefined>();
	let events = $state<AgentEvent[]>([]);
	let error = $state('');
	let busy = $state(false);
	let worktrees = $state<WorktreeInfo[]>([]);
	let timeline: HTMLDivElement;

	const running = $derived(runId !== undefined);

	async function refresh() {
		try {
			worktrees = (await invoke<WorktreeInfo[]>('worktree_list')).filter((w) => w.slug);
		} catch (e) {
			error = String(e);
		}
	}

	$effect(() => {
		refresh();
	});

	// Keep the newest event in view.
	$effect(() => {
		if (events.length && timeline) timeline.scrollTop = timeline.scrollHeight;
	});

	async function start(e: SubmitEvent) {
		e.preventDefault();
		const task = title.trim();
		if (!task || running || busy) return;
		busy = true;
		error = '';
		events = [];
		slug = slugify(task);
		try {
			if (!worktrees.some((w) => w.slug === slug)) {
				await invoke<WorktreeInfo>('worktree_create', { slug });
				await refresh();
			}
			const onEvent = new Channel<AgentEvent>();
			onEvent.onmessage = (ev) => {
				events.push(ev);
				if (ev.kind === 'exit') runId = undefined;
			};
			runId = await invoke<number>('agent_start', { slug, prompt: prompt.trim() || task, onEvent });
			clientLog('info', `agent run ${runId} started for ${slug}`);
		} catch (err) {
			error = String(err);
		} finally {
			busy = false;
		}
	}

	async function stop() {
		if (runId === undefined) return;
		try {
			await invoke('agent_stop', { id: runId });
		} catch (err) {
			error = String(err);
		}
	}

	async function remove(s: string) {
		if (running && s === slug) return;
		try {
			await invoke('worktree_remove', { slug: s, force: false, deleteBranch: false });
		} catch (err) {
			error = String(err);
		}
		await refresh();
	}

	function cost(usd: number | null) {
		return usd == null ? '' : ` · $${usd.toFixed(4)}`;
	}
</script>

<div class="flex h-full flex-col">
	<form class="space-y-2 border-b border-neutral-800 p-3" onsubmit={start}>
		<input
			class="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 outline-none focus:border-sky-600"
			placeholder="ชื่องาน เช่น fix login bug"
			aria-label="ชื่องาน"
			bind:value={title}
			disabled={running}
		/>
		<textarea
			class="h-20 w-full resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1 outline-none focus:border-sky-600"
			placeholder="คำสั่งให้ agent (เว้นว่างเพื่อใช้ชื่องาน)"
			aria-label="คำสั่งให้ agent"
			bind:value={prompt}
			disabled={running}
		></textarea>
		<div class="flex items-center gap-2">
			{#if running}
				<button type="button" class="rounded bg-red-700 px-3 py-1 text-white hover:bg-red-600" onclick={stop}>
					หยุด
				</button>
				<span class="truncate text-xs text-neutral-400">กำลังทำงานใน kingu/{slug}…</span>
			{:else}
				<button
					type="submit"
					class="rounded bg-sky-700 px-3 py-1 text-white hover:bg-sky-600 disabled:opacity-50"
					disabled={!title.trim() || busy}>เริ่มงาน</button
				>
				{#if slug}<span class="truncate text-xs text-neutral-500">kingu/{slug}</span>{/if}
			{/if}
		</div>
		{#if error}<p class="text-xs break-words text-red-400">{error}</p>{/if}
	</form>

	<div bind:this={timeline} class="min-h-0 flex-1 space-y-1 overflow-y-auto p-3 text-xs" aria-live="polite">
		{#each events as ev, i (i)}
			{#if ev.kind === 'tool_use'}
				<div class="truncate font-mono text-neutral-200" title={JSON.stringify(ev.input)}>
					<span class="text-emerald-400">●</span>
					{ev.name}({toolArg(ev.input)})
				</div>
			{:else if ev.kind === 'tool_result'}
				<div class={['truncate pl-4 font-mono', ev.is_error ? 'text-red-400' : 'text-neutral-500']} title={ev.content}>
					⎿ {firstLine(ev.content) || '(ว่าง)'}
				</div>
			{:else if ev.kind === 'message'}
				<p class={['whitespace-pre-wrap', ev.role === 'assistant' ? 'text-neutral-100' : 'text-sky-300']}>{ev.text}</p>
			{:else if ev.kind === 'thinking'}
				<p class="whitespace-pre-wrap text-neutral-500 italic">{ev.text}</p>
			{:else if ev.kind === 'system'}
				<div class="text-neutral-500">
					{ev.subtype === 'init' ? 'เริ่ม session' : ev.subtype}{ev.model ? ` · ${ev.model}` : ''}
				</div>
			{:else if ev.kind === 'result'}
				<div class={['rounded border px-2 py-1', ev.is_error ? 'border-red-800 text-red-300' : 'border-emerald-800 text-emerald-300']}>
					{ev.is_error ? 'ล้มเหลว' : 'เสร็จ'} · {ev.num_turns ?? '?'} turns{cost(ev.total_cost_usd)}
					{#if ev.result}<p class="mt-1 whitespace-pre-wrap text-neutral-200">{ev.result}</p>{/if}
				</div>
			{:else if ev.kind === 'stderr'}
				<div class="font-mono break-all text-red-400/80">{ev.line}</div>
			{:else if ev.kind === 'raw'}
				<div class="truncate font-mono text-neutral-600" title={ev.line}>{ev.line}</div>
			{:else if ev.kind === 'exit'}
				<div class="text-neutral-400">
					{ev.stopped ? 'หยุดแล้ว' : `จบการทำงาน (exit ${ev.code ?? `signal ${ev.signal}`})`}
				</div>
			{/if}
		{:else}
			<p class="text-neutral-600">ยังไม่มีงาน — ตั้งชื่องานแล้วกด "เริ่มงาน" เพื่อสร้าง worktree และรัน Claude Code</p>
		{/each}
	</div>

	{#if worktrees.length}
		<div class="max-h-32 shrink-0 overflow-y-auto border-t border-neutral-800 p-2 text-xs">
			<div class="mb-1 text-neutral-500">Worktrees</div>
			{#each worktrees as w (w.path)}
				<div class="flex items-center gap-2">
					<span class="flex-1 truncate font-mono text-neutral-400" title={w.path}>{w.branch}</span>
					<button
						class="text-neutral-500 hover:text-red-400 disabled:opacity-30"
						disabled={running && w.slug === slug}
						onclick={() => w.slug && remove(w.slug)}>ลบ</button
					>
				</div>
			{/each}
		</div>
	{/if}
</div>
