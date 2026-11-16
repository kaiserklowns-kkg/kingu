<script lang="ts">
	// Settings › Terminal › Terminal daemon (Orca's terminalDaemon status and restart): whether the
	// background daemon that holds the terminals is connected, which generation it is, how many
	// terminals and agent sessions it holds, and a confirmed restart. The restart names the generation
	// this page just read, so it never stops a daemon the user did not see (the daemon refuses
	// otherwise, and the app says so).
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { ask } from '#lib/workbench/messageBox.ts';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { uptime, type DaemonStatusReport, type RestartReport } from './daemonGeneration';

	let report = $state<DaemonStatusReport | null>(null);
	let busy = $state(false);
	let now = $state(Date.now());

	async function refresh() {
		try {
			report = await invoke<DaemonStatusReport>('pty_daemon_status');
			now = Date.now();
		} catch (e) {
			notifications.error(t('terminalDaemon.loadFailed', { error: String(e) }));
		}
	}
	onMount(() => void refresh());

	async function restart() {
		const seen = report?.daemon;
		if (!seen || busy) return;
		const go = await ask(t('terminalDaemon.restartAsk', { terminals: report!.terminals, agents: report!.agents }), {
			title: t('terminalDaemon.restartTitle'),
			kind: 'warning',
			okLabel: t('terminalDaemon.restartOk'),
			cancelLabel: t('common.cancel')
		});
		if (!go) return;
		busy = true;
		try {
			const done = await invoke<RestartReport>('pty_daemon_restart', { epoch: seen.epoch });
			status.flash(t('terminalDaemon.restarted', { ended: done.ended }), 8000);
		} catch (e) {
			notifications.error(String(e));
		} finally {
			busy = false;
			void refresh();
		}
	}

	const rows = $derived.by(() => {
		const r = report;
		if (!r) return [];
		const out: [string, string][] = [
			[t('terminalDaemon.backend'), r.backend === 'daemon' ? t('terminalDaemon.backend.daemon') : t('terminalDaemon.backend.local')],
			[t('terminalDaemon.connection'), r.connected ? t('terminalDaemon.connected') : t('terminalDaemon.disconnected')]
		];
		if (r.daemon) {
			out.push(
				[t('terminalDaemon.pid'), `${r.daemon.pid} · v${r.daemon.appVersion}`],
				[t('terminalDaemon.generation'), r.daemon.epoch ? String(r.daemon.epoch) : '—'],
				[t('terminalDaemon.uptime'), uptime(r.daemon.startedAt, now)],
				[t('terminalDaemon.sessions'), t('terminalDaemon.sessionsValue', { alive: r.daemon.alive, total: r.daemon.sessions })],
				[t('terminalDaemon.clients'), String(r.daemon.clients)]
			);
		}
		out.push([t('terminalDaemon.agents'), String(r.agents)]);
		return out;
	});
	const BUTTON = 'h-8 rounded-md px-3.5 text-[13px] disabled:opacity-50';
</script>

<p class="mb-2 text-xs text-(--vscode-descriptionForeground)">{t('terminalDaemon.intro')}</p>
<div class="divide-y divide-(--vscode-widget-border) rounded-xl border border-(--vscode-widget-border)">
	{#each rows as [label, value] (label)}
		<div class="flex items-center gap-3 px-4 py-2.5 text-[13px]">
			<span class="w-40 shrink-0 text-(--vscode-descriptionForeground)">{label}</span>
			<span class="min-w-0 flex-1 truncate font-mono text-xs">{value}</span>
		</div>
	{/each}
	<div class="flex items-center gap-2 px-4 py-3">
		{#if report && report.backend === 'local'}
			<span class="flex-1 text-xs text-(--vscode-descriptionForeground)">{t('terminalDaemon.local')}</span>
		{:else}
			<span class="flex-1"></span>
		{/if}
		<button class="{BUTTON} hover:bg-(--vscode-toolbar-hoverBackground)" disabled={busy} onclick={refresh}>{t('terminalDaemon.refresh')}</button>
		<button class="{BUTTON} bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground) hover:opacity-90" disabled={busy || !report?.daemon || !report.connected} onclick={restart}>{t('terminalDaemon.restart')}</button>
	</div>
</div>
