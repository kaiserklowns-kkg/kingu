<script lang="ts">
	// Settings › Terminal (Orca's Terminal pane + VS Code's terminal.integrated.*).
	import Icon from '#lib/workbench/Icon.svelte';
	import { floating } from '#lib/workbench/floating.svelte.ts';
	import { settings } from '../settings.svelte';
	import { systemSettings } from '../systemSettings.svelte';
	import Stepper from './Stepper.svelte';
	import Switch from './Switch.svelte';
	import SettingChoice from './SettingChoice.svelte';

	const family = $derived(settings.get<string>('terminal.integrated.fontFamily') ?? '');
	const setFamily = (v: string) => void settings.set('terminal.integrated.fontFamily', v.trim() || undefined, 'user');
	const SECTION = 'mt-7 mb-2 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase';
	const CARD = 'divide-y divide-(--vscode-widget-border) rounded-xl border border-(--vscode-widget-border)';
</script>

<div class="h-full overflow-y-auto">
	<div class="mx-auto max-w-4xl px-8 pt-10 pb-24">
		<h1 class="flex items-center gap-2 text-2xl leading-tight font-semibold"><Icon name="terminal" size={20} />Terminal</h1>
		<p class="mt-2 max-w-3xl text-sm leading-6 text-(--vscode-descriptionForeground)">terminal ใน panel ล่าง, ใน worktree ของงาน และ floating terminal ใช้ค่าเดียวกัน</p>

		<h2 class={SECTION}>ตัวอักษร</h2>
		<div class={CARD}>
			<Stepper id="terminal.integrated.fontSize" label="ขนาดตัวอักษร" hint="terminal.integrated.fontSize" />
			<label class="block px-4 py-3">
				<span class="text-[13px]">ฟอนต์</span>
				<span class="block text-xs text-(--vscode-descriptionForeground)">เว้นว่างเพื่อใช้ฟอนต์ของ editor · terminal.integrated.fontFamily</span>
				<input
					class="mt-1.5 h-8 w-full max-w-[420px] rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2.5 font-mono text-[13px] outline-none focus:border-(--vscode-focusBorder)"
					value={family}
					placeholder="(ฟอนต์ของ editor)"
					spellcheck="false"
					onchange={(e) => setFamily(e.currentTarget.value)}
				/>
			</label>
		</div>

		<h2 class={SECTION}>Floating Workspace</h2>
		<p class="mb-2 text-xs text-(--vscode-descriptionForeground)">terminal และ markdown note ลอยเหนือทุกหน้า ใช้ได้ทั้ง IDE และ Agents · ⌥⌘A · ย่อแล้ว shell ยังทำงานต่อ</p>
		<div class={CARD}>
			<Switch id="kingu.floating.enabled" label="Enable Floating Workspace" hint="แสดงปุ่มและหน้าต่าง Floating Workspace" />
			<label class="block px-4 py-3">
				<span class="text-[13px]">Terminal Directory</span>
				<span class="block text-xs text-(--vscode-descriptionForeground)">terminal ใหม่ใน Floating Workspace เริ่มที่นี่ (~ คือ home) ถ้าเปิดไม่ได้จะใช้โฟลเดอร์ของ Kingu เอง · markdown note เก็บในโฟลเดอร์ของ Kingu</span>
				<input
					class="mt-1.5 h-8 w-full max-w-[420px] rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2.5 font-mono text-[13px] outline-none focus:border-(--vscode-focusBorder)"
					value={settings.get<string>('kingu.floating.cwd') ?? '~'}
					placeholder="~"
					spellcheck="false"
					onchange={(e) => void settings.set('kingu.floating.cwd', e.currentTarget.value.trim() && e.currentTarget.value.trim() !== '~' ? e.currentTarget.value.trim() : undefined, 'user')}
				/>
			</label>
			<div class="px-4 py-3">
				<div class="text-[13px]">Toggle Button Location</div>
				<div class="mb-2 text-xs text-(--vscode-descriptionForeground)">คีย์ลัดใช้ได้เสมอไม่ว่าปุ่มจะอยู่ที่ไหน</div>
				<SettingChoice id="kingu.floating.triggerLocation" labels={{ 'floating-button': 'Floating Button', 'status-bar': 'Status Bar' }} />
			</div>
			<div class="flex items-center gap-3 px-4 py-3">
				<div class="min-w-0 flex-1 text-[13px]">{floating.open ? 'Floating Workspace เปิดอยู่' : 'Floating Workspace ซ่อนอยู่'}</div>
				<button class="h-8 rounded-md bg-(--vscode-button-background) px-3.5 text-[13px] text-(--vscode-button-foreground) hover:opacity-90 disabled:opacity-50" disabled={!floating.enabled} onclick={() => (systemSettings.close(), floating.toggle())}>
					{floating.open ? 'ย่อ' : 'เปิด'} Floating Workspace
				</button>
			</div>
		</div>
	</div>
</div>
