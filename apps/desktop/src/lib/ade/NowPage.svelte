<script lang="ts">
	// Kingu's Agents home: unlike the workflow board, this is an outcome-first inbox. It answers
	// what needs a human decision, what is ready to review, and what is currently moving.
	import Icon from '#lib/workbench/Icon.svelte';
	import TaskCard from './TaskCard.svelte';
	import { adeLayout, PRIMARY } from './adeLayout.svelte';
	import { adeTasks } from './tasks.svelte';
	import { BUTTON, BUTTON_SECONDARY } from './ui';

	const decisions = $derived(adeTasks.groups.attention.filter((v) => v.status === 'waiting' || v.status === 'failed'));
	const review = $derived(adeTasks.groups.attention.filter((v) => v.status === 'review'));
	const working = $derived(adeTasks.groups.active);
	const complete = $derived(!decisions.length && !review.length && !working.length);

	function newTask() {
		adeTasks.composing = true;
		adeLayout.show(PRIMARY);
	}
</script>

<div class="h-full overflow-y-auto bg-(--vscode-editor-background) text-(--vscode-foreground)">
	<header class="sticky top-0 z-10 border-b border-(--vscode-widget-border) bg-(--vscode-editor-background)/95 px-5 py-4 backdrop-blur">
		<div class="mx-auto flex max-w-6xl items-center gap-3">
			<div class="grid size-9 place-items-center rounded-xl bg-(--vscode-button-background)/15 text-(--vscode-button-background)"><Icon name="agent" size={21} /></div>
			<div class="min-w-0 flex-1">
				<h1 class="text-base font-semibold">Now</h1>
				<p class="text-xs text-(--vscode-descriptionForeground)">งานที่ต้องตัดสินใจ ตรวจทาน หรือกำลังเดินอยู่ใน workspace นี้</p>
			</div>
			<button class={BUTTON_SECONDARY} onclick={() => (adeLayout.page = 'board')}><Icon name="tasks" size={14} /> Board</button>
			<button class={BUTTON} onclick={newTask}><Icon name="plus" size={14} /> งานใหม่</button>
		</div>
	</header>

	<main class="mx-auto max-w-6xl space-y-7 p-5">
		{#if complete}
			<section class="grid min-h-72 place-items-center rounded-xl border border-dashed border-(--vscode-widget-border) p-8 text-center">
				<div class="max-w-md space-y-3">
					<div class="mx-auto grid size-11 place-items-center rounded-full bg-(--vscode-button-background)/15 text-(--vscode-button-background)"><Icon name="check" size={24} /></div>
					<h2 class="font-semibold">ตอนนี้ไม่มีงานค้าง</h2>
					<p class="text-sm text-(--vscode-descriptionForeground)">เริ่มงานใหม่ให้ agent ทำใน worktree แยก หรือเปิด Board เพื่อวางแผนงานที่มีอยู่</p>
					<div class="flex justify-center gap-2"><button class={BUTTON} onclick={newTask}><Icon name="plus" size={14} /> สร้างงานใหม่</button><button class={BUTTON_SECONDARY} onclick={() => (adeLayout.page = 'board')}>เปิด Board</button></div>
				</div>
			</section>
		{/if}

		{#if decisions.length}
			<section aria-labelledby="now-decisions">
				<div class="mb-2 flex items-center gap-2"><span class="size-2 rounded-full bg-(--vscode-editorWarning-foreground)"></span><h2 id="now-decisions" class="font-semibold">ต้องการคุณ</h2><span class="rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] text-(--vscode-badge-foreground)">{decisions.length}</span></div>
				<p class="mb-3 text-xs text-(--vscode-descriptionForeground)">ตอบคำถาม อนุมัติสิทธิ์ หรือดูงานที่ต้องแก้ก่อนเดินต่อ</p>
				<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{#each decisions as view (view.meta.slug)}<TaskCard {view} />{/each}</div>
			</section>
		{/if}

		{#if review.length}
			<section aria-labelledby="now-review">
				<div class="mb-2 flex items-center gap-2"><span class="size-2 rounded-full bg-(--vscode-textLink-foreground)"></span><h2 id="now-review" class="font-semibold">พร้อมตรวจทาน</h2><span class="rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] text-(--vscode-badge-foreground)">{review.length}</span></div>
				<p class="mb-3 text-xs text-(--vscode-descriptionForeground)">เปิด diff ตรวจการเปลี่ยนแปลง แล้ว commit, ส่ง PR หรือ merge เมื่อพร้อม</p>
				<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{#each review as view (view.meta.slug)}<TaskCard {view} />{/each}</div>
			</section>
		{/if}

		{#if working.length}
			<section aria-labelledby="now-working">
				<div class="mb-2 flex items-center gap-2"><span class="size-2 animate-pulse rounded-full bg-(--vscode-editorInfo-foreground)"></span><h2 id="now-working" class="font-semibold">กำลังทำ</h2><span class="rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] text-(--vscode-badge-foreground)">{working.length}</span></div>
				<p class="mb-3 text-xs text-(--vscode-descriptionForeground)">ติดตามความคืบหน้าได้โดยไม่ต้องสลับไปดูทุก worktree</p>
				<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{#each working as view (view.meta.slug)}<TaskCard {view} />{/each}</div>
			</section>
		{/if}
	</main>
</div>
