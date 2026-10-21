<script lang="ts">
	// Snaps in the system settings page. With `systemSettings.snapKey` it is one snap's details
	// page (VS Code's extension editor): header with its actions, a setup checklist while something
	// is missing (a required program, a service that stopped), then Details (README), Features
	// (what it adds for you and for agents), Permissions (what the sandbox lets it do) and Settings.
	// Without a key it is an overview of every snap. A shipped snap that is not installed has a
	// details page too (`catalog/<id>`), so it can be read before Install.
	import Icon from '#lib/workbench/Icon.svelte';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { renderMarkdown } from '#lib/workbench/markdown.ts';
	import '#lib/workbench/markdown.css';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { invoke } from '@tauri-apps/api/core';
	import { t } from '#lib/i18n/index.ts';
	import {
		agentReach,
		audiences,
		catalogKey,
		enforcementLabel,
		isActive,
		isUpdatable,
		lockNote,
		missingRequirements,
		originLabel,
		permissionLines,
		requirementStates,
		SANDBOX_SETTING,
		settingId,
		settingsGroup,
		snapKey,
		snapStatus,
		type SnapInfo
	} from './snapModel.ts';
	import { snaps } from './snaps.svelte.ts';
	import SnapAvatar from './SnapAvatar.svelte';

	type Tab = 'details' | 'features' | 'permissions' | 'settings';
	let tab = $state<Tab>('details');
	let log = $state<{ service: string; text: string } | null>(null);
	let reloading = $state(false);
	/** The value being typed for a secret (`<name>`), cleared once it is saved. */
	let secretInput = $state<{ name: string; value: string } | null>(null);

	const get = (id: string) => settings.get(id);
	const catalogSnap = $derived(snaps.catalogSnap(systemSettings.snapKey));
	const snap = $derived(systemSettings.snapKey ? (snaps.list.find((s) => snapKey(s) === systemSettings.snapKey) ?? catalogSnap) : undefined);
	const installed = $derived(!!snap && !catalogSnap);
	const enforcement = $derived(enforcementLabel(snaps.sandbox));

	// A new snap opens on its Details tab.
	$effect(() => {
		void systemSettings.snapKey;
		tab = 'details';
		log = null;
		secretInput = null;
	});
	// The Permissions tab shows which declared secrets have a stored value.
	$effect(() => {
		if (tab === 'permissions' && snap && installed && snap.permissions.secrets.length) void snaps.loadSecrets(snap.id);
	});

	async function saveSecret(s: SnapInfo) {
		if (!secretInput?.value) return;
		const { name, value } = secretInput;
		secretInput = null;
		await snaps.setSecret(s.id, name, value);
	}

	async function reload() {
		reloading = true;
		await snaps.load();
		reloading = false;
	}

	async function showLog(s: SnapInfo, service: string) {
		log = { service, text: (await snaps.serviceLog(s.id, service)) || t('tools.snapsUi.logEmpty') };
	}

	function openLink(s: SnapInfo, url: string) {
		void invoke('snap_open_link', { id: s.id, url }).catch((e) => status.error(String(e)));
	}

	/** README links are copied (the app never navigates), like the Markdown preview. */
	function readmeClick(e: MouseEvent | KeyboardEvent) {
		if (e instanceof KeyboardEvent && e.key !== 'Enter') return;
		const a = (e.target as HTMLElement).closest<HTMLElement>('a[data-href]');
		if (!a) return;
		e.preventDefault();
		const href = a.dataset.href ?? '';
		if (/^https?:/i.test(href)) void navigator.clipboard.writeText(href).then(() => status.flash(t('tools.snapsUi.linkCopied', { url: href }), 4000));
	}

	const since = (secs: number) => new Date(secs * 1000).toLocaleTimeString();

	const TONE = {
		ok: 'text-(--vscode-testing-iconPassed,var(--vscode-charts-green))',
		warn: 'text-(--vscode-editorWarning-foreground)',
		error: 'text-(--vscode-errorForeground)',
		muted: 'text-(--vscode-descriptionForeground)'
	};
	const BADGE = 'rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] leading-4 text-(--vscode-badge-foreground)';
	const BUTTON = 'rounded-sm border border-transparent bg-(--vscode-button-background) px-3 py-1 text-[13px] text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground) disabled:opacity-50';
	const SECONDARY = 'rounded-sm border border-(--vscode-button-border,var(--vscode-widget-border)) bg-(--vscode-button-secondaryBackground) px-3 py-1 text-[13px] text-(--vscode-button-secondaryForeground) hover:bg-(--vscode-button-secondaryHoverBackground) disabled:opacity-50';
	const SMALL = 'rounded-sm border border-(--vscode-button-border,var(--vscode-widget-border)) bg-(--vscode-button-secondaryBackground) px-2 py-0.5 text-xs text-(--vscode-button-secondaryForeground) hover:bg-(--vscode-button-secondaryHoverBackground) disabled:opacity-50';
	const SMALL_PRIMARY = 'rounded-sm border border-transparent bg-(--vscode-button-background) px-2 py-0.5 text-xs text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground) disabled:opacity-50';
	const LABEL = 'text-[11px] font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase';
	const CARD = 'rounded-md border border-(--vscode-widget-border,var(--vscode-panel-border))';
