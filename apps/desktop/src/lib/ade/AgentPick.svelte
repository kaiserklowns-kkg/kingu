<script lang="ts">
	// Orca's create-time agent selector (NewWorkspaceComposerAgentSection.tsx): pick the agent CLI
	// a new task starts with, from the known CLIs found on PATH (minus kingu.agent.disabled), with
	// "Set as default" writing the pick to kingu.agent.cli. `value`: a kingu.agent.cli value for
	// adeTasks.create's `agent`, '' while it is the default.
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '#lib/workbench/Icon.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import { agentForPick, enabledBins, parseCliCommand } from './agentCli';
	import { KNOWN_BINS, pickerItems, profileOf, programOf, CUSTOM_PICK } from './agentProfiles';
	import { t } from '#lib/i18n/index.ts';

	let { value = $bindable(''), disabled = false }: { value?: string; disabled?: boolean } = $props();

	const current = $derived((settings.get<string>('kingu.agent.cli') ?? '').trim());
	const currentArgv = $derived(parseCliCommand(current || 'claude'));
	const defaultProgram = $derived(currentArgv ? programOf(currentArgv) : 'claude');
	let found = $state<string[]>([]);
	$effect(() => {
		void invoke<string[]>('agent_cli_found', { names: KNOWN_BINS })
			.then((f) => (found = f))
			.catch(() => (found = []));
	});
	const rows = $derived(
		pickerItems(enabledBins(found, settings.get<string[]>('kingu.agent.disabled'), currentArgv ? profileOf(currentArgv).id : null), current).filter((r) => r.id !== CUSTOM_PICK)
	);
	/** The program shown: the pick, else the default command's. */
	let pick = $state('');
	const shown = $derived(pick || defaultProgram);
	const isDefault = $derived(agentForPick(shown, current) === (current || 'claude'));
	$effect(() => {
		value = pick && !isDefault ? agentForPick(pick, current) : '';
	});

	async function setDefault() {
		const v = agentForPick(shown, current);
		try {
			await settings.set('kingu.agent.cli', v, 'user');
			status.flash(t('ade.agentPicker.set', { command: v }));
		} catch (e) {
			notifications.error(t('ade.agentPicker.setFailed', { error: String(e) }));
		}
	}
</script>

<label class="inline-flex shrink-0 items-center gap-1 rounded-sm border border-(--vscode-widget-border) px-1.5 py-0.5 text-xs hover:bg-(--vscode-toolbar-hoverBackground)" title={t('ade.agentPick.label')}>
	<Icon name="terminal" size={12} />
	<span class="sr-only">{t('ade.agentPick.label')}</span>
	<select class="max-w-40 bg-transparent outline-none focus-visible:outline-none" value={shown} onchange={(e) => (pick = e.currentTarget.value)} {disabled}>
		{#if !rows.some((r) => r.id === shown)}<option value={shown}>{shown}</option>{/if}
		{#each rows as r (r.id)}<option value={r.id}>{r.label}{r.id === defaultProgram ? ` · ${t('ade.agentPick.isDefault')}` : ''}</option>{/each}
	</select>
</label>
{#if !isDefault}
	<button type="button" class="shrink-0 rounded-sm px-1.5 py-0.5 text-xs text-(--vscode-textLink-foreground) hover:bg-(--vscode-toolbar-hoverBackground)" title={t('ade.agentPick.setDefaultTitle', { agent: shown })} {disabled} onclick={setDefault}>{t('ade.agentPick.setDefault')}</button>
{/if}
