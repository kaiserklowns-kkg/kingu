<script lang="ts">
	// Settings › Accounts › Antigravity: how chats on Kingu's ACP server sign in (Orca's
	// AntigravityChatAuthForm, AntigravityChatAuthMethodItems, AntigravityChatApiKeyField,
	// AntigravityChatGcpFields). The account type is `kingu.agent.antigravityChatAuth`; a pasted
	// Gemini API key goes straight to the macOS Keychain (agent/antigravity_auth.rs) and is never
	// read back here. Agent Platform shows the project and ADC file Kingu would use.
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '#lib/workbench/Icon.svelte';
	import { openUrl } from '#lib/terminal/pty.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import { status as statusBar } from '#lib/workbench/status.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { terminals } from '#lib/terminal/terminals.svelte.ts';
	import { layout } from '#lib/workbench/layout.svelte.ts';
	import { GCLOUD_ADC_LOGIN } from '#lib/agent/agentSignIn.ts';
	import { AGY_METHODS, chatAuthValue, projectLine, readChatAuth, type AgyAuthStatus, type AgyMethod } from './antigravityChatAuth.ts';

	const SETTING = 'kingu.agent.antigravityChatAuth';
	const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

	let st = $state<AgyAuthStatus | null>(null);
	let loadError = $state('');
	let key = $state('');
	let busy = $state(false);
	let keyError = $state('');

	async function load() {
		try {
			st = await invoke<AgyAuthStatus>('antigravity_chat_auth_status');
			loadError = st.error ?? '';
		} catch (e) {
			loadError = message(e);
		}
	}
	$effect(() => void load());

	const auth = $derived(readChatAuth(settings.get(SETTING)));

	async function write(next: { method: AgyMethod; gcpProject?: string; gcpLocation?: string }) {
		try {
			await settings.set(SETTING, chatAuthValue(next), 'user');
			await load();
		} catch (e) {
			notifications.error(message(e));
		}
	}

	async function saveKey() {
		busy = true;
		keyError = '';
		try {
			await invoke('antigravity_api_key_save', { key });
			key = '';
			statusBar.flash(t('agentAccounts.agy.keySavedToast'), 3000);
		} catch (e) {
			keyError = message(e);
		} finally {
			busy = false;
			await load();
		}
	}

	async function clearKey() {
		busy = true;
		try {
			await invoke('antigravity_api_key_clear');
		} catch (e) {
			keyError = message(e);
		} finally {
			busy = false;
			await load();
		}
	}

	function gcloudLogin() {
		terminals.open({ title: t('agentAccounts.signIn.gcloudTitle'), run: GCLOUD_ADC_LOGIN });
		layout.showPanel('terminal');
	}

	const BUTTON = 'inline-flex h-6 items-center gap-1.5 rounded-md border border-(--vscode-widget-border) px-2 text-xs hover:bg-(--vscode-list-hoverBackground) disabled:opacity-50';
	const INPUT = 'h-7 min-w-0 flex-1 rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 text-xs text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)';
	const MUTED = 'text-xs text-(--vscode-descriptionForeground)';
</script>

