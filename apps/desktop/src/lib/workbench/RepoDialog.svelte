<script lang="ts">
	// Clone Repository / New Project (Orca's Add Project dialog): a URL or a name, the folder it
	// goes in, progress while cloning with Cancel, then the result opens as the folder.
	import { repoDialog } from './repoDialog.svelte.ts';
	import { cloneUrlError, progressLabel, repoNameFromUrl } from './repoDialog.ts';
	import { t } from '#lib/i18n/index.ts';

	const clone = $derived(repoDialog.mode === 'clone');
	const target = $derived(clone ? repoNameFromUrl(repoDialog.url) : repoDialog.name.trim());
	const urlHint = $derived(clone && repoDialog.url.trim() ? cloneUrlError(repoDialog.url) : null);

	function submit(e: SubmitEvent) {
		e.preventDefault();
		if (repoDialog.busy) return;
		void (clone ? repoDialog.clone() : repoDialog.create());
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && repoDialog.mode && !repoDialog.busy) {
			e.preventDefault();
			repoDialog.close();
		}
	}

	const INPUT =
		'h-[26px] w-full min-w-0 rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground) focus:border-(--vscode-focusBorder)';
	const BUTTON = 'h-[26px] rounded-sm px-3 disabled:opacity-50';
</script>

<svelte:window {onkeydown} />

{#if repoDialog.mode}
	<div class="fixed inset-0 z-40 bg-black/30" role="presentation" onpointerdown={() => repoDialog.close()}></div>
	<div
		class="fixed top-[12vh] left-1/2 z-50 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 rounded-lg border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) p-4 text-[13px] text-(--vscode-foreground) shadow-xl shadow-black/40"
		role="dialog"
		aria-modal="true"
		aria-label={clone ? 'Clone Repository' : 'New Project'}
	>
		<form class="space-y-3" onsubmit={submit}>
			<h2 class="text-sm font-semibold">{clone ? 'Clone Repository' : t('legacyWorkbench.repoDialog.newProject')}</h2>
			{#if clone}
				<label class="block space-y-1">
					<span class="text-(--vscode-descriptionForeground)">{t('legacyWorkbench.repoDialog.repoUrl')}</span>
					<!-- svelte-ignore a11y_autofocus -->
					<input class={INPUT} bind:value={repoDialog.url} placeholder={t('legacyWorkbench.repoDialog.urlPlaceholder')} spellcheck="false" autocomplete="off" disabled={repoDialog.busy} autofocus />
				</label>
				{#if urlHint}<p class="text-(--vscode-editorWarning-foreground)">{urlHint}</p>{/if}
			{:else}
				<label class="block space-y-1">
					<span class="text-(--vscode-descriptionForeground)">{t('legacyWorkbench.repoDialog.projectName')}</span>
					<!-- svelte-ignore a11y_autofocus -->
					<input class={INPUT} bind:value={repoDialog.name} placeholder="my-project" spellcheck="false" autocomplete="off" disabled={repoDialog.busy} autofocus />
				</label>
			{/if}
			<div class="space-y-1">
				<span class="text-(--vscode-descriptionForeground)">{clone ? t('legacyWorkbench.repoDialog.cloneInto') : t('legacyWorkbench.repoDialog.createInto')}</span>
				<div class="flex gap-1.5">
					<input class={INPUT} bind:value={repoDialog.parent} aria-label={t('legacyWorkbench.repoDialog.destinationFolder')} spellcheck="false" disabled={repoDialog.busy} />
					<button type="button" class={[BUTTON, 'shrink-0 border border-(--vscode-widget-border) hover:bg-(--vscode-toolbar-hoverBackground)']} disabled={repoDialog.busy} onclick={() => repoDialog.pickParent()}>{t('legacyWorkbench.repoDialog.choose')}</button>
				</div>
				{#if target && repoDialog.parent.trim()}
					<p class="truncate text-xs text-(--vscode-descriptionForeground)" title="{repoDialog.parent.replace(/\/+$/, '')}/{target}">→ {repoDialog.parent.replace(/\/+$/, '')}/{target}</p>
				{/if}
				{#if !clone}<p class="text-xs text-(--vscode-descriptionForeground)">{t('legacyWorkbench.repoDialog.createHint')}</p>{/if}
			</div>
			{#if repoDialog.busy && clone}
				<div class="space-y-1" role="status">
					<div class="h-1 overflow-hidden rounded bg-(--vscode-widget-border)">
						<div class="h-full bg-(--vscode-progressBar-background,#0E70C0) transition-[width]" style:width="{repoDialog.progress?.percent ?? 0}%"></div>
					</div>
					<p class="text-xs text-(--vscode-descriptionForeground)">{progressLabel(repoDialog.progress)}</p>
				</div>
			{/if}
			{#if repoDialog.error}<p class="break-words whitespace-pre-wrap text-(--vscode-errorForeground)">{repoDialog.error}</p>{/if}
			<div class="flex justify-end gap-1.5">
				{#if repoDialog.busy && clone}
					<button type="button" class={[BUTTON, 'border border-(--vscode-widget-border) hover:bg-(--vscode-toolbar-hoverBackground)']} onclick={() => repoDialog.cancelClone()}>{t('legacyWorkbench.repoDialog.cancelClone')}</button>
				{:else}
					<button type="button" class={[BUTTON, 'border border-(--vscode-widget-border) hover:bg-(--vscode-toolbar-hoverBackground)']} disabled={repoDialog.busy} onclick={() => repoDialog.close()}>{t('legacyWorkbench.repoDialog.cancel')}</button>
				{/if}
				<button type="submit" class={[BUTTON, 'bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:brightness-110']} disabled={repoDialog.busy || (clone ? !!cloneUrlError(repoDialog.url) : !repoDialog.name.trim())}>
					{clone ? (repoDialog.busy ? t('legacyWorkbench.repoDialog.cloning') : 'Clone') : repoDialog.busy ? t('legacyWorkbench.repoDialog.creating') : t('legacyWorkbench.repoDialog.create')}
				</button>
			</div>
		</form>
	</div>
{/if}
