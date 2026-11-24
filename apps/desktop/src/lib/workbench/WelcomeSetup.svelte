<script lang="ts">
	// The welcome tour's setup steps (Orca's onboarding: AgentStep, ThemeStep, IntegrationsStep,
	// NotificationStep): the default agent CLI among the ones installed, the color theme, GitHub and
	// the issue trackers, and agent notifications with a test. Each pick is a user setting, applied at once, so Skip keeps whatever was chosen.
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { t } from '#lib/i18n/index.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { commands } from './commands.svelte';
	import AgentIcon from '#lib/agent/AgentIcon.svelte';
	import { enabledBins } from '#lib/ade/agentCli.ts';
	import { CUSTOM_PICK, KNOWN_BINS, pickerItems } from '#lib/ade/agentProfiles.ts';
	import { allThemes, isDarkType } from '#lib/theme/themes.ts';
	import { setup } from '#lib/setup/setup.svelte.ts';
	import { linear } from '#lib/ade/linear.svelte.ts';
	import { sources } from '#lib/ade/taskSources.svelte.ts';
	import { floating } from './floating.svelte';
	import { welcome } from './welcomeTour.svelte';

	let { part }: { part: 'agent' | 'theme' | 'integrations' | 'notify' } = $props();

	// Orca's IntegrationsStep: GitHub from the machine check (gh installed, signed in), the trackers from their stored keys.
	onMount(() => {
		if (part !== 'integrations') return;
		void setup.load();
		void sources.refreshConnections();
	});
	const check = (id: string) => setup.report?.checks.find((c) => c.id === id)?.status;
	const github = $derived(setup.checking || !setup.report ? 'checking' : check('gh') !== 'ok' ? 'missing' : check('gh_auth') === 'ok' ? 'connected' : 'signin');
	const trackers = $derived([
		{ id: 'linear', name: 'Linear', on: !!linear.viewer, who: linear.viewer?.organization ?? '', connect: () => (linear.connecting = true) },
		{ id: 'jira', name: 'Jira', on: !!sources.jira, who: sources.jira?.site ?? '', connect: () => (sources.connecting = 'jira') },
		{ id: 'gitlab', name: 'GitLab', on: !!sources.gitlab, who: sources.gitlab?.host ?? '', connect: () => (sources.connecting = 'gitlab') }
	]);
	/** `gh auth login` needs a terminal: it runs in the floating workspace, which the tour would cover. */
	function githubSignIn() {
		welcome.close();
		floating.newTerminal({ title: 'gh auth login', run: ['gh', 'auth', 'login'] });
		floating.open = true;
	}

	let found = $state<string[] | null>(null);
	onMount(() => {
		if (part !== 'agent') return;
		void invoke<string[]>('agent_cli_found', { names: KNOWN_BINS })
			.then((f) => (found = f))
			.catch(() => (found = []));
	});
	const agents = $derived(found ? pickerItems(enabledBins(found, settings.get<string[]>('kingu.agent.disabled'), null), '').filter((r) => r.id !== CUSTOM_PICK) : []);
	const agent = $derived(settings.get<string>('kingu.agent.cli') || 'claude');
	const themes = $derived(allThemes());
	const theme = $derived(settings.get<string>('workbench.colorTheme'));
	const notifyOn = $derived(settings.get<boolean>('kingu.agent.notifications') !== false);
	const sound = $derived(settings.get<string>('kingu.agent.notifications.sound') ?? 'default');
	const SOUNDS = ['none', 'default', 'Glass', 'Ping', 'Pop', 'Hero', 'Submarine', 'Tink'];

	const set = (id: string, value: unknown) => void settings.set(id, value, 'user');
	const CHOICE = 'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-[13px] transition-colors';
	const on = (yes: boolean) => (yes ? 'border-(--vscode-focusBorder) bg-(--vscode-list-activeSelectionBackground)/40' : 'border-(--vscode-widget-border) hover:bg-(--vscode-toolbar-hoverBackground)');
</script>

