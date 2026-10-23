<script lang="ts">
	// Settings › About (VS Code's About dialog, Orca's Help menu): version, platform, and the
	// details people paste into a bug report.
	import { invoke } from '@tauri-apps/api/core';
	import KinguMark from '#lib/workbench/KinguMark.svelte';
	import ArkaiMark from '#lib/workbench/ArkaiMark.svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { platform } from '#lib/workbench/platform.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { settings } from '../settings.svelte';
	import { t } from '#lib/i18n/index.ts';

	type Info = { name: string; version: string; os: string; arch: string };
	let info = $state<Info | null>(null);
	$effect(() => {
		invoke<Info>('app_info').then((i) => (info = i)).catch(() => {});
	});

	const details = $derived(
		[
			`Kingu ${info?.version ?? '?'}`,
			`OS: ${info ? `${info.os} ${info.arch}` : navigator.platform}`,
			`UI platform: ${platform.profile.label}${platform.preview ? ' (preview)' : ''}`,
			`Theme: ${settings.get<string>('workbench.colorTheme')}`,
			`WebView: ${navigator.userAgent}`
		].join('\n')
	);

	async function copy() {
		await navigator.clipboard.writeText(details);
		status.flash(t('legacySettings.aboutPage.copied'), 3000);
	}
</script>

<div class="h-full overflow-y-auto">
	<div class="mx-auto flex max-w-[560px] flex-col items-center px-8 py-12 text-center">
		<span class="text-(--vscode-foreground)"><KinguMark size={84} /></span>
		<h1 class="mt-4 text-2xl font-semibold">Kingu Studio</h1>
		<p class="mt-1 text-[13px] text-(--vscode-descriptionForeground)">{t('legacySettings.aboutPage.tagline')}</p>
		<div class="mt-6 w-full divide-y divide-(--vscode-widget-border) rounded-xl border border-(--vscode-widget-border) text-left text-[13px]">
			{#each [[t('legacySettings.aboutPage.version'), info?.version ?? '…'], [t('legacySettings.aboutPage.system'), info ? `${info.os} · ${info.arch}` : '…'], [t('legacySettings.aboutPage.uiPlatform'), `${platform.profile.label}${platform.preview ? ' — preview' : ''}`], [t('legacySettings.aboutPage.theme'), settings.get<string>('workbench.colorTheme')]] as [k, v] (k)}
				<div class="flex px-4 py-2.5">
					<span class="w-44 text-(--vscode-descriptionForeground)">{k}</span>
					<span class="kg-selectable min-w-0 flex-1 truncate">{v}</span>
				</div>
			{/each}
		</div>
		<button class="mt-4 flex h-8 items-center gap-2 rounded-md bg-(--vscode-button-background) px-3.5 text-[13px] text-(--vscode-button-foreground) hover:opacity-90" onclick={copy}>
			<Icon name="copy" size={14} />{t('legacySettings.aboutPage.copyForBug')}
		</button>
		<div class="mt-10 flex items-center gap-2 text-xs text-(--vscode-descriptionForeground)">
			<ArkaiMark size={18} /> {t('legacySettings.aboutPage.arkaiNote')}
		</div>
	</div>
</div>
