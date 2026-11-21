<script lang="ts">
	import { timeAgo } from '#lib/board.ts';
	import { actionLabel, AUDIT_GROUPS, auditSummary } from '#lib/admin.ts';
	import Pager from '#lib/Pager.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const input =
		'h-8 rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 text-(--vscode-input-foreground) placeholder:text-(--vscode-input-placeholderForeground)';
</script>

<svelte:head><title>Audit log — Kingu</title></svelte:head>

<main class="mx-auto max-w-7xl px-4 py-4">
	<h1 class="mb-1 text-lg font-semibold text-(--vscode-tab-activeForeground)">Audit log</h1>
	<p class="mb-4 text-(--vscode-descriptionForeground)">ทุกการเปลี่ยนแปลงในทีม ใหม่สุดก่อน บันทึกแล้วแก้หรือลบไม่ได้</p>

	<form method="GET" class="mb-4 flex flex-wrap items-end gap-2">
		<div class="flex flex-col gap-1">
			<label for="f-action" class="text-xs text-(--vscode-descriptionForeground)">ประเภท</label>
			<select id="f-action" name="action" class={input}>
				{#each AUDIT_GROUPS as g (g.value)}<option value={g.value} selected={g.value === data.action}>{g.label}</option>{/each}
			</select>
		</div>
		<div class="flex flex-col gap-1">
			<label for="f-actor" class="text-xs text-(--vscode-descriptionForeground)">ผู้ทำ</label>
			<input id="f-actor" name="actor" value={data.actor} maxlength="255" autocomplete="off" placeholder="user id" class={input} />
		</div>
		<button type="submit" class="h-8 rounded-sm bg-(--vscode-button-background) px-3 text-(--vscode-button-foreground) hover:brightness-110">กรอง</button>
		{#if data.action || data.actor}<a href="/audit" class="self-center">ล้างตัวกรอง</a>{/if}
	</form>

	{#if data.entries.length === 0}
		<p class="text-(--vscode-descriptionForeground)">ไม่มีรายการ</p>
	{:else}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="overflow-x-auto rounded-md border border-(--vscode-panel-border)" role="region" aria-labelledby="audit-caption" tabindex="0">
			<table class="w-full min-w-[720px] border-collapse text-left text-sm">
				<caption id="audit-caption" class="sr-only">Audit log {data.entries.length} รายการ</caption>
				<thead class="bg-(--vscode-sideBar-background) text-(--vscode-descriptionForeground)">
					<tr>
						<th scope="col" class="px-3 py-2 font-medium">เวลา</th>
						<th scope="col" class="px-3 py-2 font-medium">ผู้ทำ</th>
						<th scope="col" class="px-3 py-2 font-medium">การกระทำ</th>
						<th scope="col" class="px-3 py-2 font-medium">รายละเอียด</th>
					</tr>
				</thead>
				<tbody>
					{#each data.entries as e (e.id)}
						<tr class="border-t border-(--vscode-panel-border) hover:bg-(--vscode-list-hoverBackground)">
							<td class="px-3 py-2 whitespace-nowrap"><time datetime={e.created_at} title={new Date(e.created_at).toLocaleString('th-TH')}>{timeAgo(e.created_at)}</time></td>
							<td class="max-w-[200px] truncate px-3 py-2" title={e.actor}>{e.actor}</td>
							<th scope="row" class="px-3 py-2 font-normal whitespace-nowrap" title={e.action}>{actionLabel(e.action)}</th>
							<td class="max-w-[420px] truncate px-3 py-2 text-(--vscode-descriptionForeground)" title={auditSummary(e)}>{auditSummary(e)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
	<Pager next={data.nextCursor} paged={data.paged} />
</main>
