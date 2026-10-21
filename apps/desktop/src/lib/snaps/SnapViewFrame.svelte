<script lang="ts">
	// A snap's view (phase 3): its page in `<iframe sandbox="allow-scripts">` served by Rust under the
	// `kingu-snap-view:` scheme with a strict CSP and no Tauri IPC (src-tauri/src/snap_view.rs). The page
	// talks to the app only by postMessage; viewBridge.ts answers what its manifest entry allows.
	import { invoke } from '@tauri-apps/api/core';
	import { onDestroy } from 'svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { theme } from '#lib/theme/theme.svelte.ts';
	import { isDarkType } from '#lib/theme/themes.ts';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import type { ContributedView } from './contributions.ts';
	import { settingId } from './snapModel.ts';
	import { themeMessage, ViewBridge } from './viewBridge.ts';
	import { snaps } from './snaps.svelte.ts';

	let { entry }: { entry: ContributedView } = $props();

	let frame = $state<HTMLIFrameElement | null>(null);
	let url = $state<string | null>(null);
	let error = $state<string | null>(null);
	let token: string | null = null;
	const kind = $derived(isDarkType(theme.current.type) ? 'dark' : 'light');

	const bridge = $derived(
		new ViewBridge(entry.snap.id, entry.view, {
			setting: (key) => {
				const st = entry.snap.settings.find((s) => s.key === key);
				return settings.get(settingId(entry.snap.id, key)) ?? st?.default;
			},
			runTask: (task) => snaps.runTask(entry.snap.id, task),
			notify: (severity, message) => notifications.notify({ severity, message, source: `${entry.snap.name}: ${entry.view.name}` }),
			theme: () => kind,
			now: () => Date.now()
		})
	);

	async function close() {
		if (token) await invoke('snap_view_close', { token }).catch(() => {});
		token = null;
	}

	// Opens the page again when the view (or the snap's listed page) changes.
	const viewKey = $derived(`${entry.key}\u0000${entry.snap.hash}`);
	$effect(() => {
		void viewKey;
		let stale = false;
		url = null;
		error = null;
		void close().then(() =>
			invoke<{ url: string; token: string }>('snap_view_open', { source: entry.snap.source, id: entry.snap.id, view: entry.view.id }).then(
				(r) => {
					if (stale) return void invoke('snap_view_close', { token: r.token }).catch(() => {});
					token = r.token;
					url = r.url;
				},
				(e) => !stale && (error = String(e))
			)
		);
		return () => (stale = true);
	});

	function onMessage(e: MessageEvent) {
		// Only this frame's page, never another window or frame.
		if (!frame || e.source !== frame.contentWindow) return;
		const reply = bridge.handle(e.data);
		if (reply) frame.contentWindow?.postMessage(reply, '*');
	}

	$effect(() => {
		const k = kind;
		frame?.contentWindow?.postMessage(themeMessage(k), '*');
	});

	onDestroy(() => void close());
</script>

<svelte:window onmessage={onMessage} />

<div class="relative flex min-h-0 flex-1 flex-col">
	{#if error}
		<p role="alert" class="px-3 py-2 text-xs text-(--vscode-errorForeground)">{t('snapContrib.view.failed', { error })}</p>
	{:else if !url}
		<p class="px-3 py-2 text-xs text-(--vscode-descriptionForeground)">{t('snapContrib.view.loading')}</p>
	{:else}
		<iframe
			bind:this={frame}
			title={`${entry.snap.name}: ${entry.view.name}`}
			src={url}
			sandbox="allow-scripts"
			referrerpolicy="no-referrer"
			class="min-h-0 w-full flex-1 border-0 bg-transparent"
			onload={() => frame?.contentWindow?.postMessage(themeMessage(kind), '*')}
		></iframe>
	{/if}
</div>
