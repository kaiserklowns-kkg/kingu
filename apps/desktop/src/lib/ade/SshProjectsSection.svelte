<script lang="ts">
	// The side bar's projects on SSH hosts (sshProjects.svelte.ts): a header per project (name and
	// host; collapse, new task, refresh, remove), then its worktrees on the host with branch and git
	// status, each one click from a terminal or the agent CLI running there.
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { projectName } from './projects';
	import { sshProjects as sp } from './sshProjects.svelte';
	import { gitSummary, remoteKey } from './sshProjects';
	import { sshConnections } from './sshConnections.svelte';
	import { sshHolders } from './sshHolders.svelte';
	import { holderBusy, type HolderState } from './sshHolder';
	import { MAX_DENY_MESSAGE } from './permissionAsk';
	import { canConnect, connectVerb, statusKey, statusTone } from './sshConnection';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { cliName } from './agentCli';
	import { adeCommand } from '#lib/agent/launchSpec.ts';
	import QuestionCard from '#lib/agent/QuestionCard.svelte';

	const MUTED = 'text-(--vscode-descriptionForeground)';
	const REVEAL = 'grid size-5 shrink-0 place-items-center rounded-md text-(--vscode-descriptionForeground) opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)';
	const STATUS_DOT: Record<string, string> = { running: 'bg-sky-400 animate-pulse', waiting: 'bg-amber-400', review: 'bg-[#73C991]', failed: 'bg-red-500' };
	// Orca `statusColor` (settings/ssh/targets/SshTargetCard.tsx): connected, in progress, failed, idle.
	const TONE: Record<string, string> = { ok: 'bg-[#73C991]', busy: 'bg-yellow-500 animate-pulse', bad: 'bg-red-500', idle: 'bg-(--vscode-descriptionForeground)/40' };
	// Why a host has no terminal holder (its terminals then end with the connection), for the header's note.
	function holderNote(h: HolderState): string | null {
		if (h.phase === 'off') return t('sshRemote.holder.off');
		if (h.phase === 'unsupported') return t('sshRemote.holder.unsupported', { platform: h.platform ?? '' });
		if (h.phase === 'no-artefact') return t('sshRemote.holder.noArtefact', { platform: h.platform ?? '', triple: h.triple ?? '' });
		if (h.phase === 'failed') return t('sshRemote.holder.failed', { error: h.error ?? '' });
		if (h.phase === 'consent') return t('sshRemote.holder.consent');
		if (h.phase === 'declined') return t(h.declined === 'never' ? 'sshRemote.holder.never' : 'sshRemote.holder.later');
		return null;
	}
	const BTN = 'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium hover:bg-(--vscode-toolbar-hoverBackground)';
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
			{@const conn = sshConnections.state(p.host)}
			{@const holder = sshHolders.state(p.host)}
			{@const note = conn.status === 'connected' ? holderNote(holder) : null}
			<div class="group/row flex h-7 items-center gap-1 pr-2 pl-3">
				<button class="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={!collapsed} title={`${host?.label ?? p.host}:${p.path}`} onclick={() => sp.toggle(p)}>
					<span class={['grid size-4 place-items-center transition-transform', collapsed && '-rotate-90']}><Icon name="chevronDown" size={12} /></span>
					<!-- The name keeps some width; the host label and the holder note give way first in a narrow sidebar. -->
					<span class="max-w-[55%] shrink-0 truncate text-[12px] font-medium">{projectName(p.path)}</span>
					<span class="min-w-0 shrink-[2] truncate text-[11px] {host ? MUTED : 'text-(--vscode-errorForeground)'}">{host?.label ?? t('adeProjects.sshHostMissing')}</span>
					{#if host}
						<!-- The host's connection (Orca's SshTargetStatusRow: a dot in the status colour, its label). -->
						<span class="size-1.5 shrink-0 rounded-full {TONE[statusTone(conn.status)]}" role="img" aria-label={t('sshRemote.hostStatus', { host: host.label, status: t(statusKey(conn.status)) })} title={conn.error ? `${t(statusKey(conn.status))}: ${conn.error}` : t(statusKey(conn.status))}></span>
						{#if conn.status !== 'connected'}<span class="shrink-0 text-[10px] {statusTone(conn.status) === 'bad' ? 'text-(--vscode-errorForeground)' : MUTED}">{t(statusKey(conn.status))}</span>{/if}
						<!-- The host's terminal holder being set up (Orca shows its host server's setup phase while connecting), or why there is none. -->
						{#if conn.status === 'connected' && holderBusy(holder)}<span class="shrink-0 text-[10px] {MUTED}">{t(holder.phase === 'installing' ? 'sshRemote.holder.installing' : 'sshRemote.holder.checking')}</span>{/if}
						{#if note}<span class="min-w-0 shrink-[3] truncate text-[10px] {MUTED}" title={note}>{t('sshRemote.holder.short')}</span>{/if}
					{/if}
				</button>
				<!-- Not asked yet, or Not now in this run: the question again, on request (Never is changed in SSH: Hosts…). -->
				{#if host && conn.status === 'connected' && (holder.phase === 'consent' || holder.declined === 'later')}
					<button class="max-w-28 min-w-0 truncate rounded px-1.5 py-0.5 text-[10px] font-medium hover:bg-(--vscode-toolbar-hoverBackground) {MUTED}" title={note ?? t('sshRemote.holder.installButton')} onclick={() => sp.installHolder(p)}>{t('sshRemote.holder.installButton')}</button>
				{/if}
				{#if host && canConnect(conn.status)}
					<button class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium hover:bg-(--vscode-toolbar-hoverBackground)" title={conn.error ?? undefined} onclick={() => sp.connect(p)}>{t(`sshRemote.verb.${connectVerb(conn.status)}`)}</button>
				{/if}
				{#if host}
					<button class={REVEAL} aria-label={t('adeProjects.sshNewTask', { host: host.label })} title={t('adeProjects.sshNewTask', { host: host.label })} onclick={() => sp.newTask(p)}><Icon name="plus" size={12} /></button>
					<button class={REVEAL} aria-label={t('adeProjects.sshRefresh')} title={t('adeProjects.sshRefresh')} onclick={() => sp.refresh(p, true)}><Icon name="refresh" size={12} /></button>
				{/if}
				<button class={REVEAL} aria-label={t('adeProjects.remove')} title={t('adeProjects.remove')} onclick={() => sp.remove(p)}><Icon name="trash" size={12} /></button>
			</div>
			{#if !collapsed && host}
				{#if listing?.error}<p class="truncate pr-2 pl-9 text-[11px] text-(--vscode-errorForeground)" title={listing.error}>{listing.error}</p>{/if}
				{#if !listing?.rows && listing?.loading}<p class="pl-9 text-[11px] {MUTED}">{t('adeProjects.sshLoading')}</p>{/if}
				{#each listing?.rows ?? [] as w (w.path)}
					{@const g = gitSummary(w)}
					{@const st = sp.status(p.host, w.path)}
					{@const link = sp.link(p.host, w.path)}
					<div class={['group/row flex min-h-7 items-center gap-1 rounded-md pr-2 pl-8 hover:bg-(--vscode-list-hoverBackground)', conn.status !== 'connected' && 'opacity-60']}>
						{#if st}<span class="size-2 shrink-0 rounded-full {STATUS_DOT[st] ?? ''}" title={t(`sshRemote.agent.${st}`)}></span>{:else}<Icon name="git" size={12} />{/if}
						<span class="min-w-0 flex-1" title={w.path}>
							<span class="block truncate text-[12px]">{w.path === p.path ? t('adeProjects.sshMain') : (w.slug ?? w.path.split('/').pop())}</span>
							<span class="block truncate font-mono text-[10px] {MUTED}">
								{g.branch}{g.changes === null ? '' : ` · ${g.changes ? t('adeProjects.sshChanges', { count: g.changes }) : t('adeProjects.sshClean')}`}{g.ahead ? ` ↑${g.ahead}` : ''}{g.behind ? ` ↓${g.behind}` : ''}
							</span>
							<!-- Its agents while the host is away: held on the host, to be restarted, or gone. -->
							{#if link}<span class="block truncate text-[10px] {MUTED}" title={t(`sshRemote.link.${link}`)}>{t(`sshRemote.link.${link}`)}</span>{/if}
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
					<!-- What an agent there asks (sshAsks.ts): a permission prompt answered through Kingu's hold on the host or with
					     keys in its terminal, a question answered with its question UI's keys, or expired (the hold ran out, or the
					     connection dropped mid-question), never answered for you. -->
					{#each sp.asks(p.host, w.path) as ask (ask.id)}
						{@const busy = !!sp.answering[ask.id]}
						{#if ask.route === 'expired'}
							<div class="mr-2 mb-1 ml-8 rounded-md border border-(--vscode-widget-border) px-2 py-1 opacity-80" role="status" aria-label={t('sshRemote.ask.expiredTitle', { agent: ask.name })}>
								<p class="truncate text-[11px]">{ask.kind === 'question' ? t('sshRemote.ask.question', { agent: ask.name }) : ask.tool ? t('sshRemote.perm.asks', { agent: ask.name, tool: ask.tool }) : t('sshRemote.perm.asksPlain', { agent: ask.name })}</p>
								{#if ask.detail}<p class="line-clamp-2 font-mono text-[10px] break-all {MUTED}" title={ask.detail}>{ask.detail}</p>{/if}
								<p class="text-[10px] text-(--vscode-editorWarning-foreground)">{t(ask.expired === 'timeout' ? 'sshRemote.ask.expiredTimeout' : 'sshRemote.ask.expiredDisconnected', { host: host.label })}</p>
								{#if ask.expired === 'timeout'}<button class="{BTN} mt-1" onclick={() => sp.showTerminal(ask.id)}>{t('sshRemote.ask.showTerminal')}</button>{/if}
							</div>
						{:else if ask.kind === 'question'}
							<div class="mr-2 mb-1 ml-8 text-[11px]">
								{#if ask.route === 'keys' && ask.ask}
									{#key JSON.stringify(ask.ask)}
										<QuestionCard prompt={ask.ask} submitLabel={t('sshRemote.ask.submit')} note={t('sshRemote.ask.note', { agent: ask.name, host: host.label })} onsubmit={(sels) => sp.answerQuestion(ask.id, sels)} />
									{/key}
								{:else}
									<div class="rounded-md border border-(--vscode-charts-purple,#B180D7)/60 px-2 py-1">
										<p class="truncate">{t('sshRemote.ask.question', { agent: ask.name })}</p>
										<button class="{BTN} mt-1" onclick={() => sp.showTerminal(ask.id)}>{t('sshRemote.ask.showTerminal')}</button>
									</div>
								{/if}
							</div>
						{:else}
							<div class="mr-2 mb-1 ml-8 rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-1" role="alertdialog" aria-label={t('sshRemote.ask.permissionTitle', { agent: ask.name })}>
								<p class="truncate text-[11px]">{ask.tool ? t('sshRemote.perm.asks', { agent: ask.name, tool: ask.tool }) : t('sshRemote.perm.asksPlain', { agent: ask.name })}</p>
								{#if ask.detail}<p class="line-clamp-3 font-mono text-[10px] break-all {MUTED}" title={ask.detail}>{ask.detail}</p>{/if}
								{#if ask.unsandboxed}<p class="text-[10px] text-(--vscode-editorWarning-foreground)">{t('legacyAde.cliQuestion.unsandboxed')}</p>{/if}
								{#if ask.route === 'hold'}
									<!-- A reason sent with Deny, as on the local card (CliQuestion.svelte). -->
									<input class="mt-1 h-5 w-full rounded border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) px-1.5 text-[10px] text-(--vscode-input-foreground)" type="text" maxlength={MAX_DENY_MESSAGE} bind:value={sp.reasons[ask.id]} placeholder={t('sshRemote.perm.denyReason')} aria-label={t('sshRemote.perm.denyReason')} />
								{/if}
								<div class="mt-1 flex flex-wrap items-center gap-1">
									<button class="{BTN} bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)" disabled={busy} onclick={() => sp.answer(ask.id, true)}>{t('sshRemote.perm.allow')}</button>
									{#if ask.grants.length}<button class={BTN} disabled={busy} title={ask.grants.map((g) => g.value).join('\n')} onclick={() => sp.answer(ask.id, true, 'session')}>{t('sshRemote.perm.allowSession')}</button>{/if}
									{#if ask.rules.length}
										<button class={BTN} disabled={busy} title={t('sshRemote.ask.projectFile', { host: host.label, rules: ask.rules.map((g) => g.value).join(', ') })} onclick={() => sp.answer(ask.id, true, 'project')}>{t('sshRemote.ask.allowProject')}</button>
										<button class={BTN} disabled={busy} title={t('sshRemote.ask.userFile', { host: host.label, rules: ask.rules.map((g) => g.value).join(', ') })} onclick={() => sp.answer(ask.id, true, 'user')}>{t('sshRemote.ask.allowUser')}</button>
									{/if}
									<button class={BTN} disabled={busy} onclick={() => sp.answer(ask.id, false)}>{t('sshRemote.perm.deny')}</button>
								</div>
								<p class="mt-0.5 text-[10px] {MUTED}">{t(ask.route === 'hold' ? 'sshRemote.ask.viaHold' : 'sshRemote.ask.viaKeys', { agent: ask.name, host: host.label })}</p>
							</div>
						{/if}
					{/each}
				{/each}
			{/if}
		{/each}
	</div>
{/if}
