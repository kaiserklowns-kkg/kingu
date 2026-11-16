<script lang="ts">
	// The side bar's projects on SSH hosts (sshProjects.svelte.ts): a header per project (name and
	// host; collapse, new task, refresh, remove), then its worktrees on the host with branch and git
	// status, each one click from a terminal or the agent CLI running there.
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { projectName } from './projects';
	import { sshProjects as sp } from './sshProjects.svelte';
	import { gitSummary, remoteKey } from './sshProjects';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { cliName } from './agentCli';
	import { adeCommand } from '#lib/agent/launchSpec.ts';

	const MUTED = 'text-(--vscode-descriptionForeground)';
	const REVEAL = 'grid size-5 shrink-0 place-items-center rounded-md text-(--vscode-descriptionForeground) opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)';
	const STATUS_DOT: Record<string, string> = { running: 'bg-sky-400 animate-pulse', waiting: 'bg-amber-400', review: 'bg-[#73C991]', failed: 'bg-red-500' };
	const agentName = $derived(cliName(adeCommand(null, (k) => settings.get(k)) ?? ['claude']));
</script>

{#if sp.list.length}
	<div class="pt-1">
		<div class="flex h-7 items-center gap-1.5 pr-2 pl-2.5">
			<span class="grid size-4 shrink-0 place-items-center rounded-[4px] bg-emerald-500/15 text-emerald-400"><Icon name="desktop" size={11} /></span>
			<span class="truncate text-[11px] leading-none font-semibold tracking-wide uppercase {MUTED}">{t('adeProjects.sshSection')}</span>
			<button class="ml-auto grid size-5 place-items-center rounded-md {MUTED} hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={t('adeProjects.sshAdd')} title={t('adeProjects.sshAdd')} onclick={() => sp.addInteractive()}><Icon name="plus" size={13} /></button>
		</div>
		{#each sp.list as p (remoteKey(p))}
			{@const key = remoteKey(p)}
			{@const host = sp.host(p)}
			{@const listing = sp.listings[key]}
			{@const collapsed = !!sp.collapsed[key]}
			<div class="group/row flex h-7 items-center gap-1 pr-2 pl-3">
				<button class="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={!collapsed} title={`${host?.label ?? p.host}:${p.path}`} onclick={() => sp.toggle(p)}>
					<span class={['grid size-4 place-items-center transition-transform', collapsed && '-rotate-90']}><Icon name="chevronDown" size={12} /></span>
					<span class="truncate text-[12px] font-medium">{projectName(p.path)}</span>
					<span class="truncate text-[11px] {host ? MUTED : 'text-(--vscode-errorForeground)'}">{host?.label ?? t('adeProjects.sshHostMissing')}</span>
				</button>
				{#if host}
					<button class={REVEAL} aria-label={t('adeProjects.sshNewTask', { host: host.label })} title={t('adeProjects.sshNewTask', { host: host.label })} onclick={() => sp.newTask(p)}><Icon name="plus" size={12} /></button>
					<button class={REVEAL} aria-label={t('adeProjects.sshRefresh')} title={t('adeProjects.sshRefresh')} onclick={() => sp.refresh(p)}><Icon name="refresh" size={12} /></button>
				{/if}
				<button class={REVEAL} aria-label={t('adeProjects.remove')} title={t('adeProjects.remove')} onclick={() => sp.remove(p)}><Icon name="trash" size={12} /></button>
			</div>
			{#if !collapsed && host}
				{#if listing?.error}<p class="truncate pr-2 pl-9 text-[11px] text-(--vscode-errorForeground)" title={listing.error}>{listing.error}</p>{/if}
				{#if !listing?.rows && listing?.loading}<p class="pl-9 text-[11px] {MUTED}">{t('adeProjects.sshLoading')}</p>{/if}
				{#each listing?.rows ?? [] as w (w.path)}
					{@const g = gitSummary(w)}
					{@const st = sp.status(p.host, w.path)}
					<div class="group/row flex min-h-7 items-center gap-1 rounded-md pr-2 pl-8 hover:bg-(--vscode-list-hoverBackground)">
						{#if st}<span class="size-2 shrink-0 rounded-full {STATUS_DOT[st] ?? ''}" title={t(`sshRemote.agent.${st}`)}></span>{:else}<Icon name="git" size={12} />{/if}
						<span class="min-w-0 flex-1" title={w.path}>
							<span class="block truncate text-[12px]">{w.path === p.path ? t('adeProjects.sshMain') : (w.slug ?? w.path.split('/').pop())}</span>
							<span class="block truncate font-mono text-[10px] {MUTED}">
								{g.branch}{g.changes === null ? '' : ` · ${g.changes ? t('adeProjects.sshChanges', { count: g.changes }) : t('adeProjects.sshClean')}`}{g.ahead ? ` ↑${g.ahead}` : ''}{g.behind ? ` ↓${g.behind}` : ''}
							</span>
						</span>
						{#if w.path === p.path || w.slug}
						<button class={REVEAL} aria-label={t('sshRemote.openFolder')} title={t('sshRemote.openFolder')} onclick={() => sp.openWorktree(p, w.path)}><Icon name="folder" size={12} /></button>
						<button class={REVEAL} aria-label={t('adeProjects.sshTerminal')} title={t('adeProjects.sshTerminal')} onclick={() => sp.terminal(p, w.path)}><Icon name="terminal" size={12} /></button>
						<button class={REVEAL} aria-label={t('adeProjects.sshAgent', { agent: agentName })} title={t('adeProjects.sshAgent', { agent: agentName })} onclick={() => sp.terminal(p, w.path, true)}><Icon name="agent" size={12} /></button>
						{/if}
						{#if w.slug}
							<button class={REVEAL} aria-label={t('adeProjects.sshRemoveWorktree')} title={t('adeProjects.sshRemoveWorktree')} onclick={() => sp.removeWorktree(p, w)}><Icon name="trash" size={12} /></button>
						{/if}
					</div>
				{/each}
			{/if}
		{/each}
	</div>
{/if}
