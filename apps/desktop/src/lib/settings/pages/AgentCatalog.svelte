<script lang="ts">
	// The top of the Agent pane, as Orca's Agents pane: the default agent as chips, Agent Permissions,
	// and the catalog of known agent CLIs — the ones found on the login-shell PATH ("Installed")
	// and the rest ("Available to install") — each with Enabled / Disabled (kingu.agent.disabled),
	// Set default (kingu.agent.cli), its docs, and a panel for the program
	// (kingu.agent.cmdOverrides), arguments (kingu.agent.args.<id>) and env (kingu.agent.env.<id>).
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '#lib/workbench/Icon.svelte';
	import AgentIcon from '#lib/agent/AgentIcon.svelte';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import { openUrl } from '#lib/terminal/pty.ts';
	import { KNOWN_BINS, PROFILES, profileOf, type AgentProfile } from '#lib/ade/agentProfiles.ts';
	import { agentArgsSetting, agentEnvSetting, cmdOverride, parseCliCommand, YOLO_ARGS } from '#lib/ade/agentCli.ts';
	import { t } from '#lib/i18n/index.ts';
	import { settings } from '../settings.svelte';
	import { SCHEMA } from '../registry';
	import ListSetting from '../ListSetting.svelte';
	import Segmented from '../Segmented.svelte';

	const DOCS: Readonly<Record<string, string>> = {
		claude: 'https://docs.anthropic.com/en/docs/claude-code/overview',
		codex: 'https://github.com/openai/codex',
		gemini: 'https://github.com/google-gemini/gemini-cli',
		opencode: 'https://opencode.ai/docs',
		cursor: 'https://docs.cursor.com/en/cli/overview',
		copilot: 'https://github.com/github/copilot-cli',
		amp: 'https://ampcode.com/manual',
		droid: 'https://docs.factory.ai/cli/getting-started/overview',
		qwen: 'https://github.com/QwenLM/qwen-code',
		aider: 'https://aider.chat/docs/install.html'
	};

	let found = $state<string[] | null>(null);
	let failed = $state(false);
	let refreshing = $state(false);
	let open = $state<string | null>(null);

	async function detect() {
		refreshing = true;
		try {
			found = await invoke<string[]>('agent_cli_found', { names: KNOWN_BINS });
			failed = false;
		} catch {
			failed = true;
			found ??= [];
		} finally {
			refreshing = false;
		}
	}
	onMount(() => void detect());

	async function save(id: string, value: unknown) {
		try {
			await settings.set(id, value, 'user');
		} catch (e) {
			notifications.error(t('settings.agents.saveFailed', { error: e instanceof Error ? e.message : String(e) }));
		}
	}

	const detected = (p: AgentProfile) => !!found && p.bins.some((b) => found!.includes(b));
	const installed = $derived(found ? PROFILES.filter(detected) : []);
	const available = $derived(found ? PROFILES.filter((p) => !detected(p)) : []);

	const disabledIds = $derived((settings.get<unknown[]>('kingu.agent.disabled') ?? []).filter((d): d is string => typeof d === 'string'));
	const isEnabled = (p: AgentProfile) => !disabledIds.includes(p.id);
	function setEnabled(p: AgentProfile, on: boolean) {
		const next = on ? disabledIds.filter((d) => d !== p.id) : [...disabledIds, p.id];
		void save('kingu.agent.disabled', next.length ? next : undefined);
	}

	// The default: Auto is no user value (Kingu's default, claude); a chip or Set default writes the
	// CLI's program, keeping the flags already set when it is the same CLI (like Agent: Choose CLI…).
	const current = $derived((settings.get<string>('kingu.agent.cli') ?? '').trim());
	const userDefault = $derived(settings.inspect('kingu.agent.cli', 'user') !== undefined);
	const currentProfile = $derived(userDefault ? profileOf(parseCliCommand(current) ?? []) : null);
	const isDefault = (p: AgentProfile) => currentProfile?.id === p.id;
	function setDefault(p: AgentProfile | null) {
		if (!p || isDefault(p)) return void save('kingu.agent.cli', undefined);
		void save('kingu.agent.cli', currentProfile?.id === p.id ? current : p.bins[0]);
	}
	const chips = $derived(PROFILES.filter((p) => (detected(p) && isEnabled(p)) || isDefault(p)));

	const permissions = $derived(settings.get<string>('kingu.agent.cliPermissions') === 'yolo' ? 'yolo' : 'manual');

	// What the row shows under the name: the program (an override struck through the default), the
	// arguments (yours, else the bypass flags Yolo adds) and the env names.
	const overrides = $derived(settings.get<Record<string, unknown>>('kingu.agent.cmdOverrides') ?? {});
	const program = (p: AgentProfile) => cmdOverride(overrides, p.id);
	const args = (p: AgentProfile) => (settings.get<string>(agentArgsSetting(p.id)) ?? '').trim();
	const shownArgs = (p: AgentProfile) => args(p) || (permissions === 'yolo' ? (YOLO_ARGS[p.id] ?? []).join(' ') : '');
	const envNames = (p: AgentProfile) => Object.keys(settings.get<Record<string, unknown>>(agentEnvSetting(p.id)) ?? {});

	function setProgram(p: AgentProfile, value: string) {
		const next = { ...overrides };
		if (value.trim() && value.trim() !== p.bins[0]) next[p.id] = value.trim();
		else delete next[p.id];
		void save('kingu.agent.cmdOverrides', Object.keys(next).length ? next : undefined);
	}

	const SUBHEAD = 'flex items-center gap-2 text-sm font-semibold';
	const COUNT = 'rounded-full border border-(--vscode-widget-border) px-1.5 py-0.5 text-[10px] font-medium text-(--vscode-foreground)/80';
	const ICON_BTN = 'grid size-7 place-items-center rounded-md text-(--vscode-descriptionForeground) transition-colors hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)';
	const GHOST = 'inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:opacity-50';
	const INPUT = 'h-7 w-full rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 font-mono text-xs text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)';
