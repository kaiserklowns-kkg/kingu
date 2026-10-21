<script lang="ts">
	// General › Support Kingu (Orca's GeneralSupportSection): a link to star the repository.
	import { openUrl } from '#lib/terminal/pty.ts';
	import { t } from '#lib/i18n/index.ts';

	const REPO = 'https://github.com/kaiserklowns-kkg/kingu';
</script>

<div class="flex items-center justify-between gap-4 py-3">
	<div class="min-w-0 flex-1 space-y-1">
		<div class="text-sm leading-none font-medium">{t('panes.general.star')}</div>
		<p class="text-xs text-(--vscode-descriptionForeground)">{t('panes.general.starHint')}</p>
	</div>
	<button class="inline-flex h-7 shrink-0 items-center rounded-md border border-(--vscode-widget-border) px-3 text-xs hover:bg-(--vscode-list-hoverBackground)" onclick={() => void openUrl(REPO)}>
		{t('panes.general.openGithub')}
	</button>
</div>
