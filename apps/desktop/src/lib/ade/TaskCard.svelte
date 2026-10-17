<script lang="ts">
	// One task, Orca-style: title, branch, agent + model, last event, +/- vs base, time ago and the
	// review/PR chip. Enter/click opens the task page; actions show on hover and keyboard focus.
	import Icon from '#lib/workbench/Icon.svelte';
	import { aggregateStats, reviewChip, STATUS_LABEL, timeAgo, type TaskView } from './model';
	import { adeTasks } from './tasks.svelte';
	import { ICON_BUTTON, STATUS_DOT, TONE } from './ui';

	let { view }: { view: TaskView } = $props();

	const meta = $derived(view.meta);
	const totals = $derived(view.stat ? aggregateStats(view.stat.files) : null);
	const chip = $derived(reviewChip(view));
	const when = $derived(Math.max(meta.updated_at, view.runtime?.updatedAt ?? 0));
	const summary = $derived(view.runtime?.lastEvent ?? (meta.prompt.split('\n', 1)[0] || ''));
	const busy = $derived(adeTasks.busy[meta.slug]);
	const running = $derived(view.status === 'running' || view.status === 'waiting');
	const model = $derived(view.runtime?.model ?? meta.model);

	function onKey(e: KeyboardEvent) {
		if (e.target !== e.currentTarget) return;
		if (e.key === 'Enter') adeTasks.openTask(meta.slug);
		else if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) void adeTasks.remove(meta.slug);
		else return;
		e.preventDefault();
	}
</script>

<div
	role="button"
	tabindex="0"
	aria-label="{meta.title} — {STATUS_LABEL[view.status]}"
	class="group relative cursor-pointer rounded border border-(--vscode-widget-border) bg-(--vscode-editor-background) p-2 text-xs outline-none hover:border-(--vscode-focusBorder)/60 focus-visible:border-(--vscode-focusBorder)"
	onclick={() => adeTasks.openTask(meta.slug)}
	onkeydown={onKey}
>
	<div class="flex items-center gap-1.5">
		<span class={['size-2 shrink-0 rounded-full', STATUS_DOT[view.status]]} title={STATUS_LABEL[view.status]}></span>
		<span class="min-w-0 flex-1 truncate font-medium text-(--vscode-foreground)" title={meta.title}>{meta.title}</span>
		<span class="shrink-0 text-(--vscode-descriptionForeground)">{timeAgo(when, adeTasks.now)}</span>
	</div>
	<div class="mt-1 flex items-center gap-1 truncate font-mono text-[11px] text-(--vscode-descriptionForeground)" title="kingu/{meta.slug} ← {meta.base}">
		<Icon name="branch" size={12} /><span class="truncate">kingu/{meta.slug}</span><span class="shrink-0 opacity-70">← {meta.base}</span>
	</div>
	<div class="mt-0.5 truncate text-(--vscode-descriptionForeground)">{meta.agent}{model ? ` · ${model}` : ''}</div>
	{#if busy}
		<div class="mt-1 truncate text-(--vscode-editorInfo-foreground)">{busy}…</div>
	{:else if view.status === 'waiting'}
		<div class="mt-1 truncate text-(--vscode-editorWarning-foreground)">รออนุญาต {view.runtime?.pendingPermissions ?? ''} รายการ · {summary}</div>
	{:else if summary}
		<div class="mt-1 truncate text-(--vscode-foreground)/80" title={summary}>{summary}</div>
	{/if}
	<div class="mt-1.5 flex items-center gap-2">
		{#if totals}
			<span class="font-mono"><span class="text-[#73C991]">+{totals.added}</span> <span class="text-[#F48771]">−{totals.deleted}</span></span>
			<span class="text-(--vscode-descriptionForeground)">{totals.files} ไฟล์</span>
		{/if}
		<span class="flex-1"></span>
		<span class={['rounded-full border px-1.5 text-[10px] leading-4 whitespace-nowrap', TONE[chip.tone]]} title={view.statError ?? meta.pr_url ?? ''}>{chip.label}</span>
	</div>
	<div class="absolute top-1 right-1 hidden gap-0.5 rounded bg-(--vscode-editor-background) group-focus-within:flex group-hover:flex">
		{#if running}
			<button class={ICON_BUTTON} aria-label="หยุด agent" title="หยุด agent" onclick={(e) => (e.stopPropagation(), adeTasks.stop(meta.slug))}><Icon name="stop" size={14} /></button>
		{/if}
		<button class={ICON_BUTTON} aria-label="เปิดไฟล์ใน worktree" title="เปิดไฟล์ใน worktree" disabled={!!view.statError} onclick={(e) => (e.stopPropagation(), adeTasks.quickOpen(meta.slug))}>
			<Icon name="goToFile" size={14} />
		</button>
		<button class={ICON_BUTTON} aria-label="ลบงานและ worktree" title="ลบงานและ worktree (Delete)" disabled={running} onclick={(e) => (e.stopPropagation(), adeTasks.remove(meta.slug))}>
			<Icon name="trash" size={14} />
		</button>
	</div>
</div>
