<script lang="ts">
	// Settings › Terminal (Orca's Terminal pane + VS Code's terminal.integrated.*).
	import Icon from '#lib/workbench/Icon.svelte';
	import { floating } from '#lib/workbench/floating.svelte.ts';
	import { settings } from '../settings.svelte';
	import { systemSettings } from '../systemSettings.svelte';
	import Stepper from './Stepper.svelte';
	import Switch from './Switch.svelte';
	import SettingChoice from './SettingChoice.svelte';
	import { t } from '#lib/i18n/index.ts';

	const family = $derived(settings.get<string>('terminal.integrated.fontFamily') ?? '');
	const setFamily = (v: string) => void settings.set('terminal.integrated.fontFamily', v.trim() || undefined, 'user');
	const SECTION = 'mt-7 mb-2 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase';
	const CARD = 'divide-y divide-(--vscode-widget-border) rounded-xl border border-(--vscode-widget-border)';
</script>

<div class="h-full overflow-y-auto">
	<div class="mx-auto max-w-4xl px-8 pt-10 pb-24">
		<h1 class="flex items-center gap-2 text-2xl leading-tight font-semibold"><Icon name="terminal" size={20} />Terminal</h1>
		<p class="mt-2 max-w-3xl text-sm leading-6 text-(--vscode-descriptionForeground)">{t('legacySettings.terminalPage.intro')}</p>

		<h2 class={SECTION}>{t('legacySettings.terminalPage.fontSection')}</h2>
		<div class={CARD}>
			<Stepper id="terminal.integrated.fontSize" label={t('legacySettings.terminalPage.fontSize')} hint="terminal.integrated.fontSize" />
			<label class="block px-4 py-3">
				<span class="text-[13px]">{t('legacySettings.terminalPage.fontFamily')}</span>
				<span class="block text-xs text-(--vscode-descriptionForeground)">{t('legacySettings.terminalPage.fontFamilyHint')}</span>
				<input
					class="mt-1.5 h-8 w-full max-w-[420px] rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2.5 font-mono text-[13px] outline-none focus:border-(--vscode-focusBorder)"
					value={family}
					placeholder={t('legacySettings.terminalPage.fontPlaceholder')}
					spellcheck="false"
					onchange={(e) => setFamily(e.currentTarget.value)}
				/>
			</label>
		</div>

		<h2 class={SECTION}>Floating Workspace</h2>
		<p class="mb-2 text-xs text-(--vscode-descriptionForeground)">{t('legacySettings.terminalPage.floatingIntro')}</p>
		<div class={CARD}>
			<Switch id="kingu.floating.enabled" label="Enable Floating Workspace" hint={t('legacySettings.terminalPage.floatingEnableHint')} />
			<label class="block px-4 py-3">
				<span class="text-[13px]">Terminal Directory</span>
				<span class="block text-xs text-(--vscode-descriptionForeground)">{t('legacySettings.terminalPage.directoryHint')}</span>
				<input
					class="mt-1.5 h-8 w-full max-w-[420px] rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2.5 font-mono text-[13px] outline-none focus:border-(--vscode-focusBorder)"
					value={settings.get<string>('kingu.floating.cwd') ?? '~'}
					placeholder="~"
					spellcheck="false"
					onchange={(e) => void settings.set('kingu.floating.cwd', e.currentTarget.value.trim() && e.currentTarget.value.trim() !== '~' ? e.currentTarget.value.trim() : undefined, 'user')}
				/>
			</label>
			<div class="px-4 py-3">
				<div class="text-[13px]">Toggle Button Location</div>
				<div class="mb-2 text-xs text-(--vscode-descriptionForeground)">{t('legacySettings.terminalPage.toggleHint')}</div>
				<SettingChoice id="kingu.floating.triggerLocation" labels={{ 'floating-button': 'Floating Button', 'status-bar': 'Status Bar' }} />
			</div>
			<div class="flex items-center gap-3 px-4 py-3">
				<div class="min-w-0 flex-1 text-[13px]">{floating.open ? t('legacySettings.terminalPage.floatingOpen') : t('legacySettings.terminalPage.floatingHidden')}</div>
				<button class="h-8 rounded-md bg-(--vscode-button-background) px-3.5 text-[13px] text-(--vscode-button-foreground) hover:opacity-90 disabled:opacity-50" disabled={!floating.enabled} onclick={() => (systemSettings.close(), floating.toggle())}>
					{floating.open ? t('legacySettings.terminalPage.collapseFloating') : t('legacySettings.terminalPage.openFloating')}
				</button>
			</div>
		</div>
	</div>
</div>
