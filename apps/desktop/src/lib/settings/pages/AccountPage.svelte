<script lang="ts">
	// Settings › Account & Team (Orca's Accounts pane): the team server, sign-in and sync health.
	import Icon from '#lib/workbench/Icon.svelte';
	import { team } from '#lib/team/team.svelte.ts';
	import { settings } from '../settings.svelte';

	$effect(() => void team.refresh());

	const s = $derived(team.status);
	const set = (id: string, v: string) => void settings.set(id, v.trim() || undefined, 'user');
	const state = $derived(
		!team.serverUrl
			? { tone: 'text-(--vscode-descriptionForeground)', text: 'ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์ทีม' }
			: !s
				? { tone: 'text-(--vscode-descriptionForeground)', text: 'กำลังตรวจสอบ…' }
				: !s.signed_in
					? { tone: 'text-(--vscode-editorWarning-foreground)', text: 'ยังไม่ได้ลงชื่อเข้าใช้' }
					: s.online === false
						? { tone: 'text-(--vscode-editorWarning-foreground)', text: 'ลงชื่อเข้าใช้แล้ว · ออฟไลน์' }
						: { tone: 'text-[#73C991]', text: 'ลงชื่อเข้าใช้แล้ว' }
	);
	const SECTION = 'mt-7 mb-2 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase';
	const INPUT = 'mt-1.5 h-8 w-full max-w-[460px] rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2.5 font-mono text-[13px] outline-none focus:border-(--vscode-focusBorder)';
	const BTN = 'h-8 rounded-md px-3.5 text-[13px] disabled:opacity-40';
</script>

<div class="h-full overflow-y-auto">
	<div class="mx-auto max-w-4xl px-8 pt-10 pb-24">
		<h1 class="flex items-center gap-2 text-2xl leading-tight font-semibold"><Icon name="account" size={20} />บัญชีและทีม</h1>
		<p class="mt-2 max-w-3xl text-sm leading-6 text-(--vscode-descriptionForeground)">ซิงก์เฉพาะ metadata ของงานไปที่เซิร์ฟเวอร์ทีม ไม่ส่งโค้ดหรือความลับ token เก็บใน Keychain เท่านั้น</p>

		<h2 class={SECTION}>สถานะ</h2>
		<div class="flex items-center gap-4 rounded-xl border border-(--vscode-widget-border) px-4 py-3.5">
			<span class={['size-2.5 rounded-full bg-current', state.tone]}></span>
			<div class="min-w-0 flex-1">
				<div class={['text-[13px] font-medium', state.tone]}>{state.text}</div>
				<div class="truncate text-xs text-(--vscode-descriptionForeground)">
					{team.serverUrl || '—'}{s?.pending ? ` · รอส่ง ${s.pending} รายการ` : ''}{s?.last_error ? ` · ${s.last_error}` : ''}
				</div>
			</div>
			<button class="{BTN} hover:bg-(--vscode-toolbar-hoverBackground)" disabled={!team.serverUrl} onclick={() => team.refresh()}>ตรวจใหม่</button>
			{#if s?.signed_in}
				<button class="{BTN} border border-(--vscode-widget-border) hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => team.signOut()}>ออกจากระบบ</button>
			{:else}
				<button class="{BTN} bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:opacity-90" disabled={!team.serverUrl} onclick={() => team.startSignIn()}>ลงชื่อเข้าใช้</button>
			{/if}
		</div>

		<h2 class={SECTION}>เซิร์ฟเวอร์</h2>
		<div class="divide-y divide-(--vscode-widget-border) rounded-xl border border-(--vscode-widget-border)">
			<label class="block px-4 py-3">
				<span class="text-[13px]">URL ของเซิร์ฟเวอร์ทีม</span>
				<span class="block text-xs text-(--vscode-descriptionForeground)">ต้องเป็น HTTPS ยกเว้น http://localhost · kingu.team.serverUrl</span>
				<input class={INPUT} value={team.serverUrl} placeholder="https://team.example.com" spellcheck="false" onchange={(e) => set('kingu.team.serverUrl', e.currentTarget.value)} />
			</label>
			<label class="block px-4 py-3">
				<span class="text-[13px]">โปรเจกต์</span>
				<span class="block text-xs text-(--vscode-descriptionForeground)">งานของโฟลเดอร์นี้ซิงก์เข้าโปรเจกต์นี้ · kingu.team.project</span>
				<input class={INPUT} value={team.project} spellcheck="false" onchange={(e) => set('kingu.team.project', e.currentTarget.value)} />
			</label>
		</div>
	</div>
</div>
