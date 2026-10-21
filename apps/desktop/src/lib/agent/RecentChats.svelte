<script lang="ts">
	// Recent agent chats on the empty editor area (VS Code's welcome agent sessions): the folder's
	// newest chats with their status, agent and when they were last active; a click opens the chat.
	// More… is Agent: Show Chats.
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { timeAgo } from '#lib/ade/model.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { chats } from './chats.svelte.ts';
	import { chatHistory, STATUS_KEY } from './chatHistory.svelte.ts';
	import { openChat } from './chatCommands.svelte.ts';
	import { runtimeOf } from './runtimes.ts';

	let { max = 5 }: { max?: number } = $props();

	const recent = $derived(workspace.root ? chats.sorted.slice(0, max) : []);
	const DOT = { working: 'bg-(--vscode-editorInfo-foreground) animate-pulse', needsInput: 'bg-(--vscode-editorWarning-foreground)', failed: 'bg-(--vscode-errorForeground)', idle: 'bg-(--vscode-descriptionForeground) opacity-40' } as const;
</script>

{#if recent.length}
	<section class="w-[360px] max-w-full" aria-label={t('chatHistory.recent.title')}>
		<div class="mb-1 flex items-center px-2 text-[11px] font-medium text-(--vscode-descriptionForeground) uppercase">
			<span class="flex-1">{t('chatHistory.recent.title')}</span>
			{#if chats.visible.length > max}
				<button class="text-(--vscode-textLink-foreground) normal-case hover:underline" onclick={() => chatHistory.showChats()}>{t('chatHistory.recent.more')}</button>
			{/if}
		</div>
		<ul>
			{#each recent as c (c.id)}
				{@const s = chatHistory.statusOf(c.id)}
				<li>
					<button class="flex h-[26px] w-full items-center gap-2 rounded px-2 text-left text-[13px] hover:bg-(--vscode-list-hoverBackground)" title={c.title} onclick={() => openChat(c.id)}>
						<span class="shrink-0 text-(--vscode-descriptionForeground)"><Icon name="chat" size={13} /></span>
						<span class="min-w-0 flex-1 truncate text-(--vscode-foreground)">{c.title}</span>
						<span class="shrink-0 truncate text-xs text-(--vscode-descriptionForeground)">{c.agent ?? chatHistory.runtimeName(runtimeOf(c))} · {timeAgo(c.updated_at || c.created_at, Date.now())}</span>
						<span class={['size-2 shrink-0 rounded-full', DOT[s]]} title={t(STATUS_KEY[s])}></span>
					</button>
				</li>
			{/each}
		</ul>
	</section>
{/if}