</script>

{#snippet agentIcon(p: AgentProfile)}
	<div class="grid size-7 shrink-0 place-items-center rounded-md border border-(--vscode-widget-border)/50 bg-(--vscode-editor-background)/50">
		<AgentIcon agent={p.id} size={16} />
	</div>
{/snippet}

<!-- One agent (Orca's AgentCatalogRow): icon, name and command, then Enabled / Disabled, Set default, docs, customize. -->
{#snippet row(p: AgentProfile, isDetected: boolean)}
	{@const enabled = isEnabled(p)}
	{@const override = program(p)}
	{@const expanded = open === p.id}
	<div class={['py-3', !isDetected && 'opacity-70']}>
		<div class="flex flex-wrap items-start gap-3">
			{@render agentIcon(p)}
			<div class="min-w-48 flex-1">
				<div class="flex items-center gap-2">
					<span class="text-sm leading-none font-medium">{p.title}</span>
					{#if !enabled}<span class={COUNT}>{t('settings.agents.disabled')}</span>{/if}
				</div>
				<div class="mt-1 truncate font-mono text-[11px] text-(--vscode-descriptionForeground)">
					{#if override}<span class="line-through opacity-60">{p.bins[0]}</span><span class="ml-1.5 text-(--vscode-foreground)/80">{override}</span>{:else}{p.bins[0]}{/if}
					{#if shownArgs(p)}<span class="ml-1.5 text-(--vscode-foreground)/70">{shownArgs(p)}</span>{/if}
					{#each envNames(p) as name (name)}<span class="ml-1.5 text-(--vscode-foreground)/60">{name}=…</span>{/each}
				</div>
			</div>
			<div class="ml-auto grid shrink-0 grid-cols-[max-content_7rem_1.75rem_1.75rem] items-center gap-1.5">
				<Segmented
					value={enabled ? 'on' : 'off'}
					label={p.title}
					options={[
						{ value: 'on', label: t('settings.agents.enabled') },
						{ value: 'off', label: t('settings.agents.disabled') }
					]}
					onchange={(v) => setEnabled(p, v === 'on')}
				/>
				<div>
					{#if isDetected}
						<button class={[GHOST, 'w-full', isDefault(p) && 'text-(--vscode-foreground)']} disabled={!enabled} title={isDefault(p) ? t('settings.agents.clearDefault') : undefined} onclick={() => setDefault(p)}>
							{#if isDefault(p)}<Icon name="check" size={12} />{t('settings.agents.isDefault')}{:else}{t('settings.agents.setDefault')}{/if}
						</button>
					{/if}
				</div>
				{#if DOCS[p.id]}
					<button class={ICON_BTN} aria-label={isDetected ? t('settings.agents.docs') : t('settings.agents.install')} title={isDetected ? t('settings.agents.docs') : t('settings.agents.install')} onclick={() => void openUrl(DOCS[p.id])}>
						<Icon name="openExternal" size={14} />
					</button>
				{:else}<span></span>{/if}
				<button class={ICON_BTN} aria-expanded={expanded} aria-label={t('settings.agents.customize')} title={t('settings.agents.customize')} onclick={() => (open = expanded ? null : p.id)}>
					<span class={['grid place-items-center transition-transform', expanded && 'rotate-180']}><Icon name="chevronDown" size={14} /></span>
				</button>
			</div>
		</div>
		{#if expanded}
			{@const envSchema = SCHEMA.get(agentEnvSetting(p.id))}
			<div class="mt-3 space-y-2 pl-10">
				<label class="block space-y-1">
					<span class="text-xs font-medium">{t('settings.agents.command')}</span>
					<input class={INPUT} value={override ?? ''} placeholder={p.bins[0]} spellcheck="false" onchange={(e) => setProgram(p, e.currentTarget.value)} />
				</label>
				<label class="block space-y-1">
					<span class="text-xs font-medium">{t('settings.agents.arguments')}</span>
					<input class={INPUT} value={args(p)} placeholder={(YOLO_ARGS[p.id] ?? []).join(' ')} spellcheck="false" onchange={(e) => void save(agentArgsSetting(p.id), e.currentTarget.value.trim() || undefined)} />
				</label>
				{#if envSchema && envSchema.type === 'object'}
					<div class="space-y-1">
						<span class="text-xs font-medium">{t('settings.agents.environment')}</span>
						<ListSetting quiet schema={envSchema} value={settings.get(agentEnvSetting(p.id)) ?? {}} onchange={(v) => void save(agentEnvSetting(p.id), v && Object.keys(v as object).length ? v : undefined)} />
					</div>
				{/if}
				<p class="text-[11px] text-(--vscode-descriptionForeground)">{t('settings.agents.customizeHint')}</p>
			</div>
		{/if}
	</div>
{/snippet}

<div class="space-y-8">
	<section class="space-y-4">
		<div class="space-y-1">
			<h3 class="text-sm font-semibold">{t('settings.agents.defaultAgent')}</h3>
			<p class="text-xs text-(--vscode-descriptionForeground)">{t('settings.agents.defaultAgentHint')}</p>
		</div>
		<div class="flex flex-wrap gap-2" role="radiogroup" aria-label={t('settings.agents.defaultAgent')}>
			{#snippet chip(on: boolean, label: string, title: string | undefined, agent: string | null, pick: () => void)}
				<button
					type="button"
					role="radio"
					aria-checked={on}
					{title}
					class={[
						'inline-flex h-9 items-center gap-2 rounded-md border px-3.5 text-sm transition-colors',
						on ? 'border-(--vscode-foreground)/25 bg-(--vscode-list-inactiveSelectionBackground) font-medium' : 'border-(--vscode-widget-border) text-(--vscode-foreground)/80 hover:bg-(--vscode-list-hoverBackground)'
					]}
					onclick={pick}
				>
					{#if on}<Icon name="check" size={14} />{:else if agent}<AgentIcon {agent} size={14} />{/if}{label}
				</button>
			{/snippet}
			{@render chip(!userDefault, t('settings.agents.auto'), t('settings.agents.autoHint'), null, () => setDefault(null))}
			{#each chips as p (p.id)}
				{@render chip(isDefault(p), p.title, found && !detected(p) ? t('settings.agents.notDetected') : undefined, p.id, () => !isDefault(p) && setDefault(p))}
			{/each}
		</div>
	</section>

	<section class="flex items-start justify-between gap-3">
		<div class="space-y-1">
			<h3 class="text-sm font-semibold">{t('settings.agents.permissions')}</h3>
			<p class="text-xs text-(--vscode-descriptionForeground)">{t('settings.agents.permissionsHint')}</p>
		</div>
		<Segmented
			value={permissions}
			label={t('settings.agents.permissions')}
			options={[
				{ value: 'manual', label: t('settings.agents.manual') },
				{ value: 'yolo', label: t('settings.agents.yolo') }
			]}
			onchange={(v) => void save('kingu.agent.cliPermissions', v === 'manual' ? undefined : v)}
		/>
	</section>

	{#if found === null}
		<div class="flex items-center justify-center rounded-md border border-dashed border-(--vscode-widget-border) py-6 text-sm text-(--vscode-descriptionForeground)">{t('settings.agents.detecting')}</div>
	{:else}
		{#if failed}
			<div class="flex items-center justify-between gap-3 rounded-md border border-(--vscode-errorForeground)/40 px-3 py-2 text-xs text-(--vscode-errorForeground)">
				<span class="flex items-center gap-2"><Icon name="warning" size={14} />{t('settings.agents.detectFailed')}</span>
				<button class={GHOST} onclick={detect}><Icon name="refresh" size={12} />{t('settings.agents.retry')}</button>
			</div>
		{/if}
		<section class="space-y-3">
			<div class="flex items-center justify-between gap-3">
				<h3 class={SUBHEAD}>{t('settings.agents.installed')}<span class={COUNT}>{t('settings.agents.detected', { count: installed.length })}</span></h3>
				<button class={GHOST} disabled={refreshing} title={t('settings.agents.refreshHint')} onclick={detect}>
					<span class={['grid place-items-center', refreshing && 'animate-spin']}><Icon name="refresh" size={12} /></span>{refreshing ? t('settings.agents.refreshing') : t('settings.agents.refresh')}
				</button>
			</div>
			{#if installed.length}
				<div class="divide-y divide-(--vscode-widget-border)/40">
					{#each installed as p (p.id)}{@render row(p, true)}{/each}
				</div>
			{:else}
				<div class="rounded-md border border-dashed border-(--vscode-widget-border) px-3 py-3 text-sm text-(--vscode-descriptionForeground)">{t('settings.agents.noneDetected')}</div>
			{/if}
		</section>
		{#if available.length}
			<section class="space-y-3">
				<h3 class={[SUBHEAD, 'text-(--vscode-descriptionForeground)']}>{t('settings.agents.available')}<span class={COUNT}>{t('settings.agents.agentsCount', { count: available.length })}</span></h3>
				<div class="divide-y divide-(--vscode-widget-border)/40">
					{#each available as p (p.id)}{@render row(p, false)}{/each}
				</div>
			</section>
		{/if}
	{/if}
</div>
