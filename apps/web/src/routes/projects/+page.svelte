<script lang="ts">
	import { enhance } from '$app/forms';
	import { timeAgo } from '#lib/board.ts';
	import { isAdmin } from '#lib/admin.ts';
	import Pager from '#lib/Pager.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const admin = $derived(isAdmin(data.me?.role));
	const owner = $derived(data.me?.role === 'owner');
	type Draft = { name: string; repo_url: string; default_base_ref: string };
	const draft = $derived((form && 'draft' in form ? form.draft : null) as Draft | null);
	const input =
		'h-8 rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 text-(--vscode-input-foreground) placeholder:text-(--vscode-input-placeholderForeground)';
	const button = 'rounded-sm border border-(--vscode-widget-border) px-2 py-0.5 hover:bg-(--vscode-toolbar-hoverBackground)';
	const primary = 'h-8 rounded-sm bg-(--vscode-button-background) px-3 text-(--vscode-button-foreground) hover:brightness-110';
	const label = 'text-xs text-(--vscode-descriptionForeground)';
</script>

<svelte:head><title>โปรเจกต์ — Kingu</title></svelte:head>

<main class="mx-auto max-w-7xl px-4 py-4">
	<h1 class="mb-1 text-lg font-semibold text-(--vscode-tab-activeForeground)">โปรเจกต์</h1>
	<p class="mb-4 text-(--vscode-descriptionForeground)">
		โปรเจกต์คือที่ที่แอป Kingu ซิงก์งานเข้ามา (เลือกใน Settings › Team ของแอป) owner และ lead สร้างและแก้ได้ เฉพาะ owner ที่ลบได้
	</p>

	{#if form?.error}<p role="alert" class="mb-3 text-(--vscode-errorForeground)">{form.error}</p>{/if}
	{#if form?.created}<p role="status" class="mb-3">สร้างโปรเจกต์ {form.created} แล้ว</p>{/if}
	{#if form?.updated}<p role="status" class="mb-3">บันทึก {form.updated} แล้ว</p>{/if}
	{#if form?.deleted}<p role="status" class="mb-3">ลบ {form.deleted} และงาน {form.tasks} งานแล้ว</p>{/if}

	{#if admin}
		<form method="POST" action="?/create" use:enhance class="mb-4 flex flex-wrap items-end gap-2 rounded-md border border-(--vscode-panel-border) bg-(--vscode-sideBar-background) p-3">
			<div class="flex flex-col gap-1">
				<label for="p-name" class={label}>ชื่อ</label>
				<input id="p-name" name="name" required maxlength="200" value={draft?.name ?? ''} class={input} />
			</div>
			<div class="flex min-w-0 flex-1 flex-col gap-1">
				<label for="p-repo" class={label}>Repo URL</label>
				<input id="p-repo" name="repo_url" required maxlength="2048" spellcheck="false" placeholder="https://github.com/org/repo.git" value={draft?.repo_url ?? ''} class={[input, 'min-w-[16rem] font-mono']} />
			</div>
			<div class="flex flex-col gap-1">
				<label for="p-base" class={label}>Base branch</label>
				<input id="p-base" name="default_base_ref" maxlength="255" spellcheck="false" placeholder="main" value={draft?.default_base_ref ?? ''} class={[input, 'w-32 font-mono']} />
			</div>
			<button type="submit" class={primary}>สร้างโปรเจกต์</button>
		</form>
	{/if}

	{#if data.projects.length === 0}
		<p class="text-(--vscode-descriptionForeground)">ยังไม่มีโปรเจกต์</p>
	{:else}
		<ul class="flex flex-col gap-2">
			{#each data.projects as p (p.id)}
				<li class="rounded-md border border-(--vscode-panel-border) p-3">
					<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
						<h2 class="font-medium text-(--vscode-tab-activeForeground)"><a href={`/?project=${p.id}`} class="no-underline hover:underline">{p.name}</a></h2>
						<span class="min-w-0 truncate font-mono text-xs text-(--vscode-descriptionForeground)" title={p.repo_url}>{p.repo_url} · {p.default_base_ref}</span>
						<span class="ml-auto text-(--vscode-descriptionForeground)">{p.task_count} งาน · สร้าง {timeAgo(p.created_at)}</span>
					</div>
					{#if admin}
						<details class="mt-2">
							<summary class="cursor-pointer text-(--vscode-textLink-foreground)">แก้ไข{owner ? ' / ลบ' : ''}</summary>
							<form method="POST" action="?/update" use:enhance class="mt-2 flex flex-wrap items-end gap-2">
								<input type="hidden" name="id" value={p.id} />
								<div class="flex flex-col gap-1">
									<label for={`n-${p.id}`} class={label}>ชื่อ</label>
									<input id={`n-${p.id}`} name="name" required maxlength="200" value={p.name} class={input} />
								</div>
								<div class="flex min-w-0 flex-1 flex-col gap-1">
									<label for={`r-${p.id}`} class={label}>Repo URL</label>
									<input id={`r-${p.id}`} name="repo_url" required maxlength="2048" spellcheck="false" value={p.repo_url} class={[input, 'min-w-[16rem] font-mono']} />
								</div>
								<div class="flex flex-col gap-1">
									<label for={`b-${p.id}`} class={label}>Base branch</label>
									<input id={`b-${p.id}`} name="default_base_ref" maxlength="255" spellcheck="false" value={p.default_base_ref} class={[input, 'w-32 font-mono']} />
								</div>
								<button type="submit" class={button}>บันทึก</button>
							</form>
							{#if owner}
								<form method="POST" action="?/delete" use:enhance class="mt-3 flex flex-wrap items-end gap-2 border-t border-(--vscode-panel-border) pt-3">
									<input type="hidden" name="id" value={p.id} />
									<input type="hidden" name="name" value={p.name} />
									<div class="flex flex-col gap-1">
										<label for={`c-${p.id}`} class={label}>ลบถาวรพร้อมงาน {p.task_count} งานและประวัติการรัน พิมพ์ “{p.name}” เพื่อยืนยัน</label>
										<input id={`c-${p.id}`} name="confirm" required autocomplete="off" class={input} />
									</div>
									<button type="submit" class="rounded-sm border border-(--vscode-errorForeground) px-2 py-0.5 text-(--vscode-errorForeground) hover:bg-(--vscode-toolbar-hoverBackground)">ลบโปรเจกต์</button>
								</form>
							{/if}
						</details>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	<Pager next={data.nextCursor} paged={data.paged} />
</main>
