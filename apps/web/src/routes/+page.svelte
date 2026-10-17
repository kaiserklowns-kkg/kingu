<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { applyEvent, columns, COLUMNS, describeChange, initBoard, mergeSnapshot, STATUS_LABELS, timeAgo, type Task, type TeamEvent } from '#lib/board.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let board = $state(initBoard(untrack(() => data.tasks)));
	let project = $state('');
	let live = $state<'connecting' | 'live' | 'retrying'>('connecting');
	let announcement = $state('');
	let now = $state(Date.now());

	// A fresh snapshot (reconnect / reset) merges in without regressing streamed state.
	$effect(() => {
		const tasks = data.tasks;
		board = mergeSnapshot(untrack(() => board), tasks);
	});

	const cols = $derived(columns(board, project));
	const projectName = $derived(new Map(data.projects.map((p) => [p.id, p.name])));

	onMount(() => {
		const tick = setInterval(() => (now = Date.now()), 30_000);
		// Same-origin proxy: the cookie authenticates, the token stays server-side.
		const es = new EventSource('/api/events');
		const onTask = (e: MessageEvent<string>) => {
			let ev: TeamEvent;
			try {
				ev = JSON.parse(e.data);
			} catch {
				return;
			}
			const before = board;
			const next = applyEvent(before, ev);
			if (next === before) return;
			const id = typeof ev.data?.id === 'string' ? ev.data.id : '';
			if (next.tasks !== before.tasks && next.tasks[id]) announcement = describeChange(before.tasks[id], next.tasks[id]);
			board = next;
		};
		es.addEventListener('task.created', onTask);
		es.addEventListener('task.updated', onTask);
		es.addEventListener('reset', () => void invalidateAll());
		es.onopen = () => {
			// Covers anything that changed between the page load and the stream starting.
			if (live !== 'connecting') void invalidateAll();
			live = 'live';
		};
		es.onerror = () => {
			live = es.readyState === EventSource.CLOSED ? 'connecting' : 'retrying';
			if (es.readyState === EventSource.CLOSED) location.assign('/login');
		};
		void invalidateAll();
		return () => {
			clearInterval(tick);
			es.close();
		};
	});

	const owner = (t: Task) => t.updated_by ?? t.created_by;
</script>

<svelte:head><title>บอร์ดทีม — Kingu</title></svelte:head>

<main class="mx-auto max-w-7xl px-4 py-4">
	<div class="mb-4 flex flex-wrap items-center gap-3">
		<h1 class="text-lg font-semibold text-(--vscode-tab-activeForeground)">บอร์ดทีม</h1>
		<span class="flex items-center gap-1.5 text-xs text-(--vscode-descriptionForeground)" role="status">
			<span aria-hidden="true" class={['inline-block size-2 rounded-full', live === 'live' ? 'bg-[#2EA043]' : 'bg-(--vscode-editorWarning-foreground)']}></span>
			{live === 'live' ? 'อัปเดตสด' : live === 'retrying' ? 'กำลังเชื่อมต่อใหม่…' : 'กำลังเชื่อมต่อ…'}
		</span>
		<label class="ml-auto flex items-center gap-2 text-sm">
			<span>โปรเจกต์</span>
			<select
				bind:value={project}
				class="h-8 max-w-[60vw] rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 text-(--vscode-input-foreground)"
			>
				<option value="">ทั้งหมด</option>
				{#each data.projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
			</select>
		</label>
	</div>

	<p class="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>

	<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
		{#each COLUMNS as col (col.id)}
			<section aria-labelledby={`col-${col.id}`} class="flex min-w-0 flex-col rounded-md border border-(--vscode-panel-border) bg-(--vscode-sideBar-background)">
				<h2 id={`col-${col.id}`} class="flex items-center gap-2 border-b border-(--vscode-panel-border) px-3 py-2 text-sm font-semibold">
					{col.label}
					<span class="rounded-full bg-(--vscode-badge-background) px-2 text-xs text-(--vscode-badge-foreground)" aria-label={`${cols[col.id].length} งาน`}>{cols[col.id].length}</span>
				</h2>
				<ul class="flex flex-col gap-2 p-2" aria-labelledby={`col-${col.id}`}>
					{#each cols[col.id] as t (t.id)}
						<li>
							<article class="rounded-md border border-(--vscode-widget-border) bg-(--vscode-editor-background) p-3" aria-labelledby={`task-${t.id}`}>
								<div class="flex items-start gap-2">
									<h3 id={`task-${t.id}`} class="min-w-0 flex-1 font-medium break-words text-(--vscode-tab-activeForeground)">{t.title}</h3>
									<span
										class={[
											'shrink-0 rounded-sm px-1.5 text-xs',
											t.status === 'failed' ? 'bg-[#F8514926] text-(--vscode-errorForeground)' : t.status === 'needs_input' || t.status === 'review' ? 'bg-[#CCA70026] text-(--vscode-editorWarning-foreground)' : 'bg-(--vscode-badge-background) text-(--vscode-badge-foreground)'
										]}>{STATUS_LABELS[t.status]}</span
									>
								</div>
								{#if t.branch}
									<p class="mt-1 truncate font-mono text-xs text-(--vscode-descriptionForeground)" title={t.branch}><span class="sr-only">branch </span>⎇ {t.branch}</p>
								{/if}
								<dl class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-(--vscode-descriptionForeground)">
									{#if t.agent || t.model}
										<div class="flex gap-1"><dt class="sr-only">เอเจนต์และโมเดล</dt><dd>{[t.agent, t.model].filter(Boolean).join(' · ')}</dd></div>
									{/if}
									{#if t.additions || t.deletions}
										<div class="flex gap-1 font-mono">
											<dt class="sr-only">บรรทัดที่เปลี่ยน</dt>
											<dd><span class="text-[#2EA043]" aria-label={`เพิ่ม ${t.additions} บรรทัด`}>+{t.additions}</span> <span class="text-(--vscode-errorForeground)" aria-label={`ลบ ${t.deletions} บรรทัด`}>−{t.deletions}</span></dd>
										</div>
									{/if}
									<div class="flex gap-1"><dt class="sr-only">ผู้รับผิดชอบ</dt><dd>{owner(t)}</dd></div>
									<div class="ml-auto flex gap-1">
										<dt class="sr-only">อัปเดตล่าสุด</dt>
										<dd><time datetime={t.updated_at} title={new Date(t.updated_at).toLocaleString('th-TH')}>{timeAgo(t.updated_at, now)}</time></dd>
									</div>
								</dl>
								{#if !project && projectName.get(t.project_id)}
									<p class="mt-1 text-xs text-(--vscode-descriptionForeground)">{projectName.get(t.project_id)}</p>
								{/if}
							</article>
						</li>
					{:else}
						<li class="px-2 py-6 text-center text-sm text-(--vscode-descriptionForeground)">ไม่มีงาน</li>
					{/each}
				</ul>
			</section>
		{/each}
	</div>
</main>
