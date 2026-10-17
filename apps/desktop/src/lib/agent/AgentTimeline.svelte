<script lang="ts">
	// An agent run's events as a timeline (tool calls, results, messages, the final result).
	// Shared by the Agent panel and the ADE task page. Keeps the newest event in view.
	import type { Snippet } from 'svelte';
	import { firstLine, toolArg, type AgentEvent } from './events';

	let { events, empty, class: klass = '' }: { events: AgentEvent[]; empty?: Snippet; class?: string } = $props();

	let timeline: HTMLDivElement;

	$effect(() => {
		if (events.length && timeline) timeline.scrollTop = timeline.scrollHeight;
	});

	function cost(usd: number | null) {
		return usd == null ? '' : ` · $${usd.toFixed(4)}`;
	}
</script>

<div bind:this={timeline} class={['min-h-0 space-y-1 overflow-y-auto text-xs', klass]} aria-live="polite">
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
		{@render empty?.()}
	{/each}
</div>
