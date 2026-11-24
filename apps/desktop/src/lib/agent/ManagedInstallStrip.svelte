<script lang="ts">
	// A chat that has messages on an agent this computer no longer has (removed, or the chat came
	// from another machine): the install card slimmed to one line above the composer, so the chat
	// can be continued once it is installed instead of failing at its next start (Orca's
	// NativeChatInstallStrip). Nothing is downloaded before the button is pressed.
	import { untrack } from 'svelte';
	import Codicon from '#lib/workbench/Codicon.svelte';
	import AgentIcon from './AgentIcon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { installCard, servedAgent, type ManagedAction, type ManagedStatus } from './managedCli.ts';
	import { managedCli } from './managedCli.svelte.ts';

	let { status }: { status: ManagedStatus } = $props();

	let pending = $state(false);
	let cancelling = $state<number | null>(null);
	let refusal = $state<string | null>(null);
	const card = $derived(installCard(status, cancelling !== null && status.operation?.id === cancelling, 'strip'));
	const line = $derived(card.progress ? [card.progress.detail, card.progress.percentText].filter(Boolean).join(' · ') : card.detail);

	// What an install would download (version, size, host) is looked up when the strip shows.
	$effect(() => {
		const agent = status.agent;
		untrack(() => void managedCli.look(agent));
	});

	async function act(action: ManagedAction) {
		pending = true;
		refusal = null;
		try {
			if (action.kind === 'install') await managedCli.install(status.agent);
			else {
				cancelling = action.operation;
				await managedCli.cancel(status.agent, action.operation);
			}
		} catch (e) {
			refusal = e instanceof Error ? e.message : String(e);
			cancelling = null;
		} finally {
			pending = false;
		}
	}
</script>

<div class="flex items-center gap-3 rounded-[8px] border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) px-3 py-2 text-xs" data-managed-install="strip" data-tone={card.tone}>
	<div class={['grid size-7 shrink-0 place-items-center rounded-md border', card.tone === 'failed' ? 'border-(--vscode-errorForeground)/50' : 'border-(--vscode-widget-border)']}>
		<AgentIcon agent={servedAgent(status.agent)} size={16} />
	</div>
	<div class="min-w-0 flex-1">
		<p class="font-semibold">{card.title}</p>
		{#if line}<p role="status" aria-live="polite" class={['break-words tabular-nums', card.tone === 'failed' ? 'text-(--vscode-errorForeground)' : 'text-(--vscode-descriptionForeground)']}>{line}</p>{/if}
		{#if card.progress}
			<div
				class="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-(--vscode-widget-border)"
				role="progressbar"
				aria-label={t('managedCli.progress', { agent: status.label })}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={card.progress.percent === null ? undefined : Math.round(card.progress.percent)}
			>
				<div class={['h-full rounded-full bg-(--vscode-progressBar-background)', card.progress.percent === null && 'animate-pulse']} style:width={`${card.progress.percent ?? 100}%`}></div>
			</div>
		{/if}
		{#if refusal}<p role="alert" class="mt-1 break-words text-(--vscode-errorForeground)">{refusal}</p>{/if}
	</div>
	{#if card.action}
		{@const action = card.action}
		<button
			type="button"
			class={[
				'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 disabled:opacity-50',
				action.kind === 'cancel'
					? 'text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)'
					: 'bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)'
			]}
			disabled={pending || (action.kind === 'cancel' && cancelling === action.operation)}
			onclick={() => void act(action)}
		>
			{#if action.kind === 'install' && card.tone === 'offer'}<Codicon id="cloud-download" size={12} />{/if}
			{action.label}
		</button>
	{/if}
</div>
