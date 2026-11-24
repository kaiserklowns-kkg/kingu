<script lang="ts">
	import type { MintedToken } from './admin.ts';

	let { minted, who }: { minted: MintedToken; who: string } = $props();
	let copied = $state(false);

	async function copy() {
		try {
			await navigator.clipboard.writeText(minted.token);
			copied = true;
		} catch {
			copied = false;
		}
	}
</script>

<div role="status" class="mb-4 rounded-md border border-(--vscode-focusBorder) bg-(--vscode-sideBar-background) p-3">
	<p class="mb-2 font-medium text-(--vscode-tab-activeForeground)">
		Token ใหม่ของ {who} ({minted.prefix}{minted.expires_at ? ` · หมดอายุ ${new Date(minted.expires_at).toLocaleDateString('th-TH')}` : ' · ไม่หมดอายุ'})
	</p>
	<div class="flex flex-wrap items-center gap-2">
		<input
			readonly
			value={minted.token}
			aria-label="Token ใหม่"
			spellcheck="false"
			class="h-8 min-w-0 flex-1 rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 font-mono text-xs text-(--vscode-input-foreground)"
			onfocus={(e) => e.currentTarget.select()}
		/>
		<button type="button" onclick={copy} class="h-8 rounded-sm bg-(--vscode-button-background) px-3 text-(--vscode-button-foreground) hover:brightness-110"
			>{copied ? 'คัดลอกแล้ว' : 'คัดลอก'}</button
		>
	</div>
	<p class="mt-2 text-xs text-(--vscode-descriptionForeground)">แสดงครั้งเดียวเท่านั้น เซิร์ฟเวอร์เก็บแค่ค่า hash ปิดหน้านี้แล้วจะดูอีกไม่ได้</p>
</div>
