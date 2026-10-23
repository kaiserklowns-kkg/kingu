<script lang="ts">
	// Settings › Arkai (Orca's Agents pane): how Arkai runs tasks, asks for permission, and tells you
	// what it is doing. Every control writes the same settings the settings editor shows.
	import ArkaiMark from '#lib/workbench/ArkaiMark.svelte';
	import { settings } from '../settings.svelte';
	import { SETTINGS } from '../registry';
	import SettingChoice from './SettingChoice.svelte';
	import ArkaiProviders from './ArkaiProviders.svelte';
	import { t } from '#lib/i18n/index.ts';

	const get = (id: string) => settings.get<string>(id) ?? '';
	const set = (id: string, v: string) => void settings.set(id, v.trim() === SETTINGS.find((s) => s.id === id)?.default ? undefined : v.trim(), 'user');

	const SECTION = 'mt-7 mb-2 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase';
	const INPUT = 'h-8 w-full max-w-[420px] rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2.5 font-mono text-[13px] text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)';
</script>

<div class="h-full overflow-y-auto">
	<div class="mx-auto max-w-4xl px-8 pt-10 pb-24">
		<div class="flex items-center gap-3">
			<span class="text-(--vscode-foreground)"><ArkaiMark size={40} /></span>
			<div>
				<h1 class="text-2xl leading-tight font-semibold">Arkai</h1>
				<p class="mt-2 max-w-3xl text-sm leading-6 text-(--vscode-descriptionForeground)">{t('legacySettings.arkaiPage.intro')}</p>
			</div>
		</div>

		<h2 class={SECTION}>{t('legacySettings.arkaiPage.runSection')}</h2>
		<label class="mt-3 block">
			<span class="text-[13px]">{t('legacySettings.arkaiPage.cliLabel')}</span>
			<span class="block text-xs text-(--vscode-descriptionForeground)">{t('legacySettings.arkaiPage.cliHint')}</span>
			<input class="{INPUT} mt-1.5" value={get('kingu.agent.cli')} onchange={(e) => set('kingu.agent.cli', e.currentTarget.value)} spellcheck="false" />
		</label>

		<ArkaiProviders />

		<h2 class={SECTION}>{t('legacySettings.arkaiPage.permissionSection')}</h2>
		<SettingChoice id="kingu.agent.permissionMode" labels={{ default: t('legacySettings.arkaiPage.permissionDefault'), acceptEdits: t('legacySettings.arkaiPage.permissionAcceptEdits'), plan: t('legacySettings.arkaiPage.permissionPlan') }} />

		<h2 class={SECTION}>{t('legacySettings.arkaiPage.statusSection')}</h2>
		<SettingChoice id="kingu.agentsControl.enabled" labels={{ hidden: t('legacySettings.arkaiPage.statusHidden'), badge: t('legacySettings.arkaiPage.statusBadge'), compact: t('legacySettings.arkaiPage.statusCompact') }} />

		<h2 class={SECTION}>{t('legacySettings.arkaiPage.soundSection')}</h2>
		<SettingChoice id="kingu.accessibility.signals" labels={{ off: t('legacySettings.arkaiPage.soundOff'), agents: t('legacySettings.arkaiPage.soundAgents'), all: t('legacySettings.arkaiPage.soundAll') }} />

		<h2 class={SECTION}>{t('legacySettings.arkaiPage.keepAwakeSection')}</h2>
		<SettingChoice id="kingu.keepAwake" labels={{ off: 'Off', auto: 'Auto', on: 'On' }} />
	</div>
</div>
