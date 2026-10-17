<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import Editor from '#lib/editor/Editor.svelte';
	import Terminal from '#lib/terminal/Terminal.svelte';

	type AppInfo = { name: string; version: string; os: string; arch: string; workspace: string };

	// Phase 0 spike: a fixed list until the Rust file tree lands.
	const files = [
		'apps/desktop/src-tauri/src/lib.rs',
		'apps/desktop/src-tauri/src/pty.rs',
		'apps/desktop/src/routes/+page.svelte',
		'apps/server/cmd/api/main.go',
		'package.json',
		'README.md'
	];

	let info = $state<AppInfo | null>(null);
	let active = $state(files[0]);
	let content = $state('');
	let error = $state('');

	$effect(() => {
		invoke<AppInfo>('app_info').then((v) => (info = v));
	});

	$effect(() => {
		const path = active;
		invoke<string>('read_workspace_file', { rel: path })
			.then((text) => {
				content = text;
				error = '';
			})
			.catch((e) => (error = String(e)));
	});
</script>

<div class="flex h-screen flex-col bg-neutral-950 text-sm text-neutral-200">
	<header class="flex h-9 shrink-0 items-center gap-3 border-b border-neutral-800 px-3">
		<span class="font-semibold">Kingu</span>
		<span class="truncate text-neutral-400">{info?.workspace ?? ''}</span>
	</header>

	<div class="flex min-h-0 flex-1">
		<nav aria-label="ไฟล์" class="w-64 shrink-0 overflow-y-auto border-r border-neutral-800 py-2">
			{#each files as f (f)}
				<button
					class={[
						'block w-full truncate px-3 py-1 text-left font-mono text-xs',
						f === active ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:bg-neutral-900'
					]}
					aria-current={f === active}
					onclick={() => (active = f)}>{f}</button
				>
			{/each}
		</nav>

		<main class="flex min-w-0 flex-1 flex-col">
			<div class="h-8 shrink-0 border-b border-neutral-800 px-3 leading-8 text-neutral-400">
				{active}
				{#if error}<span class="ml-2 text-red-400">{error}</span>{/if}
			</div>
			<div class="min-h-0 flex-1">
				<Editor path={active} value={content} />
			</div>
			<section aria-label="Terminal" class="h-64 shrink-0 border-t border-neutral-800 bg-neutral-950">
				<Terminal />
			</section>
		</main>
	</div>
</div>
