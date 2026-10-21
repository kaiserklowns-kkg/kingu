<script lang="ts">
	// VS Code's Workspace Trust editor (Workspaces: Manage Workspace Trust), shown like VS Code's
	// modal editor over the workbench: the window's trust with Trust / Trust Parent / Don't Trust,
	// what Restricted Mode turns off, and the Trusted Folders & Workspaces list.
	import { t } from '#lib/i18n/index.ts';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { BUTTON, BUTTON_SECONDARY, ICON_BUTTON } from '#lib/ade/ui.ts';
	import Icon from './Icon.svelte';
	import { workspace } from './workspace.svelte';
	import { workspaceTrust } from './workspaceTrust.svelte';

	const s = $derived(workspaceTrust.state);
	const several = $derived(workspaceTrust.folders.length > 1 || workspace.workspaceFile !== null);
	const heading = $derived(
		!workspaceTrust.trusted ? t('trust.editor.restricted') : s.empty ? t('trust.editor.trustedWindow') : several ? t('trust.editor.trustedWorkspace') : t('trust.editor.trustedFolder')
	);
	const inherited = $derived(Object.entries(s.inherited));
	// Don't Trust only removes the window's own entries: a folder trusted through a parent has none.
	const canUntrust = $derived(workspaceTrust.trusted && !s.disabled && (s.empty || inherited.length < workspaceTrust.folders.length + (workspace.workspaceFile ? 1 : 0)));
	const parentName = $derived(workspaceTrust.parent.split('/').pop() || workspaceTrust.parent);
	const home = $derived(workspace.home);
	const shown = (p: string) => (home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p);

	const close = () => (workspaceTrust.managing = false);
	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			close();
		}
	}
</script>

<svelte:window {onkeydown} />

<div class="fixed inset-0 z-[65] grid place-items-center bg-black/40 p-6" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && close()}>
	<div role="dialog" aria-modal="true" aria-labelledby="kg-trust-title" class="flex max-h-[85vh] w-full max-w-[720px] flex-col overflow-hidden rounded-xl border border-(--vscode-widget-border) bg-(--vscode-editor-background) text-(--vscode-foreground) shadow-2xl shadow-black/50">
		<header class="flex items-center gap-2.5 border-b border-(--vscode-widget-border) px-5 py-3">
			<Icon name="shield" size={18} />
			<h2 id="kg-trust-title" class="flex-1 text-[14px] font-semibold">{t('trust.editor.title')}</h2>
			<button class="text-xs text-(--vscode-textLink-foreground) hover:underline" onclick={() => (close(), systemSettings.show('Security'))}>{t('trust.editor.settings')}</button>
			<button class={ICON_BUTTON} aria-label={t('trust.editor.close')} title={t('trust.editor.close')} onclick={close}><Icon name="close" size={16} /></button>
		</header>
		<div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-[13px]">
			<section class="flex items-start gap-3">
				<span class={['mt-0.5', workspaceTrust.trusted ? 'text-(--vscode-testing-iconPassed,#73C991)' : 'text-(--vscode-editorWarning-foreground)']}><Icon name="shield" size={28} /></span>
				<div class="min-w-0 flex-1">
					<h3 class="text-[15px] font-semibold">{heading}</h3>
					<p class="mt-1 text-(--vscode-descriptionForeground)">{workspaceTrust.trusted ? t('trust.editor.trustedDetail') : t('trust.editor.restrictedDetail')}</p>
					{#if s.disabled}<p class="mt-1 text-(--vscode-descriptionForeground)">{t('trust.editor.disabled')}</p>{/if}
					{#if s.empty && !s.disabled}<p class="mt-1 text-(--vscode-descriptionForeground)">{t('trust.editor.empty')}</p>{/if}
					{#each inherited as [folder, parent] (folder)}
						<p class="mt-1 text-(--vscode-descriptionForeground)">{t('trust.editor.inherited', { folder: shown(folder), parent: shown(parent) })}</p>
					{/each}
					{#if !s.disabled}
						<div class="mt-3 flex flex-wrap gap-2">
							{#if !workspaceTrust.trusted}
								<button class={BUTTON} onclick={() => workspaceTrust.trust()}>{t('trust.editor.trust')}</button>
								{#if !s.empty && !several}<button class={BUTTON_SECONDARY} onclick={() => workspaceTrust.trustParent()}>{t('trust.editor.trustParent', { parent: parentName })}</button>{/if}
							{:else if canUntrust}
								<button class={BUTTON_SECONDARY} onclick={() => workspaceTrust.untrust()}>{t('trust.editor.dontTrust')}</button>
							{/if}
						</div>
					{/if}
				</div>
			</section>

			<section class="mt-5 grid grid-cols-2 gap-3">
				{#each [{ title: t('trust.editor.inTrusted'), on: true, items: [t('trust.editor.allTasks'), t('trust.editor.allDebug'), t('trust.editor.allServers'), t('trust.editor.allSettings')] }, { title: t('trust.editor.inRestricted'), on: false, items: [t('trust.editor.noTasks'), t('trust.editor.noDebug'), t('trust.editor.noServers'), t('trust.editor.noSettings')] }] as col (col.title)}
					<div class={['rounded-md border p-3', col.on === workspaceTrust.trusted ? 'border-(--vscode-focusBorder)' : 'border-(--vscode-widget-border)']}>
						<h4 class="mb-2 font-semibold">{col.title}</h4>
						<ul class="space-y-1.5">
							{#each col.items as item (item)}
								<li class="flex items-start gap-2"><span class={['mt-0.5 shrink-0', col.on ? 'text-(--vscode-testing-iconPassed,#73C991)' : 'text-(--vscode-errorForeground)']}><Icon name={col.on ? 'check' : 'close'} size={14} /></span><span>{item}</span></li>
							{/each}
						</ul>
					</div>
				{/each}
			</section>

			<section class="mt-5">
				<div class="flex items-center gap-2">
					<h4 class="flex-1 font-semibold">{t('trust.editor.folders')}</h4>
					<button class={BUTTON_SECONDARY} onclick={() => workspaceTrust.pickFolder()}><Icon name="plus" size={12} />{t('trust.editor.add')}</button>
				</div>
				<p class="mt-1 text-(--vscode-descriptionForeground)">{t('trust.editor.foldersHint')}</p>
				<ul class="mt-2 rounded-md border border-(--vscode-widget-border)">
					{#each workspaceTrust.list as path (path)}
						<li class="group flex items-center gap-2 border-b border-(--vscode-widget-border) px-3 py-1.5 last:border-b-0 hover:bg-(--vscode-list-hoverBackground)">
							<Icon name="folder" size={14} />
							<span class="min-w-0 flex-1 truncate font-mono text-[12px]" title={path}>{shown(path)}</span>
							<button class={[ICON_BUTTON, 'opacity-0 group-hover:opacity-100 focus:opacity-100']} aria-label={t('trust.editor.remove', { path })} title={t('trust.editor.remove', { path })} onclick={() => workspaceTrust.removeFolder(path)}><Icon name="close" size={14} /></button>
						</li>
					{:else}
						<li class="px-3 py-4 text-center text-(--vscode-descriptionForeground)">{t('trust.editor.none')}</li>
					{/each}
				</ul>
			</section>
		</div>
	</div>
</div>
