<script lang="ts">
	// A pending permission request with allow / always allow / deny (+ optional reason). Shared by
	// the Agent panel and the ADE task page (through AgentTimeline).
	import type { Decision, PermissionRequest } from './events';

	let { request, onanswer }: { request: PermissionRequest; onanswer: (decision: Decision, message?: string) => void } = $props();

	let reason = $state('');
	let sent = $state(false);

	function answer(decision: Decision) {
		if (sent) return;
		sent = true;
		onanswer(decision, decision === 'deny' ? reason : undefined);
		// The card goes away on `permission_resolved`; re-enable if that never comes (e.g. the call failed).
		setTimeout(() => (sent = false), 3000);
	}
</script>

<div class="space-y-1.5 rounded border border-amber-600/70 bg-amber-950/30 p-2" role="group" aria-label="คำขออนุญาต {request.tool}">
	<div class="font-medium text-amber-300">ขออนุญาตใช้ {request.tool} <span class="font-normal text-amber-200/70">(Permission request)</span></div>
	{#if request.title}<div class="text-neutral-300">{request.title}</div>{/if}
	{#if request.input_summary}
		<pre class="max-h-32 overflow-auto rounded bg-black/40 px-2 py-1 font-mono break-all whitespace-pre-wrap text-neutral-100">{request.input_summary}</pre>
	{/if}
	{#if request.diff}
		<div class="font-mono"><span class="text-emerald-400">+{request.diff.added}</span> <span class="text-red-400">−{request.diff.removed}</span> บรรทัด (lines)</div>
	{/if}
	{#if request.detail}<div class="text-neutral-400">{request.detail}</div>{/if}
	<input
		class="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 outline-none focus:border-sky-600"
		placeholder="เหตุผลที่ไม่อนุญาต (ไม่บังคับ) — reason if denying"
		aria-label="เหตุผลที่ไม่อนุญาต"
		bind:value={reason}
	/>
	<div class="flex flex-wrap gap-1.5">
		<button class="rounded bg-emerald-700 px-2 py-0.5 text-white hover:bg-emerald-600 disabled:opacity-50" title="Allow once" disabled={sent} onclick={() => answer('allow')}>อนุญาต</button>
		{#if request.can_always}
			<button class="rounded bg-emerald-900 px-2 py-0.5 text-emerald-100 hover:bg-emerald-800 disabled:opacity-50" title="Always allow for this task's session" disabled={sent} onclick={() => answer('allow_always')}
				>อนุญาตเสมอในงานนี้</button
			>
		{/if}
		<button class="rounded bg-red-800 px-2 py-0.5 text-white hover:bg-red-700 disabled:opacity-50" title="Deny" disabled={sent} onclick={() => answer('deny')}>ไม่อนุญาต</button>
	</div>
</div>
