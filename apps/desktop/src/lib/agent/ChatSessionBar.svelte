<script lang="ts">
	// The row under the chat input (VS Code's secondary chat toolbar): the session target picker (the
	// agent that runs the chat: Arkai, Claude Code, Codex, ACP agents) and the permission picker (how
	// tools are approved in Agent mode). Each opens a ComposerMenu above it.
	import type { IconName } from '#lib/workbench/Icon.svelte';
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { codiconOf } from './chatIcons.ts';
	import { t } from '#lib/i18n/index.ts';
	import ComposerMenu from './ComposerMenu.svelte';
	import type { MenuRow } from './composerMenu.ts';

	type Picker = { label: string; icon: IconName; title: string; rows: MenuRow[]; onpick: (id: string) => void; disabled?: boolean; warn?: boolean };

	let { target, permission, onclose }: { target: Picker | null; permission: Picker | null; /** A menu closed (`refocus`: from the keyboard). */ onclose: (refocus: boolean) => void } = $props();

	let open = $state<'target' | 'permission' | null>(null);
	const BTN =
		'flex h-[22px] min-w-0 items-center gap-1 rounded-[4px] px-1.5 text-[12px] text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:opacity-50 disabled:hover:bg-transparent';

	function close(refocus: boolean) {
		open = null;
		onclose(refocus);
	}
</script>

{#snippet picker(which: 'target' | 'permission', p: Picker, aria: string)}
	<div class="relative flex min-w-0">
		<button
			type="button"
			class={[BTN, p.warn && 'text-(--vscode-editorWarning-foreground) hover:text-(--vscode-editorWarning-foreground)']}
			aria-label={aria}
			title={p.title}
			aria-haspopup="listbox"
			aria-expanded={open === which}
			disabled={p.disabled}
			onclick={() => (open = open === which ? null : which)}
		>
			<Codicon id={codiconOf(p.icon)} size={13} />
			<span class="truncate">{p.label}</span>
		</button>
		{#if open === which}
			<ComposerMenu rows={p.rows} label={aria} width={which === 'permission' ? 280 : 220} onpick={(id) => (close(true), p.onpick(id))} onclose={close} />
		{/if}
	</div>
{/snippet}

{#if target || permission}
	<div class="flex min-h-[26px] min-w-0 items-center gap-0.5 px-0.5 pt-1">
		{#if target}{@render picker('target', target, t('chatWelcome.target.label', { name: target.label }))}{/if}
		{#if permission}{@render picker('permission', permission, t('chatWelcome.permissions.label', { label: permission.label }))}{/if}
	</div>
{/if}
