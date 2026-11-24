<script lang="ts">
	// Permission Grants: what Kingu allowed a terminal claude beyond one call (permissionGrants.svelte.ts).
	// Rules saved to Claude's settings, read back from the file, each with Revoke (VS Code's approval
	// manager deletes a rule the same way); session grants, which end with their claude session.
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { permissionGrants as pg, type GrantView } from './permissionGrants.svelte';

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			pg.open = false;
		}
	}
	const MUTED = 'text-(--vscode-descriptionForeground)';
	const BTN = 'h-7 rounded-md px-2.5 text-[12px] hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
	const ICON_BTN = 'grid size-6 shrink-0 place-items-center rounded text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)';
	const scopeLabel = (g: GrantView) => t(g.scope === 'project' ? 'legacyAde.permissionGrants.scopeProject' : g.scope === 'user' ? 'legacyAde.permissionGrants.scopeUser' : 'legacyAde.permissionGrants.scopeSession');
	const what = (g: GrantView) => {
		const i = g.grant.indexOf(':');
		const kind = g.grant.slice(0, i);
		const value = g.grant.slice(i + 1);
		return kind === 'mode' ? t('legacyAde.cliQuestion.grantMode') : kind === 'dir' ? t('legacyAde.cliQuestion.grantDir', { dir: value }) : t('legacyAde.cliQuestion.grantRule', { rule: value });
	};
</script>

<svelte:window {onkeydown} />

<div class="fixed inset-0 z-[65] grid place-items-center bg-black/40 p-6" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && (pg.open = false)}>
	<div role="dialog" aria-modal="true" aria-labelledby="kg-grants-title" class="flex max-h-[80vh] w-full max-w-[760px] flex-col overflow-hidden rounded-xl border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) text-(--vscode-foreground) shadow-2xl shadow-black/50">
		<header class="flex items-center gap-2.5 px-5 pt-5 pb-3">
			<Icon name="shield" size={18} />
			<h2 id="kg-grants-title" class="flex-1 text-[14px] font-semibold">{t('legacyAde.permissionGrants.title')}</h2>
			<button class={BTN} disabled={pg.loading} onclick={() => pg.refresh()}>{t('legacyAde.permissionGrants.refresh')}</button>
			<button class={ICON_BTN} aria-label={t('legacyAde.permissionGrants.close')} title={t('legacyAde.permissionGrants.close')} onclick={() => (pg.open = false)}><Icon name="close" size={14} /></button>
		</header>
		<p class="px-5 pb-3 text-[12px] {MUTED}">{t('legacyAde.permissionGrants.intro')}</p>
		{#if pg.error}
			<p class="px-5 pb-3 text-[12px] text-(--vscode-errorForeground)">{pg.error}</p>
		{/if}
		<ul class="min-h-0 flex-1 overflow-y-auto border-y border-(--vscode-widget-border) py-1">
			{#each pg.list as g (g.id)}
				<li class="mx-1.5 flex items-start gap-2 rounded-md px-3 py-2 hover:bg-(--vscode-list-hoverBackground)/60">
					<span class="min-w-0 flex-1">
						<span class="block text-[13px] break-words">{what(g)}</span>
						<span class="block text-[11px] break-words {MUTED}">
							{scopeLabel(g)}{g.cwd ? ` · ${g.cwd}` : ''}{g.detail ? ` · ${t('legacyAde.permissionGrants.askedFor', { detail: g.detail })}` : ''} · {new Date(g.at).toLocaleString()}
						</span>
						{#if g.scope === 'session'}
							<span class="block text-[11px] {MUTED}">{t('legacyAde.permissionGrants.endsWithSession')}</span>
						{:else if g.file}
							<span class="block font-mono text-[11px] break-all {MUTED}">{g.file}</span>
							{#if g.tracked}
								<span class="block text-[11px] text-(--vscode-editorWarning-foreground)">{t('legacyAde.permissionGrants.tracked')}</span>
							{/if}
						{:else}
							<span class="block text-[11px] {MUTED}">{t('legacyAde.permissionGrants.notFound', { files: g.files.join(' · ') })}</span>
						{/if}
					</span>
					{#if g.scope !== 'session'}
						<button class={BTN} onclick={() => pg.revoke(g)}>{g.file ? t('legacyAde.permissionGrants.revoke') : t('legacyAde.permissionGrants.forget')}</button>
					{/if}
				</li>
			{:else}
				<li class="px-5 py-4 text-[12px] {MUTED}">{pg.loading ? t('legacyAde.permissionGrants.loading') : t('legacyAde.permissionGrants.empty')}</li>
			{/each}
		</ul>
		<p class="px-5 py-3 text-[11px] {MUTED}">{t('legacyAde.permissionGrants.footer')}</p>
	</div>
</div>
