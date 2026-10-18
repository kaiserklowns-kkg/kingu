<script lang="ts">
	// Settings › Arkai (Orca's Agents pane): how Arkai runs tasks, asks for permission, and tells you
	// what it is doing. Every control writes the same settings the settings editor shows.
	import ArkaiMark from '#lib/workbench/ArkaiMark.svelte';
	import { settings } from '../settings.svelte';
	import { SETTINGS } from '../registry';
	import SettingChoice from './SettingChoice.svelte';

	const get = (id: string) => settings.get<string>(id) ?? '';
	const set = (id: string, v: string) => void settings.set(id, v.trim() === SETTINGS.find((s) => s.id === id)?.default ? undefined : v.trim(), 'user');
	const runMode = $derived(get('kingu.agent.runMode'));

	const SECTION = 'mt-7 mb-2 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase';
	const INPUT = 'h-8 w-full max-w-[420px] rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2.5 font-mono text-[13px] text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)';
</script>

<div class="h-full overflow-y-auto">
	<div class="mx-auto max-w-[880px] px-8 py-6">
		<div class="flex items-center gap-3">
			<span class="text-(--vscode-foreground)"><ArkaiMark size={40} /></span>
			<div>
				<h1 class="text-lg font-semibold">Arkai</h1>
				<p class="text-[13px] text-(--vscode-descriptionForeground)">ผู้ช่วย AI ของ Kingu: แต่ละงานได้ git worktree ของตัวเอง</p>
			</div>
		</div>

		<h2 class={SECTION}>วิธีรันงานใหม่</h2>
		<SettingChoice id="kingu.agent.runMode" labels={{ terminal: 'Terminal (agent CLI)', timeline: 'Timeline' }} />
		{#if runMode === 'terminal'}
			<label class="mt-3 block">
				<span class="text-[13px]">คำสั่ง agent CLI</span>
				<span class="block text-xs text-(--vscode-descriptionForeground)">เช่น claude หรือ codex — prompt จะต่อท้ายเป็นอาร์กิวเมนต์สุดท้าย</span>
				<input class="{INPUT} mt-1.5" value={get('kingu.agent.cli')} onchange={(e) => set('kingu.agent.cli', e.currentTarget.value)} spellcheck="false" />
			</label>
		{:else}
			<label class="mt-3 block">
				<span class="text-[13px]">โมเดล</span>
				<span class="block text-xs text-(--vscode-descriptionForeground)">โมเดลที่ใช้ในโหมด Timeline</span>
				<input class="{INPUT} mt-1.5" value={get('kingu.agent.model')} onchange={(e) => set('kingu.agent.model', e.currentTarget.value)} spellcheck="false" />
			</label>
		{/if}

		<h2 class={SECTION}>การขออนุญาต</h2>
		<SettingChoice id="kingu.agent.permissionMode" labels={{ default: 'ถามก่อน', acceptEdits: 'แก้ไฟล์ได้เลย', plan: 'วางแผนอย่างเดียว' }} />

		<h2 class={SECTION}>สถานะใน title bar</h2>
		<SettingChoice id="kingu.agentsControl.enabled" labels={{ hidden: 'ไม่แสดง', badge: 'ป้ายแยก', compact: 'รวมกับช่องค้นหา' }} />

		<h2 class={SECTION}>เสียงแจ้งเหตุการณ์</h2>
		<SettingChoice id="kingu.accessibility.signals" labels={{ off: 'ปิด', agents: 'เฉพาะ Arkai', all: 'Arkai และข้อผิดพลาด' }} />

		<h2 class={SECTION}>กันเครื่องหลับ</h2>
		<SettingChoice id="kingu.keepAwake" labels={{ off: 'Off', auto: 'Auto', on: 'On' }} />
	</div>
</div>
