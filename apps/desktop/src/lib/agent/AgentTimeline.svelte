<script lang="ts" module>
	import type { RunState } from './events';

	export type TimelineRun = Pick<RunState, 'items' | 'draft' | 'decisions' | 'ended' | 'result'>;
</script>

<script lang="ts">
	// An agent run as a timeline: messages (with the streaming draft of the current one), thinking,
	// tool calls and results, permission requests (a card while pending when `onanswer` is given,
	// then the decision), errors, and each turn's result with its usage. Shared by the Agent panel
	// and the ADE task page. Keeps the newest event in view.
	import type { Snippet } from 'svelte';
	import PermissionCard from './PermissionCard.svelte';
	import QuestionCard from './QuestionCard.svelte';
	import { answersFor, parseAsk } from './ask';
	import { firstLine, formatUsage, toolArg, type Decision, type PermissionRequest } from './events';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { chatLook } from '#lib/ade/chatLook.ts';

	let {
		run,
		onanswer,
		empty,
		class: klass = ''
	}: {
		run: TimelineRun | undefined;
		/** `answers`: an AskUserQuestion's, question text → answer (with `allow`). */
		onanswer?: (request: PermissionRequest, decision: Decision, message?: string, answers?: Record<string, string>) => void;
		empty?: Snippet;
		class?: string;
	} = $props();

	let timeline: HTMLDivElement;
	// Orca's chat appearance (kingu.chat.*): text and code size, width, contrast, terminal font.
	const look = $derived(chatLook((id) => settings.get(id)));

	$effect(() => {
		void run?.items.length;
		void run?.draft.text.length;
		void run?.draft.thinking.length;
		if (timeline) timeline.scrollTop = timeline.scrollHeight;
	});

	const DECISION_LABEL: Record<string, string> = {
		allow: 'อนุญาตแล้ว (allowed)',
		allow_always: 'อนุญาตเสมอในงานนี้ (always allowed)',
		deny: 'ไม่อนุญาต (denied)',
		cancelled: 'ยกเลิก (cancelled)'
	};
	const QUESTION_LABEL: Record<string, string> = {
		allow: 'ตอบแล้ว (answered)',
		allow_always: 'ตอบแล้ว (answered)',
		deny: 'ไม่ได้ตอบ (dismissed)',
		cancelled: 'ยกเลิก (cancelled)'
	};
	const isAsk = (ev: PermissionRequest) => ev.tool === 'AskUserQuestion';
</script>

<div
	bind:this={timeline}
	class={['kg-selectable kg-chat min-h-0 overflow-y-auto', klass]}
	aria-live="polite"
	style:font-size="{look.fontSize}px"
	style:--kg-chat-code-size="{look.codeFontSize}px"
	style:font-family={look.fontFamily}
	style:filter={look.contrast === 100 ? undefined : `contrast(${look.contrast}%)`}
>
	<div class="mx-auto space-y-1" style:max-width={look.maxWidth}>
	{#if run && (run.items.length || run.draft.text || run.draft.thinking)}
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
						{ev.tool}: {(isAsk(ev) ? QUESTION_LABEL : DECISION_LABEL)[decided]}
					</div>
				{:else if onanswer && !run.ended && isAsk(ev) && parseAsk(ev.input)}
					{@const ask = parseAsk(ev.input)!}
					<QuestionCard prompt={ask} onsubmit={(sels) => onanswer(ev, 'allow', undefined, answersFor(ask, sels))} ondismiss={() => onanswer(ev, 'deny')} />
				{:else if onanswer && !run.ended}
					<PermissionCard request={ev} onanswer={(decision, message) => onanswer(ev, decision, message)} />
				{:else}
					<div class="truncate font-mono text-amber-300" title={ev.input_summary}><span>◆</span> {isAsk(ev) ? `ถาม: ${firstLine(ev.input_summary)}` : `ขออนุญาตใช้ ${ev.tool}`} (รอคำตอบ)</div>
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
				<div class="text-neutral-400">{ev.stopped ? 'จบงานแล้ว' : `จบการทำงาน${ev.code ? ` (exit ${ev.code})` : ev.signal != null ? ` (signal ${ev.signal})` : ''}`}</div>
			{/if}
		{/each}
		{#if run.draft.thinking}<p class="whitespace-pre-wrap text-neutral-500 italic">{run.draft.thinking}</p>{/if}
		{#if run.draft.text}<p class="whitespace-pre-wrap text-neutral-100">{run.draft.text}<span class="animate-pulse">▍</span></p>{/if}
		{#if run.ended && run.result}
			<div class="pt-1 text-neutral-500">รวมทั้ง session: {formatUsage(run.result)}</div>
		{/if}
	{:else}
		{@render empty?.()}
	{/if}
	</div>
</div>

<style>
	/* kingu.chat.codeFontSize: tool calls, commands and other monospace lines. */
	.kg-chat :global(.font-mono) {
		font-size: var(--kg-chat-code-size);
	}
</style>
