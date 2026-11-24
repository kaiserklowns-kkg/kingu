<script lang="ts">
	// An empty chat on an agent this computer lacks: "Install {agent} to start chatting" with what
	// is downloaded, from where, then the download's progress and steps, or why it failed (Orca's
	// NativeChatInstallHero). Nothing is downloaded before the button is pressed.
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
	const card = $derived(installCard(status, cancelling !== null && status.operation?.id === cancelling));

	// What an install would download (version, size, host) is looked up when the card shows, once
	// per agent: the lookup's answer is a new `status`, which must not ask again.
	const agent = $derived(status.agent);
	$effect(() => {
		const a = agent;
		untrack(() => void managedCli.look(a));
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

<div class="flex h-full w-full flex-col items-center justify-center p-6 text-center" data-managed-install={card.tone}>
	<div class="flex w-full max-w-sm flex-col items-center">
		<div class={['grid size-12 place-items-center rounded-xl border', card.tone === 'failed' ? 'border-(--vscode-errorForeground)/50' : 'border-(--vscode-widget-border)']}>
			<AgentIcon agent={servedAgent(status.agent)} size={26} />
		</div>
		<h2 class="mt-4 text-sm font-semibold">{card.title}</h2>
		{#if card.detail}<p class={['mt-1.5 text-sm text-balance', card.tone === 'failed' ? 'text-(--vscode-errorForeground)' : 'text-(--vscode-descriptionForeground)']}>{card.detail}</p>{/if}
		{#if card.progress}
			<div class="mt-3 w-full">
				<div
					class="h-1.5 w-full overflow-hidden rounded-full bg-(--vscode-widget-border)"
					role="progressbar"
					aria-label={t('managedCli.progress', { agent: status.label })}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={card.progress.percent === null ? undefined : Math.round(card.progress.percent)}
				>
					<div class={['h-full rounded-full bg-(--vscode-progressBar-background)', card.progress.percent === null && 'animate-pulse']} style:width={`${card.progress.percent ?? 100}%`}></div>
				</div>
				<div class="mt-2 flex justify-between text-xs text-(--vscode-descriptionForeground) tabular-nums" role="status" aria-live="polite">
					<span>{card.progress.detail}</span>
					<span>{card.progress.percentText ?? ''}</span>
				</div>
			</div>
		{/if}
		{#if card.steps}
			<ol class="mt-3 mb-3 flex justify-center gap-4 text-xs">
				{#each card.steps as step (step.label)}
					<li aria-current={step.state === 'current' ? 'step' : undefined} class={['flex items-center gap-1.5', step.state === 'current' ? 'font-medium' : 'text-(--vscode-descriptionForeground)']}>
						{#if step.state === 'done'}<Codicon id="check" size={12} />{:else}<span class={['size-1.5 rounded-full bg-current', step.state === 'current' ? 'opacity-100' : 'opacity-40']}></span>{/if}
						{step.label}
					</li>
				{/each}
			</ol>
		{/if}
		{#if card.action}
			{@const action = card.action}
			<button
				type="button"
				class={[
					'inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm disabled:opacity-50',
					action.kind === 'cancel'
						? 'mt-1 text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)'
						: 'mt-5 bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)'
				]}
				disabled={pending || (action.kind === 'cancel' && cancelling === action.operation)}
				onclick={() => void act(action)}
			>
				{#if action.kind === 'install'}<Codicon id="cloud-download" size={14} />{/if}
				{action.label}
			</button>
		{/if}
		{#if card.hint}<p class="mt-3 text-xs text-(--vscode-descriptionForeground)">{card.hint}</p>{/if}
		{#if refusal}<p role="alert" class="mt-3 text-xs break-words text-(--vscode-errorForeground)">{refusal}</p>{/if}
	</div>
</div>
