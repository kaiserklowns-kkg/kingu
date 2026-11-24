<script lang="ts">
	// The project pane's GitHub account (Orca's RepositoryGitHubAccountSection): which gh keyring
	// login this project's gh calls use. Rust lists the logins and checks one before it is saved
	// (agent/gh_account.rs); the choice is `kingu.repo.ghAccount` in the repository scope.
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { settings } from '../settings.svelte';
	import { AMBIENT, accountKey, ghOptions, readBinding, suggestion, type GhBinding, type GhInventory, type GhOption } from './githubAccount.ts';

	const SETTING = 'kingu.repo.ghAccount';
	const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

	let inv = $state<GhInventory | null>(null);
	let loading = $state(false);
	let saving = $state(false);
	let error = $state('');
	let generation = 0;

	const bound = $derived(readBinding(settings.inspect(SETTING, 'repo')));
	const options = $derived(ghOptions(inv, bound));
	const suggested = $derived(suggestion(inv, bound));

	async function load(refresh = false) {
		const mine = ++generation;
		loading = true;
		error = '';
		try {
			const next = await invoke<GhInventory>('gh_accounts', { refresh });
			if (mine === generation) inv = next;
		} catch (e) {
			if (mine === generation) (error = message(e)), (inv = null);
		} finally {
			if (mine === generation) loading = false;
		}
	}
	$effect(() => void load());

	async function apply(next: GhBinding | null) {
		if (saving) return;
		saving = true;
		error = '';
		try {
			const checked = next ? await invoke<GhBinding>('gh_account_validate', { host: next.host, user: next.user }) : null;
			await settings.set(SETTING, checked ?? undefined, 'repo');
		} catch (e) {
			error = message(e);
		} finally {
			saving = false;
		}
	}

	function choose(value: string) {
		if (value === AMBIENT) return void (bound && apply(null));
		if (bound && accountKey(bound) === value) return;
		const a = inv?.accounts.find((x) => accountKey(x) === value);
		if (a && a.source === 'keyring') void apply({ host: a.host, user: a.user });
	}

	function label(o: GhOption): string {
		const l = o.label;
		if (l.key === 'ambient') return t('agentAccounts.gh.ambient');
		if (l.key === 'unavailable') return t('agentAccounts.gh.unavailableOption', { user: l.user, host: l.host });
		if (l.key === 'env') return t('agentAccounts.gh.envOption', { user: l.user, host: l.host, token: l.token });
		return `${l.user} @ ${l.host}`;
	}

	const SELECT = 'h-7 w-full rounded-md border border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) px-1.5 text-xs text-(--vscode-dropdown-foreground) outline-none focus:border-(--vscode-focusBorder) disabled:opacity-50';
	const BUTTON = 'inline-flex h-6 items-center gap-1 rounded-md border border-(--vscode-widget-border) px-2 text-xs hover:bg-(--vscode-list-hoverBackground) disabled:opacity-50';
	const MUTED = 'text-xs text-(--vscode-descriptionForeground)';
</script>

<div class="space-y-2 py-3" data-testid="github-account-setting" title={SETTING}>
	<p class={MUTED}>{t('agentAccounts.gh.hint')}</p>
	<div class="flex items-center gap-1">
		<span id="gh-account-label" class={MUTED}>{t('agentAccounts.gh.account')}</span>
		<button type="button" class="grid size-6 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50" aria-label={t('agentAccounts.gh.refresh')} title={t('agentAccounts.gh.refresh')} disabled={loading || saving} onclick={() => void load(true)}>
			<span class={['grid place-items-center', loading && 'animate-spin']}><Icon name="refresh" size={13} /></span>
		</button>
	</div>
	<select class={SELECT} aria-labelledby="gh-account-label" disabled={loading || saving || inv?.installed === false} value={bound ? accountKey(bound) : AMBIENT} onchange={(e) => choose(e.currentTarget.value)}>
		{#each options as o (o.value)}
			<option value={o.value} disabled={o.disabled}>{label(o)}</option>
		{/each}
	</select>
	{#if suggested}
		<div class="flex items-center gap-2 text-xs" data-testid="gh-account-suggestion">
			<span class={MUTED}>{t('agentAccounts.gh.suggested', { user: suggested.user, host: suggested.host })}</span>
			<button type="button" class={BUTTON} disabled={saving} onclick={() => void apply(suggested)}>{t('agentAccounts.gh.useSuggested')}</button>
		</div>
	{/if}
	{#if inv?.installed === false}<p class={MUTED}>{t('agentAccounts.gh.notInstalled')}</p>{/if}
	{#if inv?.capability === 'unsupported'}<p class={MUTED}>{t('agentAccounts.gh.unsupported')}</p>{/if}
	{#if inv?.installed && inv.capability === 'unknown'}<p class={MUTED}>{t('agentAccounts.gh.unknown')}</p>{/if}
	{#if error}<p role="alert" class="text-xs text-(--vscode-errorForeground)">{error}</p>{/if}
</div>
