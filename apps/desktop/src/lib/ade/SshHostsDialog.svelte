<script lang="ts">
	// SSH Hosts (Orca's Settings › SSH): saved machines with Test, Terminal, Forward Port… and
	// Remove, plus the port forwards running now. Import from SSH Config… and Add Host… add more.
	import Icon from '#lib/workbench/Icon.svelte';
	import { sshHosts as ssh } from './sshHosts.svelte';
	import { sshProjects } from './sshProjects.svelte';
	import { t as tr } from '#lib/i18n/index.ts';
	import { sshConnections } from './sshConnections.svelte';
	import { canConnect, connectVerb, statusKey, isConnecting } from './sshConnection';
	import { sshHolders } from './sshHolders.svelte';
	import { sshAgentInstalls } from './sshAgentInstalls.svelte';
	import SshAgentsPanel from './SshAgentsPanel.svelte';

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			ssh.open = false;
		}
	}
	const MUTED = 'text-(--vscode-descriptionForeground)';
	const BTN = 'h-7 rounded-md px-2.5 text-[12px] hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
	const ICON_BTN = 'grid size-6 shrink-0 place-items-center rounded text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)';
</script>

<svelte:window {onkeydown} />

<div class="fixed inset-0 z-[65] grid place-items-center bg-black/40 p-6" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && (ssh.open = false)}>
	<div role="dialog" aria-modal="true" aria-labelledby="kg-ssh-title" class="flex max-h-[80vh] w-full max-w-[760px] flex-col overflow-hidden rounded-xl border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) text-(--vscode-foreground) shadow-2xl shadow-black/50">
		<header class="flex items-center gap-2.5 px-5 pt-5 pb-3">
			<Icon name="desktop" size={18} />
			<h2 id="kg-ssh-title" class="flex-1 text-[14px] font-semibold">SSH Hosts</h2>
			<button class={BTN} onclick={() => ssh.importFromConfig()}>Import from SSH Config…</button>
			<button class={BTN} onclick={() => ssh.add()}>Add Host…</button>
			<button class={ICON_BTN} aria-label="Close" title="Close" onclick={() => (ssh.open = false)}><Icon name="close" size={14} /></button>
		</header>
		<ul class="min-h-0 flex-1 overflow-y-auto border-y border-(--vscode-widget-border) py-1">
			{#each ssh.targets as t (t.id)}
				{@const r = ssh.tests[t.id]}
				{@const fws = ssh.forwards.filter((f) => f.target_id === t.id)}
				{@const panel = ssh.panels[t.id]}
				{@const conn = sshConnections.state(t.id)}
				{@const choice = sshHolders.consent(t.id)}
				<li class="mx-1.5 rounded-md px-3 py-2 hover:bg-(--vscode-list-hoverBackground)/60">
					<div class="flex items-center gap-2">
						<span class={['size-2 shrink-0 rounded-full', r === 'testing' ? 'animate-pulse bg-yellow-500' : r?.success ? 'bg-[#73C991]' : r ? 'bg-red-500' : 'bg-(--vscode-descriptionForeground)/40']}></span>
						<span class="min-w-0 flex-1">
							<span class="block truncate text-[13px]">{t.label}</span>
							<span class="block truncate font-mono text-[11px] {MUTED}">{t.username ? `${t.username}@` : ''}{t.host}{t.port !== 22 ? `:${t.port}` : ''}{t.jump_host ? ` via ${t.jump_host}` : ''}{t.config_host ? ' · ~/.ssh/config' : ''}{conn.status === 'disconnected' ? '' : ` · ${tr(statusKey(conn.status))}`}</span>
						</span>
						<!-- Orca's SshTargetCard primary action: Disconnect when connected, else Connect / Reconnect / Retry. -->
						{#if conn.status === 'connected'}
							<button class={BTN} onclick={() => sshConnections.disconnect(t.id)}>{tr('sshRemote.disconnect')}</button>
						{:else}
							<button class={BTN} disabled={isConnecting(conn.status) || !canConnect(conn.status)} title={conn.error ?? undefined} onclick={() => sshConnections.connect(t.id)}>{isConnecting(conn.status) ? tr('sshRemote.conn.connecting') : tr(`sshRemote.verb.${connectVerb(conn.status)}`)}</button>
						{/if}
						<button class={BTN} disabled={r === 'testing'} onclick={() => ssh.test(t.id)}>{r === 'testing' ? 'Testing…' : 'Test'}</button>
						<button class={BTN} onclick={() => ssh.terminal(t)}>Terminal</button>
						<button class={[BTN, ssh.panels[t.id]?.kind === 'files' && 'bg-(--vscode-foreground)/10']} onclick={() => (ssh.panels[t.id]?.kind === 'files' ? ssh.closePanel(t.id) : ssh.browse(t.id))}>Files</button>
						<button class={[BTN, ssh.panels[t.id]?.kind === 'ports' && 'bg-(--vscode-foreground)/10']} onclick={() => (ssh.panels[t.id]?.kind === 'ports' ? ssh.closePanel(t.id) : ssh.ports(t.id))}>Ports</button>
						<!-- Agent CLIs Kingu installs on the host (SshAgentsPanel). -->
						<button class={[BTN, sshAgentInstalls.open[t.id] && 'bg-(--vscode-foreground)/10']} aria-expanded={!!sshAgentInstalls.open[t.id]} onclick={() => sshAgentInstalls.toggle(t.id)}>{tr('sshAgentInstall.button')}</button>
						<button class={BTN} onclick={() => ssh.forward(t)}>Forward…</button>
						<button class={ICON_BTN} aria-label="Remove {t.label}" title="Remove host (stops its forwards)" onclick={() => ssh.remove(t.id)}><Icon name="trash" size={13} /></button>
					</div>
					<!-- Installing Kingu's terminal host here: the answer kept for this host, changed here (asked first, unlike Orca's silent install). -->
					<div class="mt-1 flex items-center gap-2 pl-4 text-[11px] {MUTED}">
						<span>{tr('sshRemote.holder.setting', { choice: tr(`sshRemote.holder.choice.${choice ?? 'none'}`) })}</span>
						{#if choice !== 'allow'}<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => sshProjects.setHolderConsent(t.id, 'allow')}>{tr('sshRemote.holder.allow')}</button>{/if}
						{#if choice !== 'never'}<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => sshProjects.setHolderConsent(t.id, 'never')}>{tr('sshRemote.holder.neverButton')}</button>{/if}
						{#if choice}<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => sshProjects.setHolderConsent(t.id, null)}>{tr('sshRemote.holder.askAgain')}</button>{/if}
					</div>
					{#if r && r !== 'testing'}
						<p class={['mt-1 pl-4 text-[11px]', r.success ? 'text-[#73C991]' : 'text-(--vscode-errorForeground)']}>{r.success ? `Connected in ${(r.millis / 1000).toFixed(1)} s` : r.error}</p>
					{/if}
					{#if panel?.kind === 'files'}
						<!-- Files on the host: open a folder, go up, or open a terminal there. -->
						<div class="mt-2 ml-4 rounded-md border border-(--vscode-widget-border) bg-(--vscode-editor-background)/40">
							<div class="flex items-center gap-1 border-b border-(--vscode-widget-border) px-2 py-1">
								<button class={ICON_BTN} aria-label="Up one folder" title="Up one folder" disabled={!panel.dir || panel.dir.path === '/'} onclick={() => panel.dir && ssh.browse(t.id, panel.dir.path.replace(/\/[^/]+\/?$/, '') || '/')}><Icon name="arrowUp" size={12} /></button>
								<span class="min-w-0 flex-1 truncate font-mono text-[11px]" title={panel.dir?.path}>{panel.dir?.path ?? '…'}</span>
								{#if panel.loading}<span class="text-[11px] {MUTED}">Loading…</span>{/if}
								<button class="text-[11px] text-(--vscode-textLink-foreground) hover:underline disabled:opacity-40" disabled={!panel.dir} onclick={() => panel.dir && ssh.terminalIn(t, panel.dir.path)}>Terminal here</button>
								<button class="text-[11px] text-(--vscode-textLink-foreground) hover:underline disabled:opacity-40" disabled={!panel.dir} onclick={() => panel.dir && sshProjects.add(t, panel.dir.path).then((ok) => ok && (ssh.open = false))}>{tr('adeProjects.sshAddHere')}</button>
							</div>
							{#if panel.error}<p class="px-2 py-1 text-[11px] text-(--vscode-errorForeground)">{panel.error}</p>{/if}
							<ul class="max-h-48 overflow-y-auto py-0.5">
								{#each panel.dir?.entries ?? [] as e (e)}
									<li>
										{#if e.endsWith('/')}
											<button class="flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-[12px] hover:bg-(--vscode-list-hoverBackground)" onclick={() => panel.dir && ssh.browse(t.id, `${panel.dir.path.replace(/\/$/, '')}/${e.slice(0, -1)}`)}><Icon name="folder" size={12} />{e.slice(0, -1)}</button>
										{:else}
											<span class="flex items-center gap-1.5 px-2 py-0.5 text-[12px] {MUTED}"><Icon name="file" size={12} />{e}</span>
										{/if}
									</li>
								{/each}
								{#if panel.dir?.truncated}<li class="px-2 py-0.5 text-[11px] {MUTED}">Only the first 500 entries are shown</li>{/if}
							</ul>
						</div>
					{:else if panel?.kind === 'ports'}
						<!-- Ports listening on the host, each one click from a forward. -->
						<div class="mt-2 ml-4 rounded-md border border-(--vscode-widget-border) px-2 py-1.5">
							{#if panel.loading}
								<p class="text-[11px] {MUTED}">Looking for listening ports…</p>
							{:else if panel.error}
								<p class="text-[11px] text-(--vscode-errorForeground)">{panel.error}</p>
							{:else if panel.ports?.length}
								<div class="flex flex-wrap gap-1.5">
									{#each panel.ports as port (port)}
										{@const fwd = fws.find((f) => f.remote_port === port && f.running)}
										<button class="rounded border border-(--vscode-widget-border) px-2 py-0.5 font-mono text-[11px] hover:bg-(--vscode-list-hoverBackground) disabled:opacity-60" disabled={!!fwd} title={fwd ? `Forwarded to localhost:${fwd.local_port}` : `Forward ${port} to this computer`} onclick={() => ssh.forwardPort(t, port)}>{port}{fwd ? ' ✓' : ''}</button>
									{/each}
								</div>
							{:else}
								<p class="text-[11px] {MUTED}">No listening ports found (besides ssh).</p>
							{/if}
						</div>
					{/if}
					{#if sshAgentInstalls.open[t.id]}<SshAgentsPanel host={t.id} label={t.label} />{/if}
					{#each fws as f (f.id)}
						<div class="mt-1 flex items-center gap-2 pl-4 text-[11px] {MUTED}">
							<Icon name="ports" size={11} />
							<span class="flex-1 font-mono">localhost:{f.local_port} → {f.remote_host}:{f.remote_port}{f.running ? '' : ' (stopped)'}</span>
							<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => ssh.stopForward(f.id)}>Stop</button>
						</div>
					{/each}
				</li>
			{:else}
				<li class="px-5 py-8 text-center text-[13px] {MUTED}">No SSH hosts yet. Import one from ~/.ssh/config or add one.</li>
			{/each}
		</ul>
		{#if ssh.unrestored.length}
			<!-- Forwards that ran before Kingu was closed (Orca's saved port forwards). -->
			<div class="border-b border-(--vscode-widget-border) px-5 py-2">
				<p class="mb-1 text-[11px] font-semibold {MUTED}">Forwards from last time</p>
				{#each ssh.unrestored as s (`${s.target_id}:${s.local_port}`)}
					<div class="flex items-center gap-2 py-0.5 text-[12px]">
						<span class="min-w-0 flex-1 truncate font-mono">localhost:{s.local_port} → {ssh.targets.find((t) => t.id === s.target_id)?.label ?? '?'} {s.remote_host}:{s.remote_port}</span>
						<button class="text-[11px] text-(--vscode-textLink-foreground) hover:underline" onclick={() => ssh.restore(s)}>Restore</button>
						<button class="text-[11px] {MUTED} hover:underline" onclick={() => ssh.forget(s)}>Forget</button>
					</div>
				{/each}
			</div>
		{/if}
		<footer class="px-5 py-3 text-[11px] {MUTED}">Uses your own ssh: keys, agent, ProxyJump and known hosts work as in a terminal. Tests never ask for a password.</footer>
	</div>
</div>
