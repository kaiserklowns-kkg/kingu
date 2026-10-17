<script lang="ts">
	import { timeAgo } from '#lib/board.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const fmt = new Intl.NumberFormat('th-TH');
	function duration(start: string, end: string | null): string {
		if (!end) return 'กำลังรัน';
		const s = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
		if (s < 60) return `${s} วินาที`;
		const m = Math.floor(s / 60);
		return m < 60 ? `${m} นาที ${s % 60} วินาที` : `${Math.floor(m / 60)} ชม. ${m % 60} นาที`;
	}
</script>

<svelte:head><title>ประวัติการรัน — Kingu</title></svelte:head>

<main class="mx-auto max-w-7xl px-4 py-4">
	<h1 class="mb-4 text-lg font-semibold text-(--vscode-tab-activeForeground)">ประวัติการรัน</h1>
	{#if data.runs.length === 0}
		<p class="text-(--vscode-descriptionForeground)">ยังไม่มีการรันเอเจนต์</p>
	{:else}
		<!-- Scrollable at phone width, so it must be keyboard-focusable (WCAG 2.1.1). -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="overflow-x-auto rounded-md border border-(--vscode-panel-border)" role="region" aria-labelledby="runs-caption" tabindex="0">
			<table class="w-full min-w-[720px] border-collapse text-left text-sm">
				<caption id="runs-caption" class="sr-only">การรันเอเจนต์ล่าสุด {data.runs.length} รายการ</caption>
				<thead class="bg-(--vscode-sideBar-background) text-(--vscode-descriptionForeground)">
					<tr>
						<th scope="col" class="px-3 py-2 font-medium">งาน</th>
						<th scope="col" class="px-3 py-2 font-medium">เอเจนต์</th>
						<th scope="col" class="px-3 py-2 font-medium">โมเดล</th>
						<th scope="col" class="px-3 py-2 font-medium">เริ่ม</th>
						<th scope="col" class="px-3 py-2 font-medium">ระยะเวลา</th>
						<th scope="col" class="px-3 py-2 font-medium">ผลลัพธ์</th>
						<th scope="col" class="px-3 py-2 text-right font-medium">โทเคน (เข้า/ออก)</th>
					</tr>
				</thead>
				<tbody>
					{#each data.runs as r (r.id)}
						<tr class="border-t border-(--vscode-panel-border) hover:bg-(--vscode-list-hoverBackground)">
							<th scope="row" class="max-w-[280px] truncate px-3 py-2 font-normal text-(--vscode-tab-activeForeground)" title={r.task_title}>{r.task_title}</th>
							<td class="px-3 py-2">{r.adapter}</td>
							<td class="px-3 py-2">{r.model ?? '—'}</td>
							<td class="px-3 py-2 whitespace-nowrap"><time datetime={r.started_at} title={new Date(r.started_at).toLocaleString('th-TH')}>{timeAgo(r.started_at)}</time></td>
							<td class="px-3 py-2 whitespace-nowrap">{duration(r.started_at, r.ended_at)}</td>
							<td class="px-3 py-2">{r.exit_reason ?? '—'}</td>
							<td class="px-3 py-2 text-right font-mono whitespace-nowrap">{fmt.format(r.input_tokens)} / {fmt.format(r.output_tokens)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</main>
