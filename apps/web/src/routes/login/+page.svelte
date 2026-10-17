<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
	let busy = $state(false);
</script>

<svelte:head><title>เข้าสู่ระบบ — Kingu ทีม</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
	<h1 class="mb-1 text-xl font-semibold text-(--vscode-tab-activeForeground)">Kingu ทีม</h1>
	<p class="mb-6 text-(--vscode-descriptionForeground)">ดูงานของทีมแบบเรียลไทม์ (เฉพาะ metadata ไม่มีโค้ด)</p>

	<form
		method="POST"
		class="flex flex-col gap-3 rounded-md border border-(--vscode-widget-border) bg-(--vscode-sideBar-background) p-4"
		use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				await update();
				busy = false;
			};
		}}
	>
		<label for="token" class="font-medium">Personal access token</label>
		<input
			id="token"
			name="token"
			type="password"
			required
			autocomplete="off"
			spellcheck="false"
			placeholder="kgu_…"
			aria-describedby={form?.error ? 'token-hint token-error' : 'token-hint'}
			aria-invalid={form?.error ? 'true' : undefined}
			class="h-9 rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 font-mono text-(--vscode-input-foreground) placeholder:text-(--vscode-input-placeholderForeground)"
		/>
		<p id="token-hint" class="text-xs text-(--vscode-descriptionForeground)">
			วาง token ที่ได้จากผู้ดูแลเซิร์ฟเวอร์ทีม Token ถูกเก็บในคุกกี้ httpOnly ฝั่งเซิร์ฟเวอร์เท่านั้น JavaScript ในเบราว์เซอร์อ่านไม่ได้
		</p>
		{#if form?.error}
			<p id="token-error" role="alert" class="text-(--vscode-errorForeground)">{form.error}</p>
		{/if}
		<button
			type="submit"
			disabled={busy}
			class="h-9 rounded-sm bg-(--vscode-button-background) px-4 font-medium text-(--vscode-button-foreground) hover:brightness-110 disabled:opacity-60"
			>{busy ? 'กำลังตรวจสอบ…' : 'เข้าสู่ระบบ'}</button
		>
	</form>
</main>