{#if part === 'agent'}
	{#if found === null}
		<p class="text-xs text-(--vscode-descriptionForeground)">{t('legacyWorkbench.welcome.agentLooking')}</p>
	{:else if !agents.length}
		<p class="text-xs text-(--vscode-descriptionForeground)">{t('legacyWorkbench.welcome.agentNone')}</p>
		<button class="rounded-md border border-(--vscode-widget-border) px-3 py-1.5 text-[13px] hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => void commands.run('kingu.setup.open')}>{t('legacyWorkbench.welcome.checkMachine')}</button>
	{:else}
		<div class="grid w-full grid-cols-2 gap-2" role="radiogroup" aria-label={t('legacyWorkbench.welcome.agentTitle')}>
			{#each agents as a (a.id)}
				<button role="radio" aria-checked={a.id === agent} class={[CHOICE, on(a.id === agent)]} title={a.description} onclick={() => set('kingu.agent.cli', a.id)}>
					<AgentIcon agent={a.agent ?? a.id} size={16} /><span class="min-w-0 flex-1 truncate">{a.label}</span>
				</button>
			{/each}
		</div>
	{/if}
{:else if part === 'theme'}
	<div class="grid max-h-56 w-full grid-cols-2 gap-2 overflow-y-auto" role="radiogroup" aria-label={t('legacyWorkbench.welcome.themeTitle')}>
		{#each themes as th (th.id)}
			<button role="radio" aria-checked={th.id === theme} class={[CHOICE, on(th.id === theme)]} onclick={() => set('workbench.colorTheme', th.id)}>
				<span class={['size-3 shrink-0 rounded-full border border-(--vscode-widget-border)', isDarkType(th.type) ? 'bg-neutral-800' : 'bg-neutral-100']} aria-hidden="true"></span>
				<span class="min-w-0 flex-1 truncate">{th.label}</span>
			</button>
		{/each}
	</div>
{:else if part === 'integrations'}
	<div class="flex w-full flex-col gap-2 text-left text-[13px]">
		<div class="flex items-center gap-2 rounded-lg border border-(--vscode-widget-border) px-3 py-2">
			<span class="min-w-0 flex-1">
				<span class="block font-medium">GitHub</span>
				<span class="block text-[11px] text-(--vscode-descriptionForeground)">{t('legacyWorkbench.welcome.githubHint')}</span>
			</span>
			{#if github === 'connected'}
				<span class="text-xs text-[#73C991]">{t('legacyWorkbench.welcome.connected')}</span>
			{:else if github === 'checking'}
				<span class="text-xs text-(--vscode-descriptionForeground)">{t('legacyWorkbench.welcome.checking')}</span>
			{:else}
				{#if github === 'missing'}
					<button class="rounded-md border border-(--vscode-widget-border) px-2 py-1 text-xs hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => void invoke('open_web_url', { url: 'https://cli.github.com' })}>{t('legacyWorkbench.welcome.installGh')}</button>
				{:else}
					<button class="rounded-md border border-(--vscode-widget-border) px-2 py-1 text-xs hover:bg-(--vscode-toolbar-hoverBackground)" onclick={githubSignIn}>{t('legacyWorkbench.welcome.signIn')}</button>
				{/if}
				<button class="rounded-md px-2 py-1 text-xs text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => void setup.check()}>{t('legacyWorkbench.welcome.recheck')}</button>
			{/if}
		</div>
		{#each trackers as tr (tr.id)}
			<div class="flex items-center gap-2 rounded-lg border border-(--vscode-widget-border) px-3 py-2">
				<span class="min-w-0 flex-1">
					<span class="block font-medium">{tr.name}</span>
					{#if tr.on && tr.who}<span class="block truncate text-[11px] text-(--vscode-descriptionForeground)">{tr.who}</span>{/if}
				</span>
				{#if tr.on}
					<span class="text-xs text-[#73C991]">{t('legacyWorkbench.welcome.connected')}</span>
				{:else}
					<button class="rounded-md border border-(--vscode-widget-border) px-2 py-1 text-xs hover:bg-(--vscode-toolbar-hoverBackground)" onclick={tr.connect}>{t('legacyWorkbench.welcome.connect')}</button>
				{/if}
			</div>
		{/each}
		<p class="text-[11px] text-(--vscode-descriptionForeground)">{t('legacyWorkbench.welcome.integrationsHint')}</p>
	</div>
{:else}
	<div class="flex w-full flex-col gap-2 text-left text-[13px]">
		<label class="flex items-center gap-2">
			<input type="checkbox" checked={notifyOn} onchange={(e) => set('kingu.agent.notifications', e.currentTarget.checked)} />
			{t('legacyWorkbench.welcome.notifyOn')}
		</label>
		<label class="flex items-center gap-2" class:opacity-50={!notifyOn}>
			<span class="text-(--vscode-descriptionForeground)">{t('legacyWorkbench.welcome.notifySound')}</span>
			<select class="h-7 rounded-md border border-(--vscode-dropdown-border,var(--vscode-widget-border)) bg-(--vscode-dropdown-background) px-2 text-(--vscode-dropdown-foreground)" value={sound} disabled={!notifyOn} onchange={(e) => set('kingu.agent.notifications.sound', e.currentTarget.value)}>
				{#each SOUNDS as s (s)}<option value={s}>{s === 'none' ? t('legacyWorkbench.welcome.soundNone') : s === 'default' ? t('legacyWorkbench.welcome.soundDefault') : s}</option>{/each}
			</select>
		</label>
		<button class="self-start rounded-md border border-(--vscode-widget-border) px-3 py-1.5 hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50" disabled={!notifyOn} onclick={() => void commands.run('kingu.agents.testNotification')}>{t('legacyWorkbench.welcome.notifyTest')}</button>
		<p class="text-[11px] text-(--vscode-descriptionForeground)">{t('legacyWorkbench.welcome.notifyHint')}</p>
	</div>
{/if}