</script>

<div class="h-full overflow-y-auto bg-(--vscode-editor-background) text-(--vscode-foreground)">
	<div class="mx-auto w-full max-w-[1000px] px-6 pt-3 pb-8 text-[13px]">
		{#if snaps.sandbox.kind === 'off'}
			<p role="alert" class="mb-3 flex items-start gap-1.5 rounded-md border border-(--vscode-editorWarning-foreground) px-2 py-1.5 text-xs text-(--vscode-editorWarning-foreground)">
				<Icon name="warning" size={14} />
				<span>{t('tools.snapsUi.sandboxOff', { setting: SANDBOX_SETTING })}</span>
				<button class="ml-auto shrink-0 text-(--vscode-textLink-foreground) hover:underline" onclick={() => systemSettings.show('Snap Sandbox')}>{t('tools.snapsUi.settings')}</button>
			</p>
		{/if}
		{#if snaps.error}
			<p role="alert" class="mb-3 rounded-md border border-(--vscode-editorError-foreground) px-2 py-1 text-xs text-(--vscode-errorForeground)">{t('tools.snaps.loadFailed', { error: snaps.error })}</p>
		{/if}

		{#if systemSettings.snapKey && snap}
			{@render details(snap)}
		{:else if systemSettings.snapKey}
			<p class="mt-6 text-(--vscode-descriptionForeground)">{snaps.loaded ? t('tools.snapsUi.gone') : t('tools.snapsUi.loading')}</p>
			<button class="mt-2 text-xs text-(--vscode-textLink-foreground) hover:underline" onclick={() => (systemSettings.snapKey = null)}>{t('tools.snapsUi.allSnaps')}</button>
		{:else}
			{@render overview()}
		{/if}
	</div>
</div>

{#snippet overview()}
	<div class="flex items-center gap-2">
		<h2 class="text-lg font-semibold text-(--vscode-settings-headerForeground)">Snaps</h2>
		<span class="flex-1"></span>
		<button class={[SECONDARY, 'flex items-center gap-1.5']} disabled={reloading} onclick={reload}><Icon name="refresh" size={14} /> {t('tools.snapsUi.reload')}</button>
	</div>
	<!-- What makes a snap different from an extension, in three lines. -->
	<div class="mt-3 grid gap-2 sm:grid-cols-3">
		{#each [{ icon: 'robot', title: t('tools.snapsUi.pitchTwoTitle'), text: t('tools.snapsUi.pitchTwo') }, { icon: 'shield', title: t('tools.snapsUi.pitchSafeTitle'), text: t('tools.snapsUi.pitchSafe') }, { icon: 'account', title: t('tools.snapsUi.pitchTeamTitle'), text: t('tools.snapsUi.pitchTeam') }] as p (p.title)}
			<div class={[CARD, 'p-3']}>
				<div class="flex items-center gap-1.5 font-semibold"><Icon name={p.icon as 'robot'} size={16} /> {p.title}</div>
				<p class="mt-1 text-xs text-(--vscode-descriptionForeground)">{p.text}</p>
			</div>
		{/each}
	</div>
	{#if snaps.busy}<p class="mt-3 text-xs text-(--vscode-descriptionForeground)">{snaps.busy}</p>{/if}

	{@const groups = [
		{ title: t('tools.snapsUi.installed'), list: snaps.list.filter((s) => s.source === 'user') },
		{ title: t('tools.snapsUi.thisFolder'), list: snaps.list.filter((s) => s.source === 'repo') },
		{ title: t('tools.snapsUi.recommended'), list: snaps.recommended.filter((e) => e.state === 'available').map((e) => e.snap) }
	]}
	{#each groups as g (g.title)}
		{#if g.list.length}
			<div class={['mt-5', LABEL]}>{g.title}</div>
			<div class="mt-2 grid gap-2 sm:grid-cols-2">
				{#each g.list as s (s.source + s.id + g.title)}
					{@const st = snapStatus(s)}
					{@const key = snaps.list.includes(s) ? snapKey(s) : catalogKey(s.id)}
					<button class={[CARD, 'flex items-start gap-3 p-3 text-left hover:bg-(--vscode-list-hoverBackground)']} onclick={() => systemSettings.showSnaps(key)}>
						<SnapAvatar snap={s} size={40} muted={!!s.disabled || !!s.error} />
						<span class="flex min-w-0 flex-1 flex-col gap-0.5">
							<span class="flex items-center gap-1.5"><span class="truncate font-semibold">{s.name}</span><span class="text-xs text-(--vscode-descriptionForeground)">v{s.version}</span></span>
							<span class="line-clamp-2 text-xs text-(--vscode-descriptionForeground)">{s.error ?? s.description}</span>
							{#if snaps.list.includes(s)}<span class={['text-xs', TONE[st.tone]]}>{st.label}</span>{/if}
						</span>
					</button>
				{/each}
			</div>
		{/if}
	{/each}
	{#if !snaps.list.length && !snaps.recommended.length}
		<p class="mt-6 text-(--vscode-descriptionForeground)">{snaps.loaded ? t('tools.snapsUi.noneAtAll') : t('tools.snapsUi.loading')}</p>
	{/if}
{/snippet}

{#snippet details(s: SnapInfo)}
	{@const st = snapStatus(s)}
	{@const active = installed && isActive(s)}
	{@const reqs = requirementStates(s, get, snaps.found)}
	{@const missing = missingRequirements(reqs)}
	{@const svc = s.services.map((sv) => ({ sv, status: snaps.services.find((x) => x.snapId === s.id && x.serviceId === sv.id) }))}
	{@const who = audiences(s)}
	{@const entry = snaps.recommended.find((e) => e.snap.id === s.id)}

	<button class="mb-3 flex items-center gap-1 text-xs text-(--vscode-textLink-foreground) hover:underline" onclick={() => (systemSettings.snapKey = null)}><Icon name="arrowLeft" size={12} /> {t('tools.snapsUi.allSnaps')}</button>

	<!-- Header: what it is and the actions it has. -->
	<header class="flex items-start gap-4">
		<SnapAvatar snap={s} size={72} muted={!!s.disabled || !!s.error} />
		<div class="min-w-0 flex-1">
			<div class="flex flex-wrap items-baseline gap-2">
				<h2 class="text-xl font-semibold text-(--vscode-settings-headerForeground)">{s.name}</h2>
				{#if s.version}<span class="text-(--vscode-descriptionForeground)">v{s.version}</span>{/if}
				<span class={BADGE}>{catalogSnap ? 'Kingu' : s.source === 'user' ? t('tools.snapsUi.sourceUser') : t('tools.snapsUi.sourceRepo')}</span>
				{#if installed && st.key !== 'active'}<span class={['text-xs', TONE[st.tone]]}>{st.label}</span>{/if}
				{#if installed && lockNote(s)}<span class="text-xs text-(--vscode-editorWarning-foreground)">{lockNote(s)}</span>{/if}
			</div>
			<p class="mt-1 text-(--vscode-descriptionForeground)">{s.description || s.id}</p>
			<div class="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-(--vscode-descriptionForeground)">
				<span class={['flex items-center gap-1', TONE[enforcement.tone]]} title={t('tools.snapsUi.sandboxedHint')}><Icon name="shield" size={13} /> {enforcement.text}</span>
				{#if who.agents.length}<span class="flex items-center gap-1"><Icon name="robot" size={13} /> {t('tools.snapsUi.forAgentsShort')}</span>{/if}
				{#if who.you.length}<span class="flex items-center gap-1"><Icon name="desktop" size={13} /> {t('tools.snapsUi.forYouShort')}</span>{/if}
			</div>
			<div class="mt-3 flex flex-wrap items-center gap-2">
				{#if catalogSnap}
					<button class={[BUTTON, 'flex items-center gap-1.5']} disabled={!!snaps.busy} onclick={() => snaps.installBuiltin(s.id)}><Icon name="download" size={14} /> {t('tools.snapsUi.install')}</button>
				{:else}
					{#if s.source === 'repo' && !s.error && !s.trusted}
						<button class={BUTTON} onclick={() => snaps.confirmTrust(s)}>{t('tools.snapsUi.trust')}</button>
					{/if}
					{#if entry?.state === 'update'}
						<button class={BUTTON} disabled={!!snaps.busy} onclick={() => snaps.installBuiltin(s.id)}>{t('tools.snapsUi.updateTo', { version: entry.snap.version })}</button>
					{:else if isUpdatable(s)}
						<button class={SECONDARY} disabled={!!snaps.busy} onclick={() => snaps.update(s.id)}>{t('tools.snapsUi.update')}</button>
					{/if}
					{#if !s.error && (s.source === 'user' || s.trusted)}
						<button class={[SECONDARY, 'flex items-center gap-1.5']} onclick={() => snaps.setEnabled(s.id, !!s.disabled)}><Icon name="power" size={14} /> {s.disabled ? t('tools.snapsUi.enable') : t('tools.snapsUi.disable')}</button>
					{/if}
					{#if s.source === 'repo' && s.trusted}<button class={SECONDARY} onclick={() => snaps.trust(s.id, false)}>{t('tools.snapsUi.untrust')}</button>{/if}
					{#if s.source === 'user'}<button class={SECONDARY} disabled={!!snaps.busy} onclick={() => snaps.uninstall(s.id)}>{t('tools.snapsUi.uninstall')}</button>{/if}
					{#if !s.error}<button class={SECONDARY} onclick={() => snaps.editManifest(s)}>snap.toml</button>{/if}
					<button class={SECONDARY} onclick={() => snaps.reveal(s)}>{t('tools.snapsUi.reveal')}</button>
				{/if}
			</div>
		</div>
	</header>

	{#if s.error}
		<p role="alert" class="mt-4 flex items-start gap-1.5 text-(--vscode-errorForeground)"><Icon name="error" size={14} /> <span>{s.error}</span></p>
	{/if}
	{#if installed && s.source === 'repo' && !s.error && !s.trusted}
		<p class="mt-4 flex items-start gap-1.5 rounded-md border border-(--vscode-editorWarning-foreground) px-2 py-1.5 text-(--vscode-editorWarning-foreground)">
			<Icon name="warning" size={14} />
			<span>{t('tools.snapsUi.repoWarning')}</span>
		</p>
	{/if}

	<!-- Setup: what it needs that Kingu does not ship, and its services. -->
	{#if !s.error && (reqs.length || svc.length)}
		<section class={[CARD, 'mt-4 p-3', missing.length && 'border-(--vscode-editorWarning-foreground)']} aria-label={t('tools.snapsUi.setup')}>
			<div class="flex items-center gap-1.5 font-semibold">
				{#if missing.length}<Icon name="warning" size={14} />{:else}<Icon name="checkCircle" size={14} />{/if}
				{!installed ? t('tools.snapsUi.needs') : missing.length ? t('tools.snapsUi.setupNeeded') : t('tools.snapsUi.setupReady')}
			</div>
			<ul class="mt-2 space-y-2">
				{#each reqs as r (r.require.program)}
					{@const task = s.tasks.find((x) => x.id === r.require.install_task)}
					<li class="flex flex-wrap items-center gap-2">
						<span class={r.found?.path ? TONE.ok : r.found ? TONE.warn : TONE.muted}><Icon name={r.found?.path ? 'check' : 'circleDashed'} size={14} /></span>
						<span class="min-w-0 flex-1">
							<code>{r.program}</code>
							<span class="text-(--vscode-descriptionForeground)">
								{#if r.found?.path}— {r.found.path}{#if !r.found.onPath}{' '}· {t('tools.snapsUi.notOnPath')}{/if}{:else if r.found}— {t('tools.snapsUi.notInstalled')}{/if}
								{#if r.require.description}<span class="block text-xs">{r.require.description}</span>{/if}
							</span>
						</span>
						{#if r.found && !r.found.path}
							{#if task && active}<button class={[BUTTON, 'flex items-center gap-1']} onclick={() => snaps.runTask(s.id, task.id, { home: true })}><Icon name="download" size={13} /> {task.title}</button>{/if}
							{#if r.require.url}<button class={[SMALL, 'flex items-center gap-1']} onclick={() => openLink(s, r.require.url!)}><Icon name="openExternal" size={12} /> {t('tools.snapsUi.howToInstall')}</button>{/if}
							{#if installed}<button class={SMALL} onclick={() => snaps.checkPrograms()}>{t('tools.snapsUi.checkAgain')}</button>{/if}
						{:else if r.found?.path && !r.found.onPath && r.require.setting && installed}
							<button class={SMALL} onclick={() => settings.set(settingId(s.id, r.require.setting!), r.found!.path, 'user').then(() => snaps.load())}>{t('tools.snapsUi.usePath')}</button>
						{/if}
					</li>
				{/each}
				{#each svc as { sv, status: ss } (sv.id)}
					<li class="flex flex-wrap items-center gap-2">
						<span class={ss?.running ? TONE.ok : ss && !ss.stopped ? TONE.error : TONE.muted}><span class="inline-block size-2 rounded-full bg-current"></span></span>
						<span class="min-w-0 flex-1">
							{sv.title}
							<span class="text-(--vscode-descriptionForeground)">
								— {#if !installed}{t('tools.snapsUi.serviceAfterInstall')}{:else if ss?.running}{t('tools.snapsUi.runningSince', { time: since(ss.startedAt), pid: ss.pid ?? '' })}{:else if ss && !ss.stopped}{t('tools.snapsUi.crashed', { code: ss.exitCode ?? '—' })}{:else if !active}{t('tools.snapsUi.serviceInactive')}{:else if missing.length}{t('tools.snapsUi.serviceWaits')}{:else if sv.when && get(settingId(s.id, sv.when)) !== true}{t('tools.snapsUi.serviceOff', { setting: settingId(s.id, sv.when) })}{:else}{t('tools.snapsUi.serviceNotRunning')}{/if}
							</span>
						</span>
						{#if active}
							{#if ss?.running}
								<button class={SMALL} onclick={() => snaps.stopService(s.id, sv.id)}>{t('tools.snapsUi.stop')}</button>
							{:else}
								<button class={SMALL} disabled={missing.length > 0} onclick={() => snaps.startService(s.id, sv.id)}>{t('tools.snapsUi.start')}</button>
							{/if}
							{#if ss}<button class={SMALL} onclick={() => showLog(s, sv.id)}>{t('tools.snapsUi.log')}</button>{/if}
						{/if}
					</li>
				{/each}
			</ul>
			{#if log}
				<div class="mt-2">
					<div class="flex items-center gap-2 text-xs text-(--vscode-descriptionForeground)">{t('tools.snapsUi.logOf', { service: log.service })}<button class="ml-auto hover:underline" onclick={() => (log = null)}>{t('tools.snapsUi.close')}</button></div>
					<pre class="kg-selectable mt-1 max-h-60 overflow-auto rounded-sm bg-(--vscode-textCodeBlock-background) p-2 text-[11px] whitespace-pre-wrap">{log.text}</pre>
				</div>
			{/if}
		</section>
	{/if}

	<!-- Tabs -->
	<div role="tablist" class="mt-5 flex gap-4 border-b border-(--vscode-widget-border,var(--vscode-panel-border))">
		{#each [{ id: 'details', label: t('tools.snapsUi.tabDetails') }, { id: 'features', label: t('tools.snapsUi.tabFeatures') }, { id: 'permissions', label: t('tools.snapsUi.tabPermissions') }, { id: 'settings', label: t('tools.snapsUi.tabSettings') }] as tb (tb.id)}
			<button
				role="tab"
				aria-selected={tab === tb.id}
				class={['-mb-px border-b-2 px-0.5 pb-1.5 text-[13px] uppercase', tab === tb.id ? 'border-(--vscode-panelTitle-activeBorder,var(--vscode-focusBorder)) text-(--vscode-panelTitle-activeForeground,var(--vscode-foreground))' : 'border-transparent text-(--vscode-panelTitle-inactiveForeground,var(--vscode-descriptionForeground)) hover:text-(--vscode-foreground)']}
				onclick={() => (tab = tb.id as Tab)}>{tb.label}</button
			>
		{/each}
	</div>

	<div class="mt-4">
		{#if tab === 'details'}
			{#if s.readme}
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions (link clicks are delegated; the links stay focusable) -->
				<!-- Safe: renderMarkdown escapes raw HTML and drops images and hrefs (see markdown.ts). -->
				<article class="markdown-body kg-selectable" onclick={readmeClick} onkeydown={readmeClick}>{@html renderMarkdown(s.readme)}</article>
			{:else}
				<p class="text-(--vscode-descriptionForeground)">{s.description || t('tools.snapsUi.noReadme')}</p>
			{/if}
			<div class="mt-6 grid gap-x-6 gap-y-1 text-xs text-(--vscode-descriptionForeground) sm:grid-cols-[max-content_1fr]">
				<span>{t('tools.snapsUi.identifier')}</span><code>{s.id}</code>
				{#if installed}<span>{t('tools.snapsUi.location')}</span><span class="truncate" title={s.dir}>{s.dir}</span>{/if}
				{#if s.origin}<span>{t('tools.snapsUi.installedFrom')}</span><span class="truncate" title={originLabel(s.origin)}>{originLabel(s.origin)}{s.origin.installed_at ? ` · ${new Date(s.origin.installed_at * 1000).toLocaleString()}` : ''}</span>{/if}
			</div>
		{:else if tab === 'features'}
			<div class="grid gap-3 sm:grid-cols-2">
				<div class={[CARD, 'p-3']}>
					<div class="flex items-center gap-1.5 font-semibold"><Icon name="desktop" size={15} /> {t('tools.snapsUi.forYou')}</div>
					<p class="mt-0.5 text-xs text-(--vscode-descriptionForeground)">{t('tools.snapsUi.forYouDesc')}</p>
					{#each s.tasks as tk (tk.id)}
						<div class="mt-2 flex items-center gap-2">
							<span class="min-w-0 flex-1"><span>{tk.title}</span> <code class="block truncate text-[11px] text-(--vscode-descriptionForeground)" title={tk.command.join(' ')}>{tk.command.join(' ')}</code></span>
							<button
								class={[SMALL, 'flex shrink-0 items-center gap-1']}
								disabled={!active || (!workspace.root && tk.id !== s.requires.find((r) => r.install_task)?.install_task)}
								title={!active ? t('tools.snapsUi.activateFirst') : t('tools.snapsUi.runHint')}
								onclick={() => snaps.runTask(s.id, tk.id, { home: true })}><Icon name="play" size={11} /> {t('tools.snapsUi.run')}</button
							>
						</div>
					{/each}
					{#each s.services as sv (sv.id)}
						<div class="mt-2 flex items-center gap-1.5"><Icon name="activity" size={13} /> <span>{sv.title}</span> <span class="text-xs text-(--vscode-descriptionForeground)">— {t('tools.snapsUi.serviceDesc')}</span></div>
					{/each}
					{#if !s.tasks.length && !s.services.length}<p class="mt-2 text-(--vscode-descriptionForeground)">—</p>{/if}
				</div>
				<div class={[CARD, 'p-3']}>
					<div class="flex items-center gap-1.5 font-semibold"><Icon name="robot" size={15} /> {t('tools.snapsUi.forAgents')}</div>
					<p class="mt-0.5 text-xs text-(--vscode-descriptionForeground)">{t('tools.snapsUi.forAgentsDesc')}</p>
					{#each s.mcp as m (m.name)}
						<div class="mt-2"><span class={BADGE}>MCP</span> <span class="font-semibold">{m.name}</span> <code class="block truncate text-[11px] text-(--vscode-descriptionForeground)">{m.command.join(' ')}</code></div>
					{/each}
					{#each s.skills as k (k.path)}
						<div class="mt-2"><span class={BADGE}>skill</span> <span class="font-semibold">snap-{s.id}:{k.name}</span>{#if k.description}<span class="block text-xs text-(--vscode-descriptionForeground)">{k.description}</span>{/if}</div>
					{/each}
					{#if s.hooks.length}
						<div class="mt-2"><span class={BADGE}>hooks</span> {[...new Set(s.hooks.map((h) => h.event))].join(', ')}<span class="block text-xs text-(--vscode-descriptionForeground)">{t('tools.snaps.hooksForAgents')}</span></div>
					{/if}
					{#if !s.mcp.length && !s.skills.length && !s.hooks.length}<p class="mt-2 text-(--vscode-descriptionForeground)">—</p>{/if}
					{#if agentReach(s).length}
						<div class={['mt-3', LABEL]}>{t('tools.snapsUi.worksWith')}</div>
						<table class="mt-1 w-full text-xs">
							<tbody>
								{#each agentReach(s) as r (r.agent)}
									<tr class="border-t border-(--vscode-widget-border,var(--vscode-panel-border))"><td class="py-0.5 pr-3">{r.agent}</td><td class="py-0.5 text-(--vscode-descriptionForeground)">{r.gets.join(' · ')}</td></tr>
								{/each}
							</tbody>
						</table>
					{/if}
				</div>
			</div>
		{:else if tab === 'permissions'}
			<div class={[CARD, 'p-3']}>
				<div class="flex items-center gap-1.5 font-semibold"><Icon name="shield" size={15} /> {t('tools.snapsUi.declared')}</div>
				<ul class="mt-2 space-y-1">
					{#each permissionLines(s.permissions) as line (line)}<li>• {line}</li>{/each}
				</ul>
				<p class={['mt-2 text-xs', TONE[enforcement.tone]]}>{enforcement.text}</p>
				<p class="mt-2 text-xs text-(--vscode-descriptionForeground)">{t('tools.snapsUi.permissionsExplain')}</p>
			</div>
			{#if s.permissions.secrets.length}
				<div class={[CARD, 'mt-3 p-3']}>
					<div class="flex items-center gap-1.5 font-semibold"><Icon name="key" size={15} /> Secrets</div>
					<p class="mt-0.5 text-xs text-(--vscode-descriptionForeground)">{t('tools.snapsUi.secretsExplain')}</p>
					<ul class="mt-2 space-y-2">
						{#each s.permissions.secrets as name (name)}
							{@const stored = snaps.secrets[s.id]?.find((x) => x.name === name)?.stored}
							<li class="flex flex-wrap items-center gap-2">
								<code class="min-w-[10rem]">{name}</code>
								<span class={['text-xs', stored ? TONE.ok : TONE.muted]}>{stored ? t('tools.snapsUi.secretStored') : t('tools.snapsUi.secretNotStored')}</span>
								<span class="flex-1"></span>
								{#if !installed}
									<span class="text-xs text-(--vscode-descriptionForeground)">{t('tools.snapsUi.secretAfterInstall')}</span>
								{:else if secretInput?.name === name}
									<form class="flex items-center gap-1.5" onsubmit={(e) => (e.preventDefault(), void saveSecret(s))}>
										<!-- svelte-ignore a11y_autofocus (the field the user just asked for) -->
										<input
											type="password"
											autocomplete="off"
											autofocus
											aria-label={name}
											bind:value={secretInput.value}
											onkeydown={(e) => e.key === 'Escape' && (secretInput = null)}
											class="h-[24px] w-56 rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 text-xs text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
										/>
										<button class={SMALL_PRIMARY} disabled={!secretInput.value}>{t('tools.snapsUi.save')}</button>
										<button type="button" class={SMALL} onclick={() => (secretInput = null)}>{t('common.cancel')}</button>
									</form>
								{:else}
									<button class={SMALL} onclick={() => (secretInput = { name, value: '' })}>{stored ? t('tools.snapsUi.secretReplace') : t('tools.snapsUi.secretSet')}</button>
									{#if stored}<button class={SMALL} onclick={() => snaps.removeSecret(s.id, name)}>{t('tools.snaps.secretRemove')}</button>{/if}
								{/if}
							</li>
						{/each}
					</ul>
					{#if snaps.sandbox.kind !== 'enforce'}<p class={['mt-2 text-xs', TONE.warn]}>{t('tools.snapsUi.secretsNeedSandbox')}</p>{/if}
				</div>
			{/if}
			<div class={['mt-4', LABEL]}>{t('tools.snapsUi.commands')}</div>
			<ul class="mt-1 space-y-1 text-xs">
				{#each [...s.tasks.map((x) => ['task', x.title, x.command]), ...s.services.map((x) => ['service', x.title, x.command]), ...s.mcp.map((x) => ['MCP', x.name, x.command]), ...s.hooks.map((x) => ['hook', x.event, x.command])] as [kind, name, cmd], i (i)}
					<li><span class={BADGE}>{kind}</span> {name}: <code class="text-(--vscode-descriptionForeground)">{(cmd as string[]).join(' ')}</code></li>
				{:else}
					<li class="text-(--vscode-descriptionForeground)">—</li>
				{/each}
			</ul>
			{#if s.files.length}
				<div class={['mt-4', LABEL]}>{t('tools.snapsUi.filesRun')}</div>
				<ul class="mt-1 space-y-0.5 text-xs">
					{#each s.files as f (f)}<li><code>{f}</code></li>{/each}
				</ul>
				<p class="mt-1 text-xs text-(--vscode-descriptionForeground)">{t('tools.snapsUi.filesRunHint')}</p>
			{/if}
		{:else}
			{#each s.settings as st (st.key)}
				<div class="mt-2">
					<code>{settingId(s.id, st.key)}</code>
					<span class="text-(--vscode-descriptionForeground)"> = {JSON.stringify(installed ? get(settingId(s.id, st.key)) : st.default)}</span>
					<span class="block text-xs text-(--vscode-descriptionForeground)">{st.description} ({st.type}, {t('tools.snapsUi.default')} {JSON.stringify(st.default)})</span>
				</div>
			{:else}
				<p class="text-(--vscode-descriptionForeground)">—</p>
			{/each}
			{#if installed && s.settings.length && !s.overridden}
				<button class={[SECONDARY, 'mt-3']} onclick={() => systemSettings.show(settingsGroup(s))}>{t('tools.snapsUi.editSettings')}</button>
			{/if}
		{/if}
	</div>
{/snippet}
