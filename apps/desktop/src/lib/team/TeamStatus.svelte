<script lang="ts">
	// Status bar item "ทีม ✓ / ทีม: ออฟไลน์" plus the "Kingu: Sign in to Team Server" dialog.
	// The token is typed into a password field and handed to Rust (Keychain); it is never kept here.
	import { onMount } from 'svelte';
	import { team } from './team.svelte';
	import { t } from '#lib/i18n/index.ts';

	let dialog: HTMLDialogElement | undefined = $state();
	let token = $state('');
	let error = $state('');
	let busy = $state(false);

	onMount(() => team.install());

	// Live updates run exactly while signed in to the configured server; Rust stops them on a 401
	// and reports signed_in = false, which lands here as a stop.
	$effect(() => team.syncStream(team.serverUrl && team.status?.signed_in ? team.status.server : ''));

	// Re-read status when the server URL setting changes.
	$effect(() => {
		void team.serverUrl;
		void team.refresh();
	});

	$effect(() => {
		if (!dialog) return;
		if (team.signingIn && !dialog.open) {
			token = '';
			error = '';
			dialog.showModal();
		} else if (!team.signingIn && dialog.open) dialog.close();
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		try {
			await team.signIn(token);
			team.signingIn = false;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			token = '';
			busy = false;
		}
	}
</script>

{#if team.label}
	<button
		class={['flex h-full items-center px-2 hover:bg-(--vscode-toolbar-hoverBackground)', team.label.warn ? 'text-(--vscode-editorWarning-foreground)' : '']}
		title={team.label.tooltip}
		aria-label={`${team.label.text}. ${team.label.tooltip}`}
		onclick={() => team.showMenu()}>{team.label.text}</button
	>
{/if}

<dialog
	bind:this={dialog}
	aria-labelledby="kg-team-signin-title"
	onclose={() => (team.signingIn = false)}
	class="m-auto w-[min(480px,90vw)] rounded-md border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) p-4 text-(--vscode-quickInput-foreground) shadow-[0_0_8px_2px_rgba(0,0,0,0.36)] backdrop:bg-black/40"
>
	<form onsubmit={submit} class="flex flex-col gap-3 text-[13px]">
		<h2 id="kg-team-signin-title" class="text-sm font-semibold">{t('legacySettings.teamStatus.title')}</h2>
		<p class="text-(--vscode-descriptionForeground)">
			{t('legacySettings.teamStatus.tokenHint', { server: team.serverUrl })}
		</p>
		<label class="flex flex-col gap-1">
			<span>Token</span>
			<input
				type="password"
				bind:value={token}
				autocomplete="off"
				spellcheck="false"
				required
				placeholder="kgu_…"
				aria-invalid={error ? 'true' : undefined}
				aria-describedby={error ? 'kg-team-signin-error' : undefined}
				class="h-[26px] rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 font-mono text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
			/>
		</label>
		{#if error}<p id="kg-team-signin-error" role="alert" class="text-(--vscode-errorForeground)">{error}</p>{/if}
		<div class="flex justify-end gap-2">
			<button type="button" class="rounded-sm px-3 py-1 hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => (team.signingIn = false)}>{t('common.cancel')}</button>
			<button type="submit" disabled={busy || !token.trim()} class="rounded-sm bg-(--vscode-button-background) px-3 py-1 text-(--vscode-button-foreground) disabled:opacity-50"
				>{busy ? t('legacySettings.teamStatus.checking') : t('legacySettings.teamStatus.signIn')}</button
			>
		</div>
	</form>
</dialog>
