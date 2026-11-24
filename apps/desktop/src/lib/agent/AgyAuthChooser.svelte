<script lang="ts">
	// Inside the sign-in card of a chat on Kingu's Antigravity server (Orca `04c88e0df`
	// NativeChatAntigravityAuthChooser in NativeChatSignInStrip): the credentials this computer
	// already has, each one click — "Use your Gemini API key" (found in GEMINI_API_KEY, or saved in
	// Kingu), "Use gcloud (<project>)", "Use your Google sign-in" — then Google sign-in and Settings
	// for everything else. A switch saves the account type, restarts the chat and sends its request again.
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { alternativeHint, alternativeLabel, chatAuthAlternatives, type AgyMethod } from '#lib/accounts/antigravityChatAuth.ts';
	import { agyChatAuth } from './agyChatAuth.svelte.ts';

	let {
		chatId,
		method,
		hasSettings
	}: {
		chatId: string;
		/** The account type the waiting run signs in with. */
		method: string;
		/** The card already offers Settings (a key or gcloud account). */
		hasSettings: boolean;
	} = $props();

	$effect(() => void agyChatAuth.refresh());

	const alternatives = $derived(chatAuthAlternatives(agyChatAuth.detection));
	const busy = $derived(agyChatAuth.switching !== null);
	const ICON: Record<AgyMethod, string> = { 'gemini-api-key': 'key', 'agent-platform': 'cloud', 'oauth-personal': 'account' };
	const BTN = 'inline-flex items-center gap-1 rounded-md px-2 disabled:opacity-50';
	const PRIMARY = 'bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)';
	const SECONDARY = 'border border-(--vscode-widget-border) hover:bg-(--vscode-toolbar-hoverBackground)';
</script>

{#if alternatives.length || method !== 'oauth-personal' || !hasSettings}
	<div class="mt-2 space-y-1.5" data-antigravity-auth-chooser="">
		{#if alternatives.length}
			<p class="text-(--vscode-descriptionForeground)">{t('agentAccounts.chat.foundLead')}</p>
			<div class="flex flex-wrap gap-1.5">
				{#each alternatives as option, i (option.method)}
					<button type="button" class={[BTN, 'min-h-9 flex-col items-start py-1 text-left', i === 0 ? PRIMARY : SECONDARY]} disabled={busy} title={alternativeHint(option)} onclick={() => void agyChatAuth.switchTo(option.method, chatId)}>
						<span class="flex items-center gap-1 font-medium">
							{#if agyChatAuth.switching === option.method}<Codicon id="loading" size={12} class="animate-spin" />{:else}<Codicon id={ICON[option.method]} size={12} />{/if}
							{alternativeLabel(option)}
						</span>
						<span class={['text-[11px]', i === 0 ? 'opacity-80' : 'text-(--vscode-descriptionForeground)']}>{alternativeHint(option)}</span>
					</button>
				{/each}
			</div>
		{/if}
		<div class="flex flex-wrap items-center gap-1.5">
			{#if method !== 'oauth-personal'}
				<button type="button" class={[BTN, 'h-6', SECONDARY]} disabled={busy} onclick={() => void agyChatAuth.switchTo('oauth-personal', chatId)}>{t('agentAccounts.chat.signInGoogle')}</button>
			{/if}
			{#if !hasSettings}
				<button type="button" class="h-6 px-1 text-(--vscode-textLink-foreground) hover:underline" onclick={() => agyChatAuth.openSettings()}>
					{alternatives.length ? t('agentAccounts.chat.moreOptions') : t('agentAccounts.chat.useKeyOrGcloud')}
				</button>
			{/if}
		</div>
	</div>
{/if}
