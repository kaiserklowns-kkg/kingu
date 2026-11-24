<script lang="ts">
	// Settings › Agents, under an agent Kingu can install itself: what runs now ("Uses the copy
	// found on this computer", "Installed by Kingu · 1.2.3", "Not installed. 54 MB download."),
	// Install / Update / Cancel with the download's progress, and Remove for Kingu's copy (Orca's
	// ManagedRuntimeInstallRow). Draws nothing for any other agent.
	import { untrack } from 'svelte';
	import { ask } from '#lib/workbench/messageBox.ts';
	import { t } from '#lib/i18n/index.ts';
	import { isRunning, settingsView, type ManagedAction } from './managedCli.ts';
	import { managedCli } from './managedCli.svelte.ts';

	let {
		agent,
		title,
		hint,
		onchanged
	}: {
		agent: string;
		/** Names the install when it is not the agent's own program (Antigravity's ACP server). */
		title?: string;
		hint?: string;
		/** An install or a removal settled. */ onchanged?: () => void;
	} = $props();

	const status = $derived(managedCli.of(agent));
	let pending = $state(false);
	let cancelling = $state<number | null>(null);
	let refusal = $state<string | null>(null);
	const view = $derived(status ? settingsView(status, cancelling !== null && status.operation?.id === cancelling) : null);

	// The latest release (its version and size) is looked up once the row shows.
	let looked = false;
	$effect(() => {
		if (!status || looked) return;
		looked = true;
		untrack(() => void managedCli.look(agent));
	});

	let wasRunning = false;
	$effect(() => {
		const running = isRunning(status);
		if (wasRunning && !running) untrack(() => onchanged?.());
		wasRunning = running;
	});

	async function run(work: () => Promise<void>) {
		pending = true;
		refusal = null;
		try {
			await work();
		} catch (e) {
			refusal = t('managedCli.actionFailed', { error: e instanceof Error ? e.message : String(e) });
			cancelling = null;
		} finally {
			pending = false;
		}
	}

	const act = (action: ManagedAction) =>
		run(async () => {
			if (action.kind === 'install') return managedCli.install(agent);
			cancelling = action.operation;
			await managedCli.cancel(agent, action.operation);
		});

	async function remove() {
		if (!status || !(await ask(t('managedCli.removeConfirm', { agent: status.label }), { title: `${t('managedCli.removeDetail')} ${t('managedCli.removeRunning', { agent: status.label })}`, kind: 'warning', okLabel: t('managedCli.remove') }))) return;
		await run(async () => {
			await managedCli.remove(agent);
			onchanged?.();
		});
	}

	const BTN = 'inline-flex h-6 items-center rounded-md border border-(--vscode-widget-border) px-2 text-[11px] hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50';
</script>

{#if status && view}
	<!-- Orca 4f56f7c0e: a plain status truncates to one line; one that explains a problem or counts
	     a download wraps whole, and the bar (which starts small and grows) or Cancel moves under it
	     rather than squeezing it. Cancel and Remove never shrink. -->
	<div class={['mt-2 flex min-w-0 items-center gap-x-2 gap-y-1 pl-10 text-[11px] text-(--vscode-descriptionForeground) tabular-nums', (view.wraps || view.progress !== null || view.error || refusal) && 'flex-wrap']} data-managed-cli={agent}>
		{#if title}<span class="shrink-0 font-medium text-(--vscode-foreground)" title={hint}>{title}</span>{/if}
		{#if view.status}
			<span role="status" aria-live="polite" class="flex min-w-0 items-center gap-1.5" title={view.spokenStatus ?? view.status}>
				{#if view.busy}<span class="inline-block size-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent" aria-hidden="true"></span>{/if}
				{#if view.spokenStatus}
					<span aria-hidden="true" class={['min-w-0', !view.wraps && 'truncate']}>{view.status}</span><span class="sr-only">{view.spokenStatus}</span>
				{:else}
					<span class={['min-w-0', view.wraps ? 'break-words' : 'truncate']}>{view.status}</span>
				{/if}
			</span>
		{/if}
		{#if view.progress !== null}
			<span class="h-1 max-w-44 min-w-0 grow basis-16 overflow-hidden rounded-full bg-(--vscode-widget-border)" role="progressbar" aria-label={t('managedCli.progress', { agent: status.label })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(view.progress)}>
				<span class="block h-full bg-(--vscode-progressBar-background)" style:width={`${view.progress}%`}></span>
			</span>
		{/if}
		{#if view.action}
			{@const action = view.action}
			<button type="button" class={[BTN, 'shrink-0 whitespace-nowrap']} disabled={pending || (action.kind === 'cancel' && cancelling === action.operation)} onclick={() => void act(action)}>{action.label}</button>
		{/if}
		{#if view.removable}<button type="button" class={[BTN, 'shrink-0 whitespace-nowrap']} disabled={pending} onclick={() => void remove()}>{t('managedCli.remove')}</button>{/if}
		{#if view.error || refusal}<span role="alert" class="basis-full break-words text-(--vscode-errorForeground)">{refusal ?? view.error}</span>{/if}
	</div>
{/if}
