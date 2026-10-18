<script lang="ts">
	// The welcome tour: four short steps, each with what to press. Esc or Skip closes it for good.
	import type { IconName } from './Icon.svelte';
	import Icon from './Icon.svelte';
	import KinguMark from './KinguMark.svelte';
	import { commands } from './commands.svelte';
	import { welcome } from './welcomeTour.svelte';

	type Step = { icon: IconName | 'kingu'; title: string; body: string; keys: [string, string][] };
	const STEPS: Step[] = [
		{
			icon: 'kingu',
			title: 'ยินดีต้อนรับสู่ Kingu Studio',
			body: 'IDE และ ADE ในหน้าต่างเดียว: เขียนโค้ดเอง หรือส่งงานให้ Arkai ทำใน worktree ของตัวเอง โดยไม่ชนกับงานที่คุณทำอยู่',
			keys: [['เปิดโฟลเดอร์', '⌘O']]
		},
		{
			icon: 'agent',
			title: 'Arkai และโหมด Agents (ADE)',
			body: 'สั่งงานได้หลายงานพร้อมกัน แต่ละงานได้ branch และ worktree แยก ดูความคืบหน้าบนบอร์ด รีวิว diff แล้ว commit หรือ merge ได้ในที่เดียว',
			keys: [
				['สลับ IDE / Agents', '⇧⌘A'],
				['แผง Arkai', '⌥⌘B']
			]
		},
		{
			icon: 'search',
			title: 'ทำทุกอย่างได้จากคีย์บอร์ด',
			body: 'ค้นหาไฟล์และคำสั่งได้ทันที เปิด preview ของ Markdown/CSV และเข้า Zen Mode เพื่อโฟกัสกับโค้ด',
			keys: [
				['คำสั่งทั้งหมด', '⇧⌘P'],
				['ไปที่ไฟล์', '⌘P'],
				['Zen Mode', '⌘K Z']
			]
		},
		{
			icon: 'settings',
			title: 'ปรับให้เข้ากับคุณ',
			body: 'เลือกธีม (รวมถึง 2026 Dark/Light) กันเครื่องหลับขณะ agent ทำงาน (☕ ที่ status bar) และเปิด/ปิดเสียงแจ้งเหตุการณ์ได้ใน Settings',
			keys: [
				['Settings', '⌘,'],
				['Floating terminal', '⌥⌘T']
			]
		}
	];

	let step = $state(0);
	const s = $derived(STEPS[step]);
	const last = $derived(step === STEPS.length - 1);

	function run(command: string) {
		welcome.close();
		void commands.run(command);
	}
	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') welcome.close();
		else if (e.key === 'ArrowRight' && !last) step++;
		else if (e.key === 'ArrowLeft' && step > 0) step--;
		else return;
		e.preventDefault();
		e.stopPropagation();
	}
</script>

<svelte:window onkeydowncapture={onkeydown} />

<div class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-6" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && welcome.close()}>
	<div role="dialog" aria-modal="true" aria-labelledby="kg-welcome-title" class="w-full max-w-[520px] overflow-hidden rounded-2xl border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) text-(--vscode-foreground) shadow-2xl shadow-black/50">
		<div class="flex flex-col items-center gap-3 px-8 pt-8 pb-5 text-center">
			<span class="text-(--vscode-foreground)">
				{#if s.icon === 'kingu'}<KinguMark size={52} />{:else}<Icon name={s.icon} size={44} />{/if}
			</span>
			<h2 id="kg-welcome-title" class="text-lg font-semibold">{s.title}</h2>
			<p class="text-[13px] leading-relaxed text-(--vscode-descriptionForeground)">{s.body}</p>
			<div class="mt-1 flex flex-wrap justify-center gap-2">
				{#each s.keys as [label, key] (label)}
					<span class="flex items-center gap-2 rounded-lg border border-(--vscode-widget-border) px-2.5 py-1 text-xs">
						<span class="text-(--vscode-descriptionForeground)">{label}</span>
						<kbd class="font-mono">{key}</kbd>
					</span>
				{/each}
			</div>
		</div>
		<div class="flex items-center gap-2 border-t border-(--vscode-widget-border) px-5 py-3">
			<div class="flex flex-1 gap-1.5" aria-label="ขั้นที่ {step + 1} จาก {STEPS.length}">
				{#each STEPS as _, i (i)}
					<button class={['h-1.5 rounded-full transition-all', i === step ? 'w-5 bg-(--vscode-button-background)' : 'w-1.5 bg-(--vscode-widget-border)']} aria-label="ขั้นที่ {i + 1}" onclick={() => (step = i)}></button>
				{/each}
			</div>
			<button class="rounded-md px-3 py-1.5 text-[13px] text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => welcome.close()}>ข้าม</button>
			{#if step > 0}
				<button class="rounded-md px-3 py-1.5 text-[13px] hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => step--}>ย้อนกลับ</button>
			{/if}
			{#if last}
				<button class="rounded-md bg-(--vscode-button-background) px-3 py-1.5 text-[13px] text-(--vscode-button-foreground) hover:opacity-90" onclick={() => run('workbench.action.files.openFolder')}>เปิดโฟลเดอร์และเริ่มเลย</button>
			{:else}
				<!-- svelte-ignore a11y_autofocus -->
				<button autofocus class="rounded-md bg-(--vscode-button-background) px-3 py-1.5 text-[13px] text-(--vscode-button-foreground) hover:opacity-90" onclick={() => step++}>ถัดไป</button>
			{/if}
		</div>
	</div>
</div>
