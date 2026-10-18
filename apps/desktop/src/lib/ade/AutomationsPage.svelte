<script lang="ts">
	// Automations page (Agents layout center, from the side bar): each automation with its switch,
	// next and last run (a link to the task it created), Run now, Edit and Delete; the editor form
	// on top while open.
	import Icon from '#lib/workbench/Icon.svelte';
	import AutomationForm from './AutomationForm.svelte';
	import { automations } from './automations.svelte.ts';
	import { formatWhen } from './automations.ts';
	import { parseSchedule } from './schedule.ts';
	import { adeLayout } from './adeLayout.svelte.ts';
	import { adeTasks } from './tasks.svelte.ts';
	import { BUTTON, BUTTON_SECONDARY, ICON_BUTTON } from './ui.ts';

	function openTask(slug: string) {
		adeLayout.show(slug);
	}

	/** A declined confirm leaves the switch as it was. */
	async function toggle(id: string, box: HTMLInputElement) {
		await automations.setEnabled(id, box.checked);
		const a = automations.find(id);
		box.checked = !!a && automations.isActive(a);
	}
</script>

<div class="flex h-full flex-col overflow-hidden bg-(--vscode-editor-background) text-(--vscode-foreground)">
	<header class="flex shrink-0 items-center gap-2 border-b border-(--vscode-widget-border) px-4 py-2">
		<h1 class="text-sm font-semibold">Automations</h1>
		<span class="text-xs text-(--vscode-descriptionForeground)">{automations.list.length} รายการ · รันเฉพาะตอน Kingu เปิดอยู่</span>
		<span class="flex-1"></span>
		{#if automations.globalEnabled}
			<button class={BUTTON_SECONDARY} disabled={!automations.activeCount} onclick={() => automations.pauseAll()}><Icon name="stop" size={13} /> หยุดทั้งหมด</button>
		{/if}
		<button class={BUTTON} onclick={() => (automations.editing = { id: null })}><Icon name="plus" size={14} /> ใหม่</button>
		<button class={ICON_BUTTON} aria-label="รีเฟรช" title="รีเฟรช" onclick={() => automations.load()}><Icon name="refresh" size={16} /></button>
	</header>

	<div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
		{#if !automations.globalEnabled}
			<div class="flex items-center gap-2 rounded border border-(--vscode-editorWarning-foreground) px-3 py-2 text-xs" role="status">
				<span class="flex-1">Automations ทั้งหมดถูกหยุดอยู่ (kingu.automations.enabled) — จะไม่มีอันไหนเริ่มเอง</span>
				<button class={BUTTON_SECONDARY} onclick={() => automations.resumeAll()}>เปิดใช้อีกครั้ง</button>
			</div>
		{/if}

		{#if automations.editing}
			{#key automations.editing.id}<div class="max-w-2xl"><AutomationForm id={automations.editing.id} /></div>{/key}
		{/if}

		{#if !automations.loaded}
			<p class="text-xs text-(--vscode-descriptionForeground)">กำลังโหลด…</p>
		{:else if !automations.list.length && !automations.editing}
			<div class="max-w-md space-y-2 text-xs text-(--vscode-descriptionForeground)">
				<p>Automation เริ่มงานให้ agent ตามเวลาที่ตั้งไว้ เช่น ตรวจ dependency ทุกเช้าวันจันทร์ — ทุกรอบได้ worktree <span class="font-mono">kingu/…</span> ของตัวเอง</p>
				<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => (automations.editing = { id: null })}>สร้าง automation แรก…</button>
			</div>
		{:else}
			<ul class="space-y-2" aria-label="รายการ automation">
				{#each automations.list as a (a.id)}
					{@const active = automations.isActive(a)}
					{@const needsConfirm = a.enabled && !automations.consented(a)}
					{@const next = automations.nextRun(a)}
					{@const sched = parseSchedule(a.schedule)}
					{@const lastTask = a.last_task_slug ? adeTasks.find(a.last_task_slug) : undefined}
					<li class="flex items-start gap-3 rounded border border-(--vscode-widget-border) px-3 py-2 text-xs">
						<label class="mt-0.5 flex shrink-0 items-center" title={active ? 'ปิด' : 'เปิด'}>
							<span class="sr-only">เปิดใช้ {a.name}</span>
							<input type="checkbox" role="switch" checked={active} disabled={!sched.ok} onchange={(e) => toggle(a.id, e.currentTarget)} />
						</label>
						<div class="min-w-0 flex-1 space-y-0.5">
							<div class="flex items-center gap-2">
								<span class="truncate text-[13px] font-medium" title={a.name}>{a.name}</span>
								<span class="shrink-0 font-mono text-(--vscode-descriptionForeground)">{a.schedule}</span>
							</div>
							<p class="truncate text-(--vscode-descriptionForeground)" title={a.prompt}>{a.prompt}</p>
							<p class="text-(--vscode-descriptionForeground)">
								รอบถัดไป: {active && automations.globalEnabled ? formatWhen(next, automations.now) : 'ปิดอยู่'}
								· ล่าสุด:
								{#if a.last_run_at}
									{formatWhen(a.last_run_at, automations.now)}
									{#if a.last_task_slug}
										{#if lastTask}
											<button class="font-mono text-(--vscode-textLink-foreground) hover:underline" onclick={() => openTask(a.last_task_slug!)}>kingu/{a.last_task_slug}</button>
										{:else}
											<span class="font-mono">kingu/{a.last_task_slug}</span> (ลบแล้ว)
										{/if}
									{/if}
								{:else}
									ยังไม่เคยรัน
								{/if}
							</p>
							{#if !sched.ok}
								<p class="text-(--vscode-errorForeground)">ตารางเวลาไม่ถูกต้อง: {sched.error}</p>
							{:else if needsConfirm}
								<p class="text-(--vscode-editorWarning-foreground)">เปิดอยู่ในไฟล์แต่ยังไม่ได้ยืนยันในเครื่องนี้ — จะไม่รันจนกว่าจะเปิดใช้เอง</p>
							{/if}
							{#if a.last_skip}
								<p class="text-(--vscode-editorWarning-foreground)">ข้ามรอบ {formatWhen(a.last_skip.at, automations.now)}: {a.last_skip.reason}</p>
							{/if}
						</div>
						<div class="flex shrink-0 items-center gap-1">
							<button class={BUTTON_SECONDARY} title="เริ่มงานรอบใหม่ตอนนี้" onclick={() => automations.runNow(a.id)}><Icon name="play" size={12} /> Run now</button>
							<button class={BUTTON_SECONDARY} onclick={() => (automations.editing = { id: a.id })}>Edit</button>
							<button class={ICON_BUTTON} aria-label="ลบ {a.name}" title="ลบ" onclick={() => automations.remove(a.id)}><Icon name="trash" size={14} /></button>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
