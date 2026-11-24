<script lang="ts">
	// Above the composer while the chat's agent waits for a sign-in (its `sign_in` event): "Sign in
	// to Antigravity" with Sign in with Google — the agent runs Google's sign-in itself and the card
	// shows the page to open — or, for agy, its own login in a Kingu terminal (Orca's
	// NativeChatAntigravityAuth). Kingu never sees the password or the token. On Kingu's Antigravity
	// server the card also offers the credentials this computer already has (AgyAuthChooser.svelte).
	import Codicon from '#lib/workbench/Codicon.svelte';
	import AgentIcon from './AgentIcon.svelte';
	import AgyAuthChooser from './AgyAuthChooser.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { openUrl } from '#lib/terminal/pty.ts';
	import { terminals } from '#lib/terminal/terminals.svelte.ts';
	import { layout } from '#lib/workbench/layout.svelte.ts';
	import { status as statusBar } from '#lib/workbench/status.svelte.ts';
	import { chats } from './chats.svelte.ts';
	import { signInCard, type SignInAction } from './agentSignIn.ts';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import type { SignInEvent } from './events.ts';

	let { chatId, event, agent }: { chatId: string; event: SignInEvent; agent: string } = $props();

	const card = $derived(signInCard(event));
	let pending = $state(false);

	async function act(action: SignInAction) {
		switch (action.kind) {
			case 'open':
				return void openUrl(action.url);
			case 'copy':
				await navigator.clipboard.writeText(action.url).catch(() => {});
				return statusBar.flash(t('managedCli.signIn.copied'), 4000);
			case 'terminal':
				terminals.open({ title: t('managedCli.signIn.terminalTitle', { agent: event.agent }), run: action.run });
				return layout.showPanel('terminal');
			case 'settings':
				systemSettings.showAccounts();
				return void setTimeout(() => document.getElementById('accounts-antigravity')?.scrollIntoView({ block: 'start' }), 50);
			case 'sign_in':
				pending = true;
				try {
					await chats.signIn(chatId);
				} finally {
					pending = false;
				}
		}
	}
</script>

<div class="flex items-start gap-3 rounded-[8px] border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) px-3 py-2 text-xs" data-sign-in={event.state} data-via={event.via}>
	<div class={['grid size-7 shrink-0 place-items-center rounded-md border', card.error ? 'border-(--vscode-errorForeground)/50' : 'border-(--vscode-widget-border)']}>
		<AgentIcon {agent} size={16} />
	</div>
	<div class="min-w-0 flex-1">
		<p class="font-semibold">{card.title}</p>
		{#if card.body}<p class="text-(--vscode-descriptionForeground)">{card.body}</p>{/if}
		{#if card.status}
			<p role="status" aria-live="polite" class="flex items-center gap-1.5 text-(--vscode-descriptionForeground)">
				{#if card.busy}<Codicon id="loading" size={12} class="animate-spin" />{/if}{card.status}
			</p>
		{/if}
		{#if card.error}<p role="alert" class="mt-0.5 break-words text-(--vscode-errorForeground)">{card.error}</p>{/if}
		{#if card.actions.length}
			<div class="mt-1.5 flex flex-wrap gap-1.5">
				{#each card.actions as action (action.kind)}
					<button
						type="button"
						class={[
							'inline-flex h-6 items-center gap-1 rounded-md px-2 disabled:opacity-50',
							action.primary ? 'bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)' : 'border border-(--vscode-widget-border) hover:bg-(--vscode-toolbar-hoverBackground)'
						]}
						disabled={pending && action.kind === 'sign_in'}
						onclick={() => void act(action)}
					>
						{#if action.kind === 'open'}<Codicon id="link-external" size={12} />{:else if action.kind === 'terminal'}<Codicon id="terminal" size={12} />{:else if action.kind === 'copy'}<Codicon id="copy" size={12} />{:else if action.kind === 'settings'}<Codicon id="settings-gear" size={12} />{/if}
						{action.label}
					</button>
				{/each}
			</div>
		{/if}
		{#if event.via === 'browser' && !card.busy}
			<AgyAuthChooser {chatId} method={event.method ?? 'oauth-personal'} hasSettings={card.actions.some((a) => a.kind === 'settings')} />
		{/if}
	</div>
</div>
