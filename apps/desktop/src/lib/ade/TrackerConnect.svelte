<script lang="ts">
	// "GitLab: Connect…" and "Jira: Connect…": the token is typed into a password field and handed
	// to Rust, which checks it with the tracker and keeps it in the Keychain; it is never kept here.
	import { t } from '#lib/i18n/index.ts';
	import { sources } from './taskSources.svelte.ts';
	import { gitlabHost } from './trackerApi.ts';

	let dialog: HTMLDialogElement | undefined = $state();
	let host = $state('');
	let site = $state('');
	let email = $state('');
	let token = $state('');
	let error = $state('');
	let busy = $state(false);
	const kind = $derived(sources.connecting);

	$effect(() => {
		if (!dialog) return;
		if (sources.connecting && !dialog.open) {
			host = gitlabHost();
			token = '';
			error = '';
			dialog.showModal();
		} else if (!sources.connecting && dialog.open) dialog.close();
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		try {
			if (kind === 'gitlab') await sources.connectGitlab(host, token);
			else await sources.connectJira(site, email, token);
			sources.connecting = null;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			token = '';
			busy = false;
		}
	}

	const INPUT = 'h-[26px] rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)';
	const ready = $derived(!!token.trim() && (kind === 'gitlab' ? !!host.trim() : !!site.trim() && !!email.trim()));
</script>

<dialog
	bind:this={dialog}
	aria-labelledby="kg-tracker-connect-title"
	onclose={() => (sources.connecting = null)}
	class="m-auto w-[min(480px,90vw)] rounded-md border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) p-4 text-(--vscode-quickInput-foreground) shadow-[0_0_8px_2px_rgba(0,0,0,0.36)] backdrop:bg-black/40"
>
	<form onsubmit={submit} class="flex flex-col gap-3 text-[13px]">
		<h2 id="kg-tracker-connect-title" class="text-sm font-semibold">{kind === 'gitlab' ? t('adeSources.connect.gitlabTitle') : t('adeSources.connect.jiraTitle')}</h2>
		<p class="text-(--vscode-descriptionForeground)">{kind === 'gitlab' ? t('adeSources.connect.gitlabHelp') : t('adeSources.connect.jiraHelp')}</p>
		{#if kind === 'gitlab'}
			<label class="flex flex-col gap-1">
				<span>{t('adeSources.connect.host')}</span>
				<input class={INPUT} bind:value={host} autocomplete="off" spellcheck="false" required placeholder="gitlab.com" />
			</label>
		{:else}
			<label class="flex flex-col gap-1">
				<span>{t('adeSources.connect.site')}</span>
				<input class={INPUT} bind:value={site} autocomplete="off" spellcheck="false" required placeholder="https://your-team.atlassian.net" />
			</label>
			<label class="flex flex-col gap-1">
				<span>{t('adeSources.connect.email')}</span>
				<input class={INPUT} type="email" bind:value={email} autocomplete="off" spellcheck="false" required />
			</label>
		{/if}
		<label class="flex flex-col gap-1">
			<span>{kind === 'gitlab' ? t('adeSources.connect.gitlabToken') : t('adeSources.connect.jiraToken')}</span>
			<input
				type="password"
				bind:value={token}
				autocomplete="off"
				spellcheck="false"
				required
				placeholder={kind === 'gitlab' ? 'glpat-…' : 'ATATT…'}
				aria-invalid={error ? 'true' : undefined}
				aria-describedby={error ? 'kg-tracker-connect-error' : undefined}
				class={[INPUT, 'font-mono']}
			/>
		</label>
		{#if error}<p id="kg-tracker-connect-error" role="alert" class="text-(--vscode-errorForeground)">{error}</p>{/if}
		<div class="flex justify-end gap-2">
			<button type="button" class="rounded-sm px-3 py-1 hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => (sources.connecting = null)}>{t('common.cancel')}</button>
			<button type="submit" disabled={busy || !ready} class="rounded-sm bg-(--vscode-button-background) px-3 py-1 text-(--vscode-button-foreground) disabled:opacity-50"
				>{busy ? t('adeSources.connect.checking') : t('adeSources.connect.submit')}</button
			>
		</div>
	</form>
</dialog>
