<script lang="ts">
	// VS Code's Restricted Mode banner (security.workspace.trust.banner) under the title bar, with
	// Manage opening the Workspace Trust editor, which this component also shows while open.
	import { t } from '#lib/i18n/index.ts';
	import Icon from './Icon.svelte';
	import WorkspaceTrustEditor from './WorkspaceTrustEditor.svelte';
	import { workspaceTrust } from './workspaceTrust.svelte';
</script>

{#if workspaceTrust.bannerVisible}
	<div role="status" class="flex h-[26px] shrink-0 items-center gap-2 bg-(--vscode-banner-background,var(--vscode-list-activeSelectionBackground)) px-3 text-xs text-(--vscode-banner-foreground,var(--vscode-list-activeSelectionForeground))">
		<Icon name="shield" size={14} />
		<span class="min-w-0 flex-1 truncate">{t('trust.banner.text')}</span>
		<button class="rounded-sm px-1.5 py-0.5 text-(--vscode-textLink-foreground) underline-offset-2 hover:underline" onclick={() => workspaceTrust.manage()}>{t('trust.banner.manage')}</button>
		<button class="grid size-5 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={t('trust.banner.dismiss')} title={t('trust.banner.dismiss')} onclick={() => workspaceTrust.dismissBanner()}><Icon name="close" size={14} /></button>
	</div>
{/if}
{#if workspaceTrust.managing}<WorkspaceTrustEditor />{/if}
