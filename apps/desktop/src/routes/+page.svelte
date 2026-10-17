<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';

	type AppInfo = { name: string; version: string; os: string; arch: string };

	let info = $state<AppInfo | null>(null);
	let error = $state('');

	$effect(() => {
		invoke<AppInfo>('app_info')
			.then((v) => (info = v))
			.catch((e) => (error = String(e)));
	});
</script>

<main class="flex min-h-screen flex-col items-center justify-center gap-3 bg-neutral-950 text-neutral-100">
	<h1 class="text-2xl font-semibold">Kingu</h1>
	{#if info}
		<p class="text-sm text-neutral-400">
			{info.name} {info.version} · {info.os}/{info.arch} · Rust backend เชื่อมต่อแล้ว
		</p>
	{:else if error}
		<p class="text-sm text-red-400">เชื่อม Rust backend ไม่ได้: {error}</p>
	{:else}
		<p class="text-sm text-neutral-400">กำลังเชื่อม Rust backend…</p>
	{/if}
</main>
