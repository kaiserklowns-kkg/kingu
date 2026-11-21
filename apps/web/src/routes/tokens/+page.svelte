<script lang="ts">
	import { enhance } from '$app/forms';
	import { timeAgo } from '#lib/board.ts';
	import { TOKEN_STATE_LABEL, TOKEN_TTLS, tokenState } from '#lib/admin.ts';
	import Pager from '#lib/Pager.svelte';
	import TokenReveal from '#lib/TokenReveal.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input =
		'h-8 rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 text-(--vscode-input-foreground) placeholder:text-(--vscode-input-placeholderForeground)';
	const button = 'rounded-sm border border-(--vscode-widget-border) px-2 py-0.5 hover:bg-(--vscode-toolbar-hoverBackground)';
	const date = (iso: string) => new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
</script>

<svelte:head><title>Token — Kingu</title></svelte:head>

<main class="mx-auto max-w-7xl px-4 py-4">
	<h1 class="mb-1 text-lg font-semibold text-(--vscode-tab-activeForeground)">Personal access token</h1>
	<p class="mb-4 text-(--vscode-descriptionForeground)">
		ใช้ token แยกต่อเครื่อง (แอป Kingu, แดชบอร์ด, CI) เพื่อเพิกถอนทีละเครื่องได้ เพิกถอน token ที่ใช้อยู่ตอนนี้จะออกจากระบบทันที
	</p>

	{#if form?.error}<p role="alert" class="mb-3 text-(--vscode-errorForeground)">{form.error}</p>{/if}
	{#if form?.revoked}<p role="status" class="mb-3">เพิกถอน {form.revoked} แล้ว</p>{/if}
	{#if form?.minted}<TokenReveal minted={form.minted} who="คุณ" />{/if}

	<form method="POST" action="?/create" use:enhance class="mb-4 flex flex-wrap items-end gap-2 rounded-md border border-(--vscode-panel-border) bg-(--vscode-sideBar-background) p-3">
		<div class="flex flex-col gap-1">
			<label for="token-name" class="text-xs text-(--vscode-descriptionForeground)">ชื่อ</label>
			<input id="token-name" name="name" required maxlength="100" autocomplete="off" placeholder="เช่น MacBook งาน" class={input} />
		</div>
		<div class="flex flex-col gap-1">
			<label for="token-ttl" class="text-xs text-(--vscode-descriptionForeground)">อายุ</label>
			<select id="token-ttl" name="ttl_hours" class={input}>
				{#each TOKEN_TTLS as t (t.hours)}<option value={t.hours} selected={t.hours === 24 * 90}>{t.label}</option>{/each}
			</select>
		</div>
		<button type="submit" class="h-8 rounded-sm bg-(--vscode-button-background) px-3 text-(--vscode-button-foreground) hover:brightness-110">สร้าง token</button>
	</form>

	{#if data.me?.role === 'owner'}
		<p class="mb-2">
			{#if data.all}<a href="/tokens">ดูเฉพาะของฉัน</a>{:else}<a href="/tokens?all=1">ดู token ของทุกคนในทีม</a>{/if}
		</p>
	{/if}

	{#if data.tokens.length === 0}
		<p class="text-(--vscode-descriptionForeground)">ยังไม่มี token</p>
	{:else}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="overflow-x-auto rounded-md border border-(--vscode-panel-border)" role="region" aria-labelledby="tokens-caption" tabindex="0">
			<table class="w-full min-w-[760px] border-collapse text-left text-sm">
				<caption id="tokens-caption" class="sr-only">Token {data.tokens.length} รายการ</caption>
				<thead class="bg-(--vscode-sideBar-background) text-(--vscode-descriptionForeground)">
					<tr>
						<th scope="col" class="px-3 py-2 font-medium">ชื่อ</th>
						{#if data.all}<th scope="col" class="px-3 py-2 font-medium">ของ</th>{/if}
						<th scope="col" class="px-3 py-2 font-medium">Prefix</th>
						<th scope="col" class="px-3 py-2 font-medium">สถานะ</th>
						<th scope="col" class="px-3 py-2 font-medium">ใช้ล่าสุด</th>
						<th scope="col" class="px-3 py-2 font-medium">หมดอายุ</th>
						<th scope="col" class="px-3 py-2 font-medium"><span class="sr-only">จัดการ</span></th>
					</tr>
				</thead>
				<tbody>
					{#each data.tokens as t (t.id)}
						{@const state = tokenState(t)}
						<tr class={['border-t border-(--vscode-panel-border) hover:bg-(--vscode-list-hoverBackground)', state !== 'active' && 'text-(--vscode-disabledForeground)']}>
							<th scope="row" class="max-w-[240px] truncate px-3 py-2 font-normal" title={t.name}>
								{t.name || '—'}{#if t.current}<span class="ml-1 rounded-full bg-(--vscode-badge-background) px-1.5 text-xs text-(--vscode-badge-foreground)">กำลังใช้</span>{/if}
							</th>
							{#if data.all}<td class="px-3 py-2">{t.user_id}</td>{/if}
							<td class="px-3 py-2 font-mono text-xs">{t.prefix}…</td>
							<td class="px-3 py-2">{TOKEN_STATE_LABEL[state]}</td>
							<td class="px-3 py-2 whitespace-nowrap">{#if t.last_used_at}<time datetime={t.last_used_at}>{timeAgo(t.last_used_at)}</time>{:else}ยังไม่เคยใช้{/if}</td>
							<td class="px-3 py-2 whitespace-nowrap">{t.expires_at ? date(t.expires_at) : 'ไม่หมดอายุ'}</td>
							<td class="px-3 py-2 text-right">
								{#if state === 'active'}
									<form
										method="POST"
										action="?/revoke"
										use:enhance
										onsubmit={(e) => {
											const msg = t.current ? 'เพิกถอน token ที่ใช้อยู่ตอนนี้? คุณจะออกจากระบบทันที' : `เพิกถอน ${t.prefix}…? เครื่องที่ใช้ token นี้จะเชื่อมต่อไม่ได้ทันที`;
											if (!confirm(msg)) e.preventDefault();
										}}
									>
										<input type="hidden" name="id" value={t.id} />
										<button type="submit" class={button}>เพิกถอน</button>
									</form>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
	<Pager next={data.nextCursor} paged={data.paged} />
</main>
