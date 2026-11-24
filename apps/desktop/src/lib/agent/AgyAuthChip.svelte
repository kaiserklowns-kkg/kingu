<script lang="ts">
	// At the right end of the row under an Antigravity chat's input (Orca `04c88e0df`
	// NativeChatAntigravityAuthChip, in NativeChatComposerWorkspace's footer): how the chat signs in,
	// always in view, with the other methods one click away. "Detected" marks a method this computer
	// already has credentials for; one that needs a key to paste or a project opens Settings. On agy,
	// agy's own login serves the chat; another method applies to new chats.
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import ComposerMenu from './ComposerMenu.svelte';
	import type { MenuRow } from './composerMenu.ts';
	import { chatAuthMenuItems, chipText, methodLabel, type AgyMethod } from '#lib/accounts/antigravityChatAuth.ts';
	import { AGY_CHAT_AUTH_SETTING, agyChatAuth } from './agyChatAuth.svelte.ts';

	let { onAgy }: { /** The chat runs the host's agy, whose own login serves it. */ onAgy: boolean } = $props();

	let open = $state(false);
	const ICON: Record<AgyMethod, string> = { 'oauth-personal': 'account', 'gemini-api-key': 'key', 'agent-platform': 'cloud' };

	// A method saved elsewhere (Settings) changes what's in use and what's detected.
	$effect(() => {
		void JSON.stringify(settings.get(AGY_CHAT_AUTH_SETTING) ?? null);
		void agyChatAuth.refresh();
	});

	const d = $derived(agyChatAuth.detection);
	const text = $derived(chipText(d, onAgy));
	const items = $derived(chatAuthMenuItems(d).filter((i) => !onAgy || i.method !== 'oauth-personal'));
	const rows = $derived<MenuRow[]>([
		...(onAgy ? [{ id: 'agy', label: t('agentAccounts.chat.agyItem'), description: t('agentAccounts.chat.agyHint'), codicon: 'terminal', checked: true, section: t('agentAccounts.chat.menuTitle') }] : []),
		...items.map((i) => ({
			id: i.method,
			label: methodLabel(i.method) + (i.opensSettings ? '…' : ''),
			codicon: ICON[i.method],
			checked: i.active && !onAgy,
			keyLabel: i.detected ? t('agentAccounts.chat.detected') : undefined,
			disabled: agyChatAuth.switching !== null,
			section: t('agentAccounts.chat.menuTitle')
		})),
		{ id: 'settings', label: t('agentAccounts.chat.settings'), codicon: 'settings-gear' }
	]);

	function pick(id: string) {
		open = false;
		if (id === 'agy') return;
		if (id === 'settings') return agyChatAuth.openSettings();
		const item = items.find((i) => i.method === id);
		if (!item || (item.active && !onAgy)) return;
		if (item.opensSettings) agyChatAuth.openSettings();
		else void agyChatAuth.switchTo(item.method);
	}
</script>

{#if text}
	<div class="chat-input-picker-item relative ml-auto flex min-w-0 shrink" data-antigravity-auth-chip="">
		<button
			type="button"
			class="action-label min-w-0"
			aria-label={t('agentAccounts.chat.chipLabel', { method: text })}
			title={t('agentAccounts.chat.chipTitle', { method: text })}
			aria-haspopup="listbox"
			aria-expanded={open}
			onclick={() => {
				open = !open;
				if (open) void agyChatAuth.refresh();
			}}
		>
			{#if agyChatAuth.switching}<Codicon id="loading" class="animate-spin" />{:else}<Codicon id={onAgy || !d?.method ? 'terminal' : ICON[d.method]} />{/if}
			<span class="chat-input-picker-label max-w-56 truncate">{text}</span>
			<Codicon id="chevron-down" size={12} />
		</button>
		{#if open}
			<ComposerMenu {rows} label={t('agentAccounts.chat.menuTitle')} align="right" width={288} onpick={pick} onclose={() => (open = false)} />
		{/if}
	</div>
{/if}