<div class="space-y-3 rounded-md border border-(--vscode-widget-border) px-3 py-2.5" data-testid="antigravity-chat-auth">
	<div class="space-y-1">
		<div class="text-[13px] font-medium">{t('agentAccounts.agy.signInWith')}</div>
		<p class={MUTED}>{t('agentAccounts.agy.signInWithHint')}</p>
	</div>
	<div role="radiogroup" aria-label={t('agentAccounts.agy.signInWith')} class="grid gap-1.5 sm:grid-cols-3">
		{#each AGY_METHODS as m (m.id)}
			<button
				type="button"
				role="radio"
				aria-checked={auth.method === m.id}
				data-method={m.id}
				class={['rounded-md border px-2.5 py-2 text-left text-xs', auth.method === m.id ? 'border-(--vscode-focusBorder) bg-(--vscode-list-activeSelectionBackground)/30' : 'border-(--vscode-widget-border) hover:bg-(--vscode-list-hoverBackground)']}
				onclick={() => auth.method !== m.id && void write({ ...auth, method: m.id })}
			>
				<div class="font-medium">{t(m.label)}</div>
				<div class={MUTED}>{t(m.hint)}</div>
			</button>
		{/each}
	</div>
	{#if loadError}<p role="alert" class="text-xs text-(--vscode-errorForeground)">{loadError}</p>{/if}

	{#if auth.method === 'gemini-api-key'}
		<div class="space-y-1.5">
			<div class="flex items-center justify-between gap-2">
				<label for="agy-api-key" class="text-xs font-medium">{t('agentAccounts.agy.keyLabel')}</label>
				<button type="button" class={BUTTON} onclick={() => st && void openUrl(st.getKeyUrl)}>{t('agentAccounts.agy.keyGet')}<Icon name="openExternal" size={12} /></button>
			</div>
			<div class="flex gap-1.5">
				<input id="agy-api-key" type="password" autocomplete="off" spellcheck="false" class={INPUT} placeholder={t('agentAccounts.agy.keyPlaceholder')} bind:value={key} onkeydown={(e) => e.key === 'Enter' && key.trim() && void saveKey()} />
				<button type="button" class={BUTTON} disabled={busy || !key.trim()} onclick={() => void saveKey()}>{st?.apiKeySaved ? t('agentAccounts.agy.keyReplace') : t('agentAccounts.agy.keySave')}</button>
				{#if st?.apiKeySaved}<button type="button" class={BUTTON} disabled={busy} onclick={() => void clearKey()}>{t('agentAccounts.agy.keyRemove')}</button>{/if}
			</div>
			<p class={MUTED} data-testid="agy-key-state">{st?.apiKeySaved ? t('agentAccounts.agy.keySaved') : st?.apiKeyInEnvironment ? t('agentAccounts.agy.keyEnv') : t('agentAccounts.agy.keyNone')}</p>
			{#if keyError}<p role="alert" class="text-xs text-(--vscode-errorForeground)">{keyError}</p>{/if}
		</div>
	{:else if auth.method === 'agent-platform'}
		<div class="grid gap-2 sm:grid-cols-2">
			<label class="space-y-1 text-xs">
				<span class="font-medium">{t('agentAccounts.agy.project')}</span>
				<input class={[INPUT, 'w-full']} placeholder={t('agentAccounts.agy.fromGcloud')} value={auth.gcpProject ?? ''} onchange={(e) => void write({ ...auth, gcpProject: e.currentTarget.value })} />
			</label>
			<label class="space-y-1 text-xs">
				<span class="font-medium">{t('agentAccounts.agy.location')}</span>
				<input class={[INPUT, 'w-full']} placeholder="global" value={auth.gcpLocation ?? ''} onchange={(e) => void write({ ...auth, gcpLocation: e.currentTarget.value })} />
			</label>
		</div>
		<p class={MUTED}>{t('agentAccounts.agy.adcHelp')}</p>
		{#if st}
			{@const ap = st.agentPlatform}
			<div class="space-y-0.5 text-xs" data-testid="agy-adc-state">
				<p class={ap.project ? '' : 'text-(--vscode-errorForeground)'}>{projectLine(ap)}</p>
				<p class={ap.credentialsFound ? MUTED : 'text-(--vscode-errorForeground)'}>{ap.credentialsFound ? t('agentAccounts.agy.credentials', { file: ap.credentialsFile }) : t('agentAccounts.agy.noCredentials', { file: ap.credentialsFile })}</p>
			</div>
		{/if}
		<button type="button" class={BUTTON} onclick={gcloudLogin}><Icon name="terminal" size={12} />{t('agentAccounts.signIn.gcloud')}</button>
	{/if}
</div>
