<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { agents } from '#lib/agent/agents.svelte.ts';
	import { firstLine, formatUsage, isLive, slugify, STATUS_LABEL, toolArg, type Decision, type PermissionRequest, type RunStatus, type WorktreeInfo } from '#lib/agent/events.ts';

	let title = $state('');
	let prompt = $state('');
	let followUp = $state('');
	let selected = $state<string | null>(null);
	let error = $state('');
	let busy = $state(false);
	let worktrees = $state<WorktreeInfo[]>([]);
	let denyReasons = $state<Record<string, string>>({});
	let timeline = $state<HTMLDivElement>();

	// Runs outlive this panel (the store owns them); show the ones of the open folder.
	const run = $derived(selected ? agents.get(selected) : undefined);
	const live = $derived(!!run && isLive(run));
	const working = $derived(run?.status === 'running' || run?.status === 'waiting' || run?.status === 'starting');

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

	// Default to the most recent run of this folder.
	$effect(() => {
		if (selected === null) selected = agents.list.find((r) => r.root === workspace.root)?.slug ?? null;
	});

	// Keep the newest event in view.
	$effect(() => {
		void run?.items.length;
		void run?.draft.text.length;
		if (timeline) timeline.scrollTop = timeline.scrollHeight;
	});

	async function guard(f: () => Promise<unknown>) {
		error = '';
		try {
			await f();
		} catch (e) {
			error = String(e instanceof Error ? e.message : e);
		}
	}

	async function start(e: SubmitEvent) {
		e.preventDefault();
		const task = title.trim();
		if (!task || busy) return;
		const slug = slugify(task);
		if (agents.get(slug) && !agents.get(slug)!.ended) {
			selected = slug;
			return;
		}
		busy = true;
		await guard(async () => {
			if (!worktrees.some((w) => w.slug === slug)) {
				await invoke<WorktreeInfo>('worktree_create', { slug });
				await refresh();
			}
			selected = slug;
			const text = prompt.trim() || task;
			title = '';
			prompt = '';
			await agents.start(slug, text);
		});
		busy = false;
	}

	async function send(e?: Event) {
		e?.preventDefault();
		const text = followUp.trim();
		if (!text || !selected || run?.status === 'starting') return;
		followUp = '';
		await guard(() => agents.send(selected!, text));
	}

	function composerKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) send(e);
	}

	function answer(p: PermissionRequest, decision: Decision) {
		if (!selected) return;
		const reason = decision === 'deny' ? denyReasons[p.request_id] : undefined;
		guard(() => agents.answer(selected!, p.request_id, decision, reason));
	}

	async function remove(slug: string) {
		const r = agents.get(slug);
		if (r && !r.ended) return;
		await guard(() => invoke('worktree_remove', { slug, force: false, deleteBranch: false }));
		agents.forget(slug);
		if (selected === slug) selected = null;
		await refresh();
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

	const DECISION_LABEL: Record<string, string> = {
		allow: 'อนุญาตแล้ว (allowed)',
		allow_always: 'อนุญาตเสมอในงานนี้ (always allowed)',
		deny: 'ไม่อนุญาต (denied)',
		cancelled: 'ยกเลิก (cancelled)'
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
		/>
		<textarea
			class="h-16 w-full resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1 outline-none focus:border-sky-600"
			placeholder="คำสั่งให้ agent (เว้นว่างเพื่อใช้ชื่องาน)"
			aria-label="คำสั่งให้ agent"
			bind:value={prompt}
		></textarea>
		<button type="submit" class="rounded bg-sky-700 px-3 py-1 text-white hover:bg-sky-600 disabled:opacity-50" disabled={!title.trim() || busy}>เริ่มงาน</button>
		{#if error}<p class="break-words text-red-400">{error}</p>{/if}
	</form>

	{#if worktrees.length}
		<div class="max-h-32 shrink-0 overflow-y-auto border-b border-neutral-800 p-2">
			{#each worktrees as w (w.path)}
				{@const r = w.slug ? agents.get(w.slug) : undefined}
				<div class={['flex items-center gap-2 rounded px-1', w.slug === selected && 'bg-white/5']}>
					<button class="flex min-w-0 flex-1 items-center gap-2 text-left" onclick={() => (selected = w.slug)}>
						<span class="flex-1 truncate font-mono text-neutral-300" title={w.path}>{w.branch}</span>
						{#if r}
							{@render badge(r.status)}
							{#if r.pending.length}<span class="text-amber-400" title="คำขออนุญาตที่รออยู่">{r.pending.length}</span>{/if}
						{/if}
					</button>
					<button class="text-neutral-500 hover:text-red-400 disabled:opacity-30" disabled={!!r && !r.ended} onclick={() => w.slug && remove(w.slug)}>ลบ</button>
				</div>
			{/each}
		</div>
	{/if}

	{#if run}
		<div class="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-3 py-1.5">
			<span class="flex-1 truncate font-mono text-neutral-400">kingu/{run.slug}{run.model ? ` · ${run.model}` : ''}</span>
			{@render badge(run.status)}
			{#if working && run.runId !== undefined}
				<button class="rounded bg-red-700 px-2 py-0.5 text-white hover:bg-red-600" title="หยุดรอบนี้ (Interrupt)" onclick={() => guard(() => agents.interrupt(run.slug))}>หยุด</button>
			{/if}
			{#if live}
				<button class="text-neutral-400 hover:text-red-400" title="จบ session (Stop the run)" onclick={() => guard(() => agents.stop(run.slug))}>จบงาน</button>
			{/if}
		</div>
	{/if}

	<div bind:this={timeline} class="min-h-0 flex-1 space-y-1 overflow-y-auto p-3" aria-live="polite">
		{#if run}
			{#each run.items as ev, i (i)}
				{#if ev.kind === 'tool_use'}
					<div class="truncate font-mono text-neutral-200" title={JSON.stringify(ev.input)}>
						<span class="text-emerald-400">●</span>
						{ev.name}({toolArg(ev.input)})
					</div>
				{:else if ev.kind === 'tool_result'}
					<div class={['truncate pl-4 font-mono', ev.is_error ? 'text-red-400' : 'text-neutral-500']} title={ev.content}>⎿ {firstLine(ev.content) || '(ว่าง)'}</div>
				{:else if ev.kind === 'message'}
					{#if ev.role === 'user'}
						<p class="rounded bg-sky-950/60 px-2 py-1 whitespace-pre-wrap text-sky-200">{ev.text}</p>
					{:else}
						<p class="whitespace-pre-wrap text-neutral-100">{ev.text}</p>
					{/if}
				{:else if ev.kind === 'thinking'}
					<p class="whitespace-pre-wrap text-neutral-500 italic">{ev.text}</p>
				{:else if ev.kind === 'system'}
					<div class="text-neutral-500">{ev.subtype === 'init' ? 'เริ่ม session' : ev.subtype}{ev.model ? ` · ${ev.model}` : ''}</div>
				{:else if ev.kind === 'permission_request'}
					{@const decided = run.decisions[ev.request_id]}
					{#if decided}
						<div class="truncate font-mono text-neutral-500" title={ev.input_summary}>
							<span class={decided === 'deny' || decided === 'cancelled' ? 'text-red-400' : 'text-emerald-400'}>◆</span>
							{ev.tool}: {DECISION_LABEL[decided]}
						</div>
					{:else}
						<div class="space-y-1.5 rounded border border-amber-600/70 bg-amber-950/30 p-2" role="group" aria-label="คำขออนุญาต {ev.tool}">
							<div class="font-medium text-amber-300">ขออนุญาตใช้ {ev.tool} <span class="font-normal text-amber-200/70">(Permission request)</span></div>
							{#if ev.title}<div class="text-neutral-300">{ev.title}</div>{/if}
							{#if ev.input_summary}
								<pre class="max-h-32 overflow-auto rounded bg-black/40 px-2 py-1 font-mono break-all whitespace-pre-wrap text-neutral-100">{ev.input_summary}</pre>
							{/if}
							{#if ev.diff}
								<div class="font-mono"><span class="text-emerald-400">+{ev.diff.added}</span> <span class="text-red-400">−{ev.diff.removed}</span> บรรทัด (lines)</div>
							{/if}
							{#if ev.detail}<div class="text-neutral-400">{ev.detail}</div>{/if}
							<input
								class="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 outline-none focus:border-sky-600"
								placeholder="เหตุผลที่ไม่อนุญาต (ไม่บังคับ) — reason if denying"
								aria-label="เหตุผลที่ไม่อนุญาต"
								bind:value={denyReasons[ev.request_id]}
							/>
							<div class="flex flex-wrap gap-1.5">
								<button class="rounded bg-emerald-700 px-2 py-0.5 text-white hover:bg-emerald-600" title="Allow once" onclick={() => answer(ev, 'allow')}>อนุญาต</button>
								{#if ev.can_always}
									<button class="rounded bg-emerald-900 px-2 py-0.5 text-emerald-100 hover:bg-emerald-800" title="Always allow for this task's session" onclick={() => answer(ev, 'allow_always')}>อนุญาตเสมอในงานนี้</button>
								{/if}
								<button class="rounded bg-red-800 px-2 py-0.5 text-white hover:bg-red-700" title="Deny" onclick={() => answer(ev, 'deny')}>ไม่อนุญาต</button>
							</div>
						</div>
					{/if}
				{:else if ev.kind === 'result'}
					<div class={['rounded border px-2 py-1', ev.is_error ? 'border-red-800 text-red-300' : 'border-emerald-800 text-emerald-300']}>
						{ev.is_error ? 'ล้มเหลว' : 'เสร็จรอบนี้'}{formatUsage(ev) ? ` · ${formatUsage(ev)}` : ''}
						{#if ev.result}<p class="mt-1 whitespace-pre-wrap text-neutral-200">{ev.result}</p>{/if}
					</div>
				{:else if ev.kind === 'error'}
					<div class="break-words text-red-400">ข้อผิดพลาด: {ev.message}</div>
				{:else if ev.kind === 'stderr'}
					<div class="font-mono break-all text-red-400/80">{ev.line}</div>
				{:else if ev.kind === 'raw'}
					<div class="truncate font-mono text-neutral-600" title={ev.line}>{ev.line}</div>
				{:else if ev.kind === 'exit'}
					<div class="text-neutral-400">{ev.stopped ? 'จบงานแล้ว' : `จบการทำงาน${ev.code ? ` (exit ${ev.code})` : ''}`}</div>
				{/if}
			{/each}
			{#if run.draft.thinking}<p class="whitespace-pre-wrap text-neutral-500 italic">{run.draft.thinking}</p>{/if}
			{#if run.draft.text}<p class="whitespace-pre-wrap text-neutral-100">{run.draft.text}<span class="animate-pulse">▍</span></p>{/if}
			{#if run.ended && run.result}
				<div class="pt-1 text-neutral-500">รวมทั้ง session: {formatUsage(run.result)}</div>
			{/if}
		{:else}
			<p class="text-neutral-600">ยังไม่มีงาน — ตั้งชื่องานแล้วกด "เริ่มงาน" เพื่อสร้าง worktree และรัน Claude</p>
		{/if}
	</div>

	{#if run}
		<form class="flex shrink-0 gap-2 border-t border-neutral-800 p-2" onsubmit={send}>
			<textarea
				class="h-14 min-w-0 flex-1 resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1 outline-none focus:border-sky-600"
				placeholder={run.ended ? (run.sessionId ? 'พิมพ์เพื่อทำงานต่อใน session เดิม…' : 'พิมพ์เพื่อเริ่มใหม่…') : 'ส่งข้อความเพิ่มเติม (Enter ส่ง, Shift+Enter ขึ้นบรรทัดใหม่)'}
				aria-label="ข้อความถึง agent"
				bind:value={followUp}
				onkeydown={composerKey}
			></textarea>
			<button type="submit" class="self-end rounded bg-sky-700 px-3 py-1 text-white hover:bg-sky-600 disabled:opacity-50" disabled={!followUp.trim() || run.status === 'starting'}>ส่ง</button>
		</form>
	{/if}
</div>
