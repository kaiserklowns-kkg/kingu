<script lang="ts">
	// The row under the chat input (VS Code's `.chat-secondary-toolbar`): the session target picker
	// (sessionTargetPickerActionItem: the agent that runs the chat, Arkai, Claude Code, Codex, ACP
	// agents) and the permission picker (permissionPickerActionItem: how tools are approved in
	// Agent mode, "Manual permissions"). Each opens a ComposerMenu above it. kingu-old also shows
	// Allow Remote Connections (radio-tower) here; Kingu has no remote tunnel to share yet.
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import ComposerMenu from './ComposerMenu.svelte';
	import type { MenuRow } from './composerMenu.ts';

	/** `icon`: a product icon id. */
	type Picker = { label: string; icon: string; title: string; rows: MenuRow[]; onpick: (id: string) => void; disabled?: boolean; warn?: boolean };

	let { target, permission, onclose }: { target: Picker | null; permission: Picker | null; /** A menu closed (`refocus`: from the keyboard). */ onclose: (refocus: boolean) => void } = $props();

	let open = $state<'target' | 'permission' | null>(null);

	function close(refocus: boolean) {
		open = null;
		onclose(refocus);
	}
</script>

{#snippet picker(which: 'target' | 'permission', p: Picker, aria: string)}
	<div class="chat-input-picker-item relative flex min-w-0">
		<button
			type="button"
			class={['action-label', p.warn && 'warning']}
			aria-label={aria}
			title={p.title}
			aria-haspopup="listbox"
			aria-expanded={open === which}
			disabled={p.disabled}
			onclick={() => (open = open === which ? null : which)}
		>
			<Codicon id={p.icon} />
			<span class="chat-input-picker-label">{p.label}</span>
		</button>
		{#if open === which}
			<ComposerMenu rows={p.rows} label={aria} width={which === 'permission' ? 280 : 220} onpick={(id) => (close(true), p.onpick(id))} onclose={close} />
		{/if}
	</div>
{/snippet}

{#if target || permission}
	<div class="chat-secondary-toolbar">
		<div class="chat-responsive-picker-container">
			{#if target}{@render picker('target', target, t('chatWelcome.target.label', { name: target.label }))}{/if}
			{#if permission}{@render picker('permission', permission, t('chatWelcome.permissions.picker', { label: permission.label }))}{/if}
		</div>
	</div>
{/if}
