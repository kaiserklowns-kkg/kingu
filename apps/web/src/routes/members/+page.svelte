<script lang="ts">
	import { enhance } from '$app/forms';
	import { timeAgo } from '#lib/board.ts';
	import { assignableRoles, canManage, ROLE_HINT, ROLE_LABEL, TOKEN_TTLS } from '#lib/admin.ts';
	import Pager from '#lib/Pager.svelte';
	import TokenReveal from '#lib/TokenReveal.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const me = $derived(data.me?.role);
	const addRoles = $derived(assignableRoles(me, null));
	const isOwner = $derived(me === 'owner');
	const input =
		'h-8 rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 text-(--vscode-input-foreground) placeholder:text-(--vscode-input-placeholderForeground)';
	const button = 'rounded-sm border border-(--vscode-widget-border) px-2 py-0.5 hover:bg-(--vscode-toolbar-hoverBackground)';
</script>

<svelte:head><title>สมาชิก — Kingu</title></svelte:head>

<main class="mx-auto max-w-7xl px-4 py-4">
	<h1 class="mb-1 text-lg font-semibold text-(--vscode-tab-activeForeground)">สมาชิก</h1>
	<p class="mb-4 text-(--vscode-descriptionForeground)">
		บทบาทมีผลทันทีกับทุก token ของสมาชิก นำสมาชิกออกแล้ว token ทั้งหมดของเขาจะถูกลบไปด้วย
	</p>

	{#if form?.error}<p role="alert" class="mb-3 text-(--vscode-errorForeground)">{form.error}</p>{/if}
	{#if form?.added}<p role="status" class="mb-3">บันทึก {form.added} แล้ว{isOwner ? ' สร้าง token ให้เขาได้จากแถวของเขาด้านล่าง' : ''}</p>{/if}
	{#if form?.changed}<p role="status" class="mb-3">เปลี่ยน {form.changed} เป็น {form.role} แล้ว</p>{/if}
	{#if form?.removed}<p role="status" class="mb-3">นำ {form.removed} ออกจากทีมแล้ว</p>{/if}
	{#if form?.minted}<TokenReveal minted={form.minted} who={form.minted.user_id} />{/if}

	{#if addRoles.length > 0}
		<form method="POST" action="?/add" use:enhance class="mb-4 flex flex-wrap items-end gap-2 rounded-md border border-(--vscode-panel-border) bg-(--vscode-sideBar-background) p-3">
			<div class="flex flex-col gap-1">
				<label for="new-user" class="text-xs text-(--vscode-descriptionForeground)">User id</label>
				<input id="new-user" name="user_id" required maxlength="255" autocomplete="off" spellcheck="false" placeholder="เช่น alice@example.com" value={form && 'user' in form ? form.user : ''} class={input} />
			</div>
			<div class="flex flex-col gap-1">
				<label for="new-role" class="text-xs text-(--vscode-descriptionForeground)">บทบาท</label>
				<select id="new-role" name="role" class={input}>
					{#each addRoles as r (r)}<option value={r} selected={r === 'dev'}>{ROLE_LABEL[r]}</option>{/each}
				</select>
			</div>
			<button type="submit" class="h-8 rounded-sm bg-(--vscode-button-background) px-3 text-(--vscode-button-foreground) hover:brightness-110">เพิ่มสมาชิก</button>
		</form>
	{/if}

	<details class="mb-4 text-(--vscode-descriptionForeground)">
		<summary class="cursor-pointer">แต่ละบทบาททำอะไรได้</summary>
		<dl class="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
			{#each Object.entries(ROLE_HINT) as [r, hint] (r)}
				<dt class="font-medium text-(--vscode-foreground)">{ROLE_LABEL[r as keyof typeof ROLE_LABEL]}</dt>
				<dd>{hint}</dd>
			{/each}
		</dl>
	</details>

	<!-- Scrollable at phone width, so it must be keyboard-focusable (WCAG 2.1.1). -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div class="overflow-x-auto rounded-md border border-(--vscode-panel-border)" role="region" aria-labelledby="members-caption" tabindex="0">
		<table class="w-full min-w-[640px] border-collapse text-left text-sm">
			<caption id="members-caption" class="sr-only">สมาชิก {data.members.length} คน</caption>
			<thead class="bg-(--vscode-sideBar-background) text-(--vscode-descriptionForeground)">
				<tr>
					<th scope="col" class="px-3 py-2 font-medium">สมาชิก</th>
					<th scope="col" class="px-3 py-2 font-medium">บทบาท</th>
					<th scope="col" class="px-3 py-2 font-medium">Token ที่ใช้ได้</th>
					<th scope="col" class="px-3 py-2 font-medium">เข้าร่วม</th>
					<th scope="col" class="px-3 py-2 font-medium"><span class="sr-only">จัดการ</span></th>
				</tr>
			</thead>
			<tbody>
				{#each data.members as m (m.user_id)}
					{@const roles = assignableRoles(me, m.role)}
					<tr class="border-t border-(--vscode-panel-border) hover:bg-(--vscode-list-hoverBackground)">
						<th scope="row" class="max-w-[280px] truncate px-3 py-2 font-normal text-(--vscode-tab-activeForeground)" title={m.user_id}>
							{m.user_id}{#if m.user_id === data.me?.user_id}<span class="ml-1 text-(--vscode-descriptionForeground)">(คุณ)</span>{/if}
						</th>
						<td class="px-3 py-2">
							{#if roles.length > 1}
								<form method="POST" action="?/role" use:enhance class="flex items-center gap-1">
									<input type="hidden" name="user_id" value={m.user_id} />
									<label class="sr-only" for={`role-${m.user_id}`}>บทบาทของ {m.user_id}</label>
									<select id={`role-${m.user_id}`} name="role" class={input} onchange={(e) => e.currentTarget.form?.requestSubmit()}>
										{#each roles as r (r)}<option value={r} selected={r === m.role}>{ROLE_LABEL[r]}</option>{/each}
									</select>
									<noscript><button type="submit" class={button}>บันทึก</button></noscript>
								</form>
							{:else}
								{ROLE_LABEL[m.role]}
							{/if}
						</td>
						<td class="px-3 py-2">{m.active_tokens}</td>
						<td class="px-3 py-2 whitespace-nowrap"><time datetime={m.created_at} title={new Date(m.created_at).toLocaleString('th-TH')}>{timeAgo(m.created_at)}</time></td>
						<td class="px-3 py-2">
							<div class="flex flex-wrap justify-end gap-2">
								{#if isOwner}
									<form method="POST" action="?/token" use:enhance class="flex items-center gap-1">
										<input type="hidden" name="user_id" value={m.user_id} />
										<label class="sr-only" for={`ttl-${m.user_id}`}>อายุ token ของ {m.user_id}</label>
										<select id={`ttl-${m.user_id}`} name="ttl_hours" class={input}>
											{#each TOKEN_TTLS as t (t.hours)}<option value={t.hours} selected={t.hours === 24 * 90}>{t.label}</option>{/each}
										</select>
										<button type="submit" class={button}>สร้าง token</button>
									</form>
								{/if}
								{#if canManage(me, m.role, null)}
									<form
										method="POST"
										action="?/remove"
										use:enhance
										onsubmit={(e) => {
											if (!confirm(`นำ ${m.user_id} ออกจากทีม? token ทั้งหมดของเขาจะใช้ไม่ได้ทันที`)) e.preventDefault();
										}}
									>
										<input type="hidden" name="user_id" value={m.user_id} />
										<button type="submit" class={button}>นำออก</button>
									</form>
								{/if}
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<Pager next={data.nextCursor} paged={data.paged} />
</main>
