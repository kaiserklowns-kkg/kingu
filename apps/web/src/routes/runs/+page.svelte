<script lang="ts">
	import { timeAgo } from '#lib/board.ts';
	import { costTotals, formatCost } from '#lib/runs.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const totals = $derived(costTotals(data.runs));
	const groups = $derived([
		{ id: 'task', title: 'ต่องาน', rows: totals.byTask },
		{ id: 'person', title: 'ต่อคน', rows: totals.byPerson },
		{ id: 'project', title: 'ต่อโปรเจกต์', rows: totals.byProject }
	]);

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
		<section aria-labelledby="cost-heading" class="mb-6">
			<h2 id="cost-heading" class="mb-2 text-sm font-semibold text-(--vscode-tab-activeForeground)">
				ค่าใช้จ่าย {formatCost(totals.total)}
				<span class="font-normal text-(--vscode-descriptionForeground)">จาก {data.runs.length} การรันล่าสุด{totals.unknown ? ` (ไม่ทราบค่าใช้จ่าย ${totals.unknown} รายการ)` : ''}</span>
			</h2>
			<div class="grid gap-3 md:grid-cols-3">
				{#each groups as g (g.id)}
					<div class="rounded-md border border-(--vscode-panel-border)">
						<table class="w-full border-collapse text-left text-sm">
							<caption class="bg-(--vscode-sideBar-background) px-3 py-2 text-left font-medium text-(--vscode-descriptionForeground)">{g.title}</caption>
							<tbody>
								{#each g.rows.slice(0, 8) as row (row.key)}
									<tr class="border-t border-(--vscode-panel-border)">
										<th scope="row" class="max-w-[200px] truncate px-3 py-1.5 font-normal" title={row.label}>{row.label}</th>
										<td class="px-3 py-1.5 text-right whitespace-nowrap text-(--vscode-descriptionForeground)">{row.runs} รัน</td>
										<td class="px-3 py-1.5 text-right font-mono whitespace-nowrap">{formatCost(row.cost)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/each}
			</div>
		</section>
		<!-- Scrollable at phone width, so it must be keyboard-focusable (WCAG 2.1.1). -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="overflow-x-auto rounded-md border border-(--vscode-panel-border)" role="region" aria-labelledby="runs-caption" tabindex="0">
			<table class="w-full min-w-[840px] border-collapse text-left text-sm">
				<caption id="runs-caption" class="sr-only">การรันเอเจนต์ล่าสุด {data.runs.length} รายการ</caption>
				<thead class="bg-(--vscode-sideBar-background) text-(--vscode-descriptionForeground)">
					<tr>
						<th scope="col" class="px-3 py-2 font-medium">งาน</th>
						<th scope="col" class="px-3 py-2 font-medium">ผู้รัน</th>
						<th scope="col" class="px-3 py-2 font-medium">เอเจนต์</th>
						<th scope="col" class="px-3 py-2 font-medium">โมเดล</th>
						<th scope="col" class="px-3 py-2 font-medium">เริ่ม</th>
						<th scope="col" class="px-3 py-2 font-medium">ระยะเวลา</th>
						<th scope="col" class="px-3 py-2 font-medium">ผลลัพธ์</th>
						<th scope="col" class="px-3 py-2 text-right font-medium">โทเคน (เข้า/ออก)</th>
						<th scope="col" class="px-3 py-2 text-right font-medium">ค่าใช้จ่าย</th>
					</tr>
				</thead>
				<tbody>
					{#each data.runs as r (r.id)}
						<tr class="border-t border-(--vscode-panel-border) hover:bg-(--vscode-list-hoverBackground)">
							<th scope="row" class="max-w-[280px] truncate px-3 py-2 font-normal text-(--vscode-tab-activeForeground)" title={r.task_title}>
								{r.task_title}{#if r.external_ref}<span class="ml-1 text-(--vscode-descriptionForeground)">{r.external_ref}</span>{/if}
							</th>
							<td class="px-3 py-2">{r.created_by ?? '—'}</td>
							<td class="px-3 py-2">{r.adapter}</td>
							<td class="px-3 py-2">{r.model ?? '—'}</td>
							<td class="px-3 py-2 whitespace-nowrap"><time datetime={r.started_at} title={new Date(r.started_at).toLocaleString('th-TH')}>{timeAgo(r.started_at)}</time></td>
							<td class="px-3 py-2 whitespace-nowrap">{duration(r.started_at, r.ended_at)}</td>
							<td class="px-3 py-2">{r.exit_reason ?? '—'}</td>
							<td class="px-3 py-2 text-right font-mono whitespace-nowrap">{fmt.format(r.input_tokens)} / {fmt.format(r.output_tokens)}</td>
							<td class="px-3 py-2 text-right font-mono whitespace-nowrap">{formatCost(r.cost_usd)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</main>
