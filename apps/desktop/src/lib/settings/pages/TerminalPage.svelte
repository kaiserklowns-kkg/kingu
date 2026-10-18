<script lang="ts">
	// Settings › Terminal (Orca's Terminal pane + VS Code's terminal.integrated.*).
	import Icon from '#lib/workbench/Icon.svelte';
	import { floating } from '#lib/workbench/floating.svelte.ts';
	import { settings } from '../settings.svelte';
	import { systemSettings } from '../systemSettings.svelte';
	import Stepper from './Stepper.svelte';

	const family = $derived(settings.get<string>('terminal.integrated.fontFamily') ?? '');
	const setFamily = (v: string) => void settings.set('terminal.integrated.fontFamily', v.trim() || undefined, 'user');
	const SECTION = 'mt-7 mb-2 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase';
	const CARD = 'divide-y divide-(--vscode-widget-border) rounded-xl border border-(--vscode-widget-border)';
</script>

<div class="h-full overflow-y-auto">
	<div class="mx-auto max-w-[880px] px-8 py-6">
		<h1 class="flex items-center gap-2 text-lg font-semibold"><Icon name="terminal" size={20} />Terminal</h1>
		<p class="mt-1 text-[13px] text-(--vscode-descriptionForeground)">terminal ใน panel ล่าง, ใน worktree ของงาน และ floating terminal ใช้ค่าเดียวกัน</p>

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

		<h2 class={SECTION}>Floating terminal</h2>
		<div class="{CARD} flex items-center gap-3 px-4 py-3">
			<div class="min-w-0 flex-1">
				<div class="text-[13px]">terminal ลอยเหนือทุกหน้า ใช้ได้ทั้ง IDE และ Agents</div>
				<div class="text-xs text-(--vscode-descriptionForeground)">⌥⌘T · ซ่อนแล้ว shell ยังทำงานต่อ</div>
			</div>
			<button class="h-8 rounded-md bg-(--vscode-button-background) px-3.5 text-[13px] text-(--vscode-button-foreground) hover:opacity-90" onclick={() => (systemSettings.close(), floating.toggle())}>
				{floating.visible ? 'ซ่อน' : 'เปิด'} floating terminal
			</button>
		</div>
	</div>
</div>
