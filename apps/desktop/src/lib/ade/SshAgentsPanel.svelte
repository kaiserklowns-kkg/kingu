<script lang="ts">
	// SSH Hosts › Agents: the agent CLIs Kingu can install on this host, each with what runs there
	// now ("Uses the copy found on this host", "Installed by Kingu · 1.2.3", "Not installed. 54 MB
	// download from github.com."), Install / Update / Cancel with the host's download progress, and
	// Remove for Kingu's copy (Orca's ManagedRuntimeInstallRow, for a remote host). Never answers
	// from the missing-agent prompt show here and can be taken back.
	import { ask } from '#lib/workbench/messageBox.ts';
	import { t } from '#lib/i18n/index.ts';
	import type { ManagedAction } from '#lib/agent/managedCli.ts';
	import { hostAgentView } from './sshAgentInstall';
	import { sshAgentInstalls as installs } from './sshAgentInstalls.svelte';

	let { host, label }: { host: string; label: string } = $props();

	const listing = $derived(installs.hosts[host]);
	let pending = $state<Record<string, boolean>>({});
	let cancelling = $state<Record<string, number>>({});
	let refusals = $state<Record<string, string>>({});

	async function run(agent: string, work: () => Promise<unknown>) {
		pending[agent] = true;
		delete refusals[agent];
		try {
			await work();
		} catch (e) {
			refusals[agent] = e instanceof Error ? e.message : String(e);
			delete cancelling[agent];
		} finally {
			delete pending[agent];
		}
	}

	const act = (agent: string, action: ManagedAction) =>
		run(agent, async () => {
			if (action.kind === 'install') return installs.install(host, agent);
			cancelling[agent] = action.operation;
			await installs.cancel(host, agent, action.operation);
		});

	async function remove(agent: string, name: string) {
		if (!(await ask(t('sshAgentInstall.removeConfirm', { agent: name, host: label }), { title: t('sshAgentInstall.removeDetail'), kind: 'warning', okLabel: t('sshAgentInstall.remove') }))) return;
		await run(agent, () => installs.remove(host, agent));
	}

	const MUTED = 'text-(--vscode-descriptionForeground)';
	const BTN = 'inline-flex h-6 items-center rounded-md border border-(--vscode-widget-border) px-2 text-[11px] hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50';
	const LINK = 'text-[11px] text-(--vscode-textLink-foreground) hover:underline disabled:opacity-40';
</script>

<div class="mt-2 ml-4 rounded-md border border-(--vscode-widget-border) px-3 py-2" role="region" aria-label={t('sshAgentInstall.title', { host: label })}>
	<div class="flex items-center gap-2">
		<span class="flex-1 text-[11px] {MUTED}">{t('sshAgentInstall.where')}</span>
		<button class={LINK} disabled={!!installs.checking[host]} onclick={() => void installs.check(host)}>{t('sshAgentInstall.refresh')}</button>
	</div>
	{#if installs.checking[host] && !listing}
		<p class="mt-1 text-[11px] {MUTED}">{t('sshAgentInstall.checking')}</p>
	{:else if installs.errors[host]}
		<p role="alert" class="mt-1 text-[11px] text-(--vscode-errorForeground)">{t('sshAgentInstall.probeFailed', { error: installs.errors[host] })}</p>
	{/if}
	{#if listing}
		{#if listing.platform}<p class="mt-1 font-mono text-[11px] {MUTED}">{t('sshAgentInstall.platform', { platform: listing.build ?? listing.platform })}</p>{/if}
		{#if listing.problem}<p role="alert" class="mt-1 text-[11px] text-(--vscode-errorForeground)">{listing.problem}</p>{/if}
		<ul class="mt-1">
			{#each listing.agents as s (s.agent)}
				{@const view = hostAgentView(s, cancelling[s.agent] !== undefined && s.operation?.id === cancelling[s.agent])}
				{@const never = !installs.mayOffer(host, s.agent)}
				<li class="flex flex-wrap items-center gap-2 py-1 text-[11px]" data-ssh-agent={s.agent}>
					<span class="w-28 shrink-0 truncate text-[12px] text-(--vscode-foreground)" title={s.command}>{s.label}</span>
					{#if view.status}<span role="status" class="{MUTED} min-w-0" title={s.externalPath ?? undefined}>{view.status}</span>{/if}
					{#if view.progress !== null}
						<span class="h-1 w-24 overflow-hidden rounded-full bg-(--vscode-widget-border)" role="progressbar" aria-label={t('sshAgentInstall.progress', { agent: s.label, host: label })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(view.progress)}>
							<span class="block h-full bg-(--vscode-progressBar-background)" style:width={`${view.progress}%`}></span>
						</span>
					{/if}
					<span class="flex-1"></span>
					{#if view.action}
						{@const action = view.action}
						<button type="button" class={BTN} disabled={!!pending[s.agent] || (action.kind === 'cancel' && cancelling[s.agent] === action.operation)} onclick={() => void act(s.agent, action)}>{action.label}</button>
					{/if}
					{#if view.removable}<button type="button" class={BTN} disabled={!!pending[s.agent]} onclick={() => void remove(s.agent, s.label)}>{t('sshAgentInstall.remove')}</button>{/if}
					{#if never}
						<span class="basis-full pl-30 {MUTED}">{t('sshAgentInstall.never')} <button class={LINK} onclick={() => installs.setNever(host, s.agent, false)}>{t('sshAgentInstall.askAgain')}</button></span>
					{/if}
					{#if view.error || refusals[s.agent]}<span role="alert" class="basis-full pl-30 break-words text-(--vscode-errorForeground)">{refusals[s.agent] ?? view.error}</span>{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
