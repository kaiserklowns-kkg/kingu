<script lang="ts">
	import { enhance } from '$app/forms';
	import { timeAgo } from '#lib/board.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const isAdmin = $derived(data.me?.role === 'owner' || data.me?.role === 'lead');

	function permissions(p: { network: boolean; fs: string; secrets: string[] }): string {
		return [p.network ? 'เครือข่าย' : null, p.fs === 'home' ? 'โฮมโฟลเดอร์' : null, ...p.secrets.map((s) => `secret ${s}`)].filter(Boolean).join(', ') || '—';
	}
</script>

<svelte:head><title>Snap ของทีม — Kingu</title></svelte:head>

<main class="mx-auto max-w-7xl px-4 py-4">
	<h1 class="mb-1 text-lg font-semibold text-(--vscode-tab-activeForeground)">Snap ของทีม</h1>
	<p class="mb-4 text-(--vscode-descriptionForeground)">
		Snap ที่ทีมอนุมัติและตรึง commit ไว้ อนุมัติจากแอป Kingu (Snaps → Approve for Team) เซิร์ฟเวอร์เก็บเฉพาะ metadata ไม่เก็บไฟล์ของ snap
	</p>
	{#if form?.error}<p role="alert" class="mb-3 text-(--vscode-errorForeground)">{form.error}</p>{/if}
	{#if form?.removed}<p role="status" class="mb-3 text-(--vscode-descriptionForeground)">ถอน {form.removed} ออกจากทีมแล้ว</p>{/if}
	{#if data.snaps.length === 0}
		<p class="text-(--vscode-descriptionForeground)">ทีมยังไม่ได้อนุมัติ Snap</p>
	{:else}
		<!-- Scrollable at phone width, so it must be keyboard-focusable (WCAG 2.1.1). -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="overflow-x-auto rounded-md border border-(--vscode-panel-border)" role="region" aria-labelledby="snaps-caption" tabindex="0">
			<table class="w-full min-w-[760px] border-collapse text-left text-sm">
				<caption id="snaps-caption" class="sr-only">Snap ที่ทีมอนุมัติ {data.snaps.length} รายการ</caption>
				<thead class="bg-(--vscode-sideBar-background) text-(--vscode-descriptionForeground)">
					<tr>
						<th scope="col" class="px-3 py-2 font-medium">Snap</th>
						<th scope="col" class="px-3 py-2 font-medium">เวอร์ชัน</th>
						<th scope="col" class="px-3 py-2 font-medium">ที่มา</th>
						<th scope="col" class="px-3 py-2 font-medium">สิทธิ์</th>
						<th scope="col" class="px-3 py-2 font-medium">อนุมัติ</th>
						{#if isAdmin}<th scope="col" class="px-3 py-2 font-medium"><span class="sr-only">จัดการ</span></th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each data.snaps as s (s.snap_id)}
						<tr class="border-t border-(--vscode-panel-border) hover:bg-(--vscode-list-hoverBackground)">
							<th scope="row" class="px-3 py-2 font-normal text-(--vscode-tab-activeForeground)">
								{s.name} <span class="text-(--vscode-descriptionForeground)">({s.snap_id})</span>
								{#if s.required}<span class="ml-1 rounded-full bg-(--vscode-badge-background) px-1.5 text-xs text-(--vscode-badge-foreground)">required</span>{/if}
								{#if s.note}<div class="text-xs text-(--vscode-descriptionForeground)">{s.note}</div>{/if}
							</th>
							<td class="px-3 py-2 whitespace-nowrap">v{s.version}</td>
							<td class="max-w-[280px] truncate px-3 py-2 font-mono text-xs" title={`${s.git_url}${s.git_ref ? `#${s.git_ref}` : ''} @ ${s.commit_sha}\nSHA-256 ${s.manifest_sha256}`}>
								{s.git_url}{s.git_ref ? `#${s.git_ref}` : ''} @ {s.commit_sha.slice(0, 7)}
							</td>
							<td class="px-3 py-2">{permissions(s.permissions)}</td>
							<td class="px-3 py-2 whitespace-nowrap"
								>{s.approved_by} · <time datetime={s.approved_at} title={new Date(s.approved_at).toLocaleString('th-TH')}>{timeAgo(s.approved_at)}</time></td
							>
							{#if isAdmin}
								<td class="px-3 py-2 text-right">
									<form
										method="POST"
										action="?/remove"
										use:enhance
										onsubmit={(e) => {
											if (!confirm(`ถอน ${s.name} ออกจาก Snap ของทีม? เครื่องที่ติดตั้งไว้แล้วยังใช้ต่อได้`)) e.preventDefault();
										}}
									>
										<input type="hidden" name="snap_id" value={s.snap_id} />
										<button type="submit" class="rounded-sm border border-(--vscode-widget-border) px-2 py-0.5 hover:bg-(--vscode-toolbar-hoverBackground)">ถอนออก</button>
									</form>
								</td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</main>
