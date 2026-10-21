<script lang="ts">
	// Above the chat input (VS Code's chatMcpServersStarting / chatMcpAuthenticationContentPart):
	// the chat's MCP servers that are still starting, need a sign-in or failed, as its run last
	// reported them (`mcp_status`, mcpChat.svelte.ts). MCP Servers opens the settings page.
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { mcpChat } from './mcpChat.svelte.ts';

	let { chatId }: { chatId: string } = $props();

	const servers = $derived(mcpChat.status(chatId));
	const starting = $derived(servers.filter((s) => s.status === 'pending').map((s) => s.name));
	const others = $derived(servers.filter((s) => s.status !== 'pending'));
</script>

{#if servers.length}
	<div class="mb-1.5 space-y-0.5 rounded border border-(--vscode-widget-border) px-2 py-1 text-xs" role="status">
		{#if starting.length}
			<div class="flex items-center gap-1.5 text-(--vscode-descriptionForeground)">
				<span class="animate-pulse"><Icon name="ports" size={12} /></span>
				<span class="min-w-0 flex-1 truncate">{t('chatMcp.status.starting', { names: starting.join(', ') })}</span>
			</div>
		{/if}
		{#each others as s (s.name)}
			<div class="flex items-start gap-1.5 text-(--vscode-editorWarning-foreground)">
				<span class="mt-px shrink-0"><Icon name={s.status === 'needs-auth' ? 'lock' : 'warning'} size={12} /></span>
				<span class="min-w-0 flex-1 break-words" title={s.status === 'needs-auth' ? t('chatMcp.status.needsAuthHint') : undefined}>
					{s.status === 'needs-auth' ? t('chatMcp.status.needsAuth', { name: s.name }) : t('chatMcp.status.failed', { name: s.name, error: s.error ?? '' })}
				</span>
				<button class="shrink-0 text-(--vscode-textLink-foreground) hover:underline" onclick={() => systemSettings.showPage('mcp')}>{t('chatMcp.status.open')}</button>
			</div>
		{/each}
	</div>
{/if}
