<script lang="ts">
	// General › Kingu CLI (Orca's CliSection): the `kingu` command in PATH as a switch, where it
	// links, and whether the shell sees that folder. Install / uninstall are the palette's commands.
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '#lib/workbench/Icon.svelte';
	import { installInPath, uninstallFromPath } from '#lib/ade/cliBridge.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import Toggle from '../Toggle.svelte';

	type Installed = { path: string; on_path: boolean };
	let installed = $state<Installed | null | undefined>(undefined);
	let busy = $state(false);

	async function refresh() {
		installed = await invoke<Installed | null>('cli_status').catch(() => null);
	}
	onMount(() => void refresh());

	async function toggle(on: boolean) {
		busy = true;
		try {
			if (on) await installInPath();
			else await uninstallFromPath();
		} finally {
			await refresh();
			busy = false;
		}
	}
</script>

<div class="space-y-2">
	<div class="flex items-center justify-between gap-4 py-3">
		<div class="min-w-0 flex-1 space-y-1">
			<div class="text-sm leading-none font-medium">{t('panes.general.shellCommand')}</div>
			<p class="text-xs text-(--vscode-descriptionForeground)">{t('panes.general.shellCommandHint')}</p>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			<button
				class="grid size-7 place-items-center rounded-md text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)"
				title={t('panes.general.refresh')}
				aria-label={t('panes.general.refresh')}
				onclick={refresh}><Icon name="refresh" size={14} /></button
			>
			<Toggle checked={!!installed} label={t('panes.general.shellCommand')} disabled={busy || installed === undefined} onchange={toggle} />
		</div>
	</div>
	{#if installed}
		<p class="text-xs text-(--vscode-descriptionForeground)">{t('panes.general.commandPath')} <code class="font-mono">{installed.path}</code></p>
		{#if !installed.on_path}<p class="text-xs text-(--vscode-editorWarning-foreground)">{t('panes.general.notOnPath')}</p>{/if}
	{/if}
</div>
