<script lang="ts">
	import { enhance } from '$app/forms';
	import { STATUS_LABELS, timeAgo, type TaskStatus } from '#lib/board.ts';
	import { formatCost } from '#lib/runs.ts';
	import { isAdmin } from '#lib/admin.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const t = $derived(data.task);
	const role = $derived(data.me?.role);
	const canEdit = $derived(!!role && role !== 'viewer');
	const canClose = (createdBy: string | null) => isAdmin(role) || (role === 'dev' && createdBy === data.me?.user_id);
	const statuses = Object.keys(STATUS_LABELS) as TaskStatus[];
	const fmt = new Intl.NumberFormat('th-TH');
	const input =
		'h-8 rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 text-(--vscode-input-foreground) placeholder:text-(--vscode-input-placeholderForeground)';
	const label = 'text-xs text-(--vscode-descriptionForeground)';
	const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('th-TH') : '—');
	const total = $derived(data.runs.reduce((n, r) => n + (r.cost_usd ?? 0), 0));
</script>

<svelte:head><title>{t.title} — Kingu</title></svelte:head>

<main class="mx-auto max-w-5xl px-4 py-4">
	<nav aria-label="breadcrumb" class="mb-2 text-(--vscode-descriptionForeground)">
		<a href="/">บอร์ดทีม</a> › <a href={`/?project=${t.project_id}`}>{t.project_name}</a>
	</nav>
	<h1 class="mb-1 text-lg font-semibold break-words text-(--vscode-tab-activeForeground)">{t.title}</h1>
	<p class="mb-4 text-(--vscode-descriptionForeground)">
		{STATUS_LABELS[t.status]} · สร้างโดย {t.created_by} {timeAgo(t.created_at)}{t.updated_by ? ` · แก้ล่าสุดโดย ${t.updated_by} ${timeAgo(t.updated_at)}` : ''}
	</p>

	{#if form?.error}<p role="alert" class="mb-3 text-(--vscode-errorForeground)">{form.error}</p>{/if}
	{#if form?.saved}<p role="status" class="mb-3">บันทึกแล้ว</p>{/if}
	{#if form?.closed}<p role="status" class="mb-3">ปิดการรันแล้ว</p>{/if}

	<dl class="mb-6 grid gap-x-6 gap-y-2 rounded-md border border-(--vscode-panel-border) p-3 sm:grid-cols-[max-content_1fr]">
		<dt class={label}>แหล่งที่มา</dt>
		<dd>{t.source === 'manual' ? 'สร้างเอง' : t.source}{t.external_ref ? ` · ${t.external_ref}` : ''}</dd>
		<dt class={label}>Branch</dt>
		<dd class="font-mono text-xs break-all">{t.branch ?? '—'}</dd>
		<dt class={label}>เอเจนต์</dt>
		<dd>{[t.agent, t.model].filter(Boolean).join(' · ') || '—'}</dd>
		<dt class={label}>การเปลี่ยนแปลง</dt>
		<dd>
			<span class="text-(--vscode-gitDecoration-addedResourceForeground)">+{fmt.format(t.additions)}</span>
			<span class="text-(--vscode-gitDecoration-deletedResourceForeground)">−{fmt.format(t.deletions)}</span>
			ใน {fmt.format(t.files_changed)} ไฟล์
		</dd>
		<dt class={label}>เริ่ม / จบ</dt>
		<dd>{when(t.started_at)} / {when(t.finished_at)}</dd>
	</dl>

	{#if canEdit}
		<section aria-labelledby="edit-heading" class="mb-6">
			<h2 id="edit-heading" class="mb-2 text-sm font-semibold text-(--vscode-tab-activeForeground)">แก้ไขงาน</h2>
			<form method="POST" action="?/update" use:enhance class="flex flex-wrap items-end gap-2">
				<div class="flex min-w-0 flex-1 flex-col gap-1">
					<label for="t-title" class={label}>ชื่องาน</label>
					<input id="t-title" name="title" required maxlength="300" value={t.title} class={[input, 'min-w-[16rem]']} />
				</div>
				<div class="flex flex-col gap-1">
					<label for="t-status" class={label}>สถานะ</label>
					<select id="t-status" name="status" class={input}>
						{#each statuses as s (s)}<option value={s} selected={s === t.status}>{STATUS_LABELS[s]}</option>{/each}
					</select>
				</div>
				<div class="flex flex-col gap-1">
					<label for="t-branch" class={label}>Branch</label>
					<input id="t-branch" name="branch" maxlength="255" spellcheck="false" value={t.branch ?? ''} class={[input, 'font-mono']} />
				</div>
				<button type="submit" class="h-8 rounded-sm bg-(--vscode-button-background) px-3 text-(--vscode-button-foreground) hover:brightness-110">บันทึก</button>
			</form>
			{#if t.client_task_id}
				<p class="mt-2 text-xs text-(--vscode-descriptionForeground)">งานนี้ซิงก์จากแอป Kingu การเปลี่ยนครั้งถัดไปบนเครื่องนั้นจะเขียนทับสถานะและ branch</p>
			{/if}
		</section>
	{/if}

	<section aria-labelledby="runs-heading" class="mb-6">
		<h2 id="runs-heading" class="mb-2 text-sm font-semibold text-(--vscode-tab-activeForeground)">
			การรัน {data.runs.length} ครั้ง <span class="font-normal text-(--vscode-descriptionForeground)">· {formatCost(total)}</span>
		</h2>
		{#if data.runs.length === 0}
			<p class="text-(--vscode-descriptionForeground)">ยังไม่มีการรัน</p>
		{:else}
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div class="overflow-x-auto rounded-md border border-(--vscode-panel-border)" role="region" aria-labelledby="runs-heading" tabindex="0">
				<table class="w-full min-w-[640px] border-collapse text-left text-sm">
					<thead class="bg-(--vscode-sideBar-background) text-(--vscode-descriptionForeground)">
						<tr>
							<th scope="col" class="px-3 py-2 font-medium">เริ่ม</th>
							<th scope="col" class="px-3 py-2 font-medium">ผู้รัน</th>
							<th scope="col" class="px-3 py-2 font-medium">เอเจนต์</th>
							<th scope="col" class="px-3 py-2 font-medium">ผลลัพธ์</th>
							<th scope="col" class="px-3 py-2 text-right font-medium">โทเคน</th>
							<th scope="col" class="px-3 py-2 text-right font-medium">ค่าใช้จ่าย</th>
						</tr>
					</thead>
					<tbody>
						{#each data.runs as r (r.id)}
							<tr class="border-t border-(--vscode-panel-border)">
								<td class="px-3 py-2 whitespace-nowrap"><time datetime={r.started_at} title={when(r.started_at)}>{timeAgo(r.started_at)}</time></td>
								<td class="px-3 py-2">{r.created_by ?? '—'}</td>
								<td class="px-3 py-2">{[r.adapter, r.model].filter(Boolean).join(' · ')}</td>
								<td class="px-3 py-2">
									{#if r.ended_at}{r.exit_reason ?? 'จบแล้ว'}{:else}
										กำลังรัน
										{#if canClose(r.created_by)}
											<form method="POST" action="?/close" use:enhance class="ml-1 inline">
												<input type="hidden" name="id" value={r.id} />
												<button type="submit" class="rounded-sm border border-(--vscode-widget-border) px-1.5 text-xs hover:bg-(--vscode-toolbar-hoverBackground)">ปิด</button>
											</form>
										{/if}
									{/if}
								</td>
								<td class="px-3 py-2 text-right font-mono whitespace-nowrap">{fmt.format(r.input_tokens)} / {fmt.format(r.output_tokens)}</td>
								<td class="px-3 py-2 text-right font-mono whitespace-nowrap">{formatCost(r.cost_usd)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	{#if isAdmin(role)}
		<form
			method="POST"
			action="?/delete"
			use:enhance
			onsubmit={(e) => {
				if (!confirm(`ลบงาน “${t.title}” และประวัติการรันของมัน?${t.client_task_id ? ' งานที่ซิงก์จากแอปจะกลับมาเมื่อเครื่องนั้นเปลี่ยนสถานะครั้งถัดไป' : ''}`)) e.preventDefault();
			}}
		>
			<button type="submit" class="rounded-sm border border-(--vscode-errorForeground) px-2 py-0.5 text-(--vscode-errorForeground) hover:bg-(--vscode-toolbar-hoverBackground)">ลบงาน</button>
		</form>
	{/if}
</main>
