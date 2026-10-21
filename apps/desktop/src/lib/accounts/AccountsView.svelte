<script lang="ts">
	// AI Provider Accounts (in the system settings page), laid out like Orca's Accounts pane: per
	// provider a section with the system default login and the accounts added in Kingu as cards; the
	// active one is what agents use; sign in again / API key / remove; usage and its history.
	// API keys are typed into a password field and go straight to Rust (Keychain); never kept here.
	import { locale, t } from '#lib/i18n/index.ts';
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { accounts } from './accounts.svelte';
	import ProviderSections from './ProviderSections.svelte';
	import { addCommand, DATA_PROVIDERS, DATA_TITLE, managedAccounts, type DataProvider } from './managed.svelte';
	import PopupMenu, { menuItem } from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { pct, percentLine, PROVIDER_TITLE, PROVIDERS, resetLabel, updatedAgo, windows, windowTitle, type AccountView, type Provider, type Sample } from './usage';

	const ICON: Record<Provider, IconName> = { claude: 'claude', codex: 'openai' };
	/** Orca draws Claude's mark in Claude's orange. */
	const ICON_COLOR: Partial<Record<Provider, string>> = { claude: '#D97757' };

	// The chevron menus beside Add Account and Sign in again (Orca's ButtonGroup + menu).
	let menu = $state<{ items: MenuNode[]; x: number; y: number; run: (id: string) => void } | null>(null);
	function openMenu(e: MouseEvent, items: MenuNode[], run: (id: string) => void) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		menu = { items, x: r.right - 220, y: r.bottom + 2, run };
	}
	const OWN_DIR: Record<Provider, string> = { claude: '~/.claude', codex: '~/.codex' };

	let key = $state('');
	let keyError = $state('');
	let saving = $state(false);
	let history = $state<Record<string, Sample[]>>({});

	$effect(() => {
		void accounts.load();
		return accounts.start();
	});
	$effect(() => managedAccounts.watch());

	/** "Copy add account command" turns into "Copied" (Orca keeps it that way). */
	let copied = $state<Partial<Record<DataProvider, boolean>>>({});
	async function copyAdd(p: DataProvider) {
		await navigator.clipboard.writeText(addCommand(p));
		copied = { ...copied, [p]: true };
	}

	// History of every subject with numbers (loaded when the rows change).
	$effect(() => {
		const keys = accounts.rows.filter((r) => r.usage).map((r) => r.key);
		void Promise.all(keys.map(async (k) => [k, await accounts.history(k)] as const)).then((pairs) => (history = Object.fromEntries(pairs)));
	});

	const list = (p: Provider) => accounts.view?.accounts.filter((a) => a.provider === p) ?? [];
	const hasActive = (p: Provider) => list(p).some((a) => a.active);
	const own = (p: Provider) => accounts.view?.own[p];
	const LOGIN_COMMAND: Record<Provider, string> = { claude: 'claude', codex: 'codex login' };
	const rowOf = (p: Provider, id: string | null) => accounts.rows.find((r) => r.provider === p && r.account_id === id);

	const added = (a: AccountView) =>
		t('settings.accounts.added', { date: new Date(a.created_at).toLocaleDateString(locale() === 'th' ? 'th-TH' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric' }) });
	/** The line under an account's name (Orca: organisation · when, or what it needs). */
	function stateText(a: AccountView): string {
		if (a.kind === 'api_key') return a.signed_in ? `${t('settings.accounts.keyStored')} · ${added(a)}` : t('settings.accounts.noKey');
		if (accounts.loggingIn.includes(a.id)) return t('settings.accounts.waitingLogin');
		return a.signed_in ? [a.org, added(a)].filter(Boolean).join(' · ') : t('settings.accounts.needsSignIn');
	}

	function editKey(id: string) {
		accounts.editingKey = accounts.editingKey === id ? null : id;
		key = '';
		keyError = '';
	}

	async function saveKey(e: SubmitEvent, id: string) {
		e.preventDefault();
		saving = true;
		keyError = (await accounts.setKey(id, key)) ?? '';
		key = '';
		saving = false;
	}

	// Orca's account cards and xs buttons.
	const CARD = 'flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors';
	const CARD_ACTIVE = 'border-(--vscode-foreground)/20 bg-(--vscode-list-inactiveSelectionBackground)/40';
	const CARD_IDLE = 'border-(--vscode-widget-border) hover:bg-(--vscode-list-hoverBackground)/50';
	const BADGE = 'inline-flex h-4 shrink-0 items-center rounded border border-(--vscode-widget-border) px-1.5 text-[10px] leading-none font-medium text-(--vscode-foreground)/75';
	const GHOST = 'inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:pointer-events-none disabled:opacity-40';
	const OUTLINE = 'inline-flex h-6 items-center gap-1.5 rounded-md border border-(--vscode-widget-border) px-2 text-xs hover:bg-(--vscode-list-hoverBackground) disabled:opacity-50';
	const PRIMARY = 'h-[26px] rounded-md bg-(--vscode-button-background) px-2.5 text-xs text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground) disabled:opacity-50';
</script>

{#snippet usageLine(p: Provider, id: string | null)}
	{@const r = rowOf(p, id)}
	{#if r && (r.usage || r.error)}
		{@const samples = history[r.key] ?? []}
		<div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-(--vscode-descriptionForeground)">
			{#each windows(r.usage) as w (w.name)}
				<span class="tabular-nums">{t('settings.accounts.window', { window: windowTitle(w.name), percent: pct(w.window.used_percent), time: resetLabel(w.window, accounts.now) })}</span>
			{/each}
			{#if r.usage?.plan}<span>{t('settings.accounts.plan', { plan: r.usage.plan })}</span>{/if}
			{#if r.updated_at}<span>{updatedAgo(r.updated_at, accounts.now)}</span>{/if}
			{#if r.error}<span class="text-(--vscode-editorWarning-foreground)">{r.error}</span>{/if}
		</div>
		{#if samples.length > 1}
			<div class="mt-1 flex items-center gap-2 text-[11px] text-(--vscode-descriptionForeground)" title={t('settings.accounts.historyTitle', { count: samples.length })}>
				<svg width="160" height="20" aria-hidden="true">
					<polyline points={percentLine(samples.map((s) => s.weekly ?? 0), 160, 20)} fill="none" stroke="var(--vscode-textLink-foreground)" stroke-width="1.25" />
					<polyline points={percentLine(samples.map((s) => s.session ?? 0), 160, 20)} fill="none" stroke="var(--vscode-descriptionForeground)" stroke-width="1" stroke-dasharray="2 2" />
				</svg>
				<span>{t('settings.accounts.historyLegend')}</span>
			</div>
		{/if}
	{/if}
{/snippet}

{#snippet keyForm(p: Provider, id: string)}
	<form class="mt-2 flex items-start gap-2" onsubmit={(e) => saveKey(e, id)}>
		<div class="flex flex-1 flex-col gap-1">
			<input
				type="password"
				bind:value={key}
				autocomplete="off"
				spellcheck="false"
				placeholder={p === 'claude' ? 'sk-ant-…' : 'sk-…'}
				aria-label={t('settings.accounts.apiKey')}
				aria-invalid={keyError ? 'true' : undefined}
				class="h-[26px] rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 font-mono text-xs text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
			/>
			{#if keyError}<span role="alert" class="text-xs text-(--vscode-errorForeground)">{keyError}</span>{/if}
		</div>
		<button type="submit" class={PRIMARY} disabled={saving || !key.trim()}>{t('settings.accounts.saveKey')}</button>
		<button type="button" class={GHOST} onclick={() => editKey(id)}>{t('settings.accounts.cancel')}</button>
	</form>
{/snippet}

<div class="h-full overflow-y-auto text-[13px]">
	<div class="mx-auto flex max-w-4xl flex-col gap-6 px-8 pt-10 pb-24">
		<header class="space-y-2 border-b border-(--vscode-widget-border)/60 pb-5">
			<h1 class="flex flex-wrap items-center gap-2 text-2xl leading-tight font-semibold">
				{t('settings.page.aiAccounts')}
				<span class="rounded-full bg-(--vscode-badge-background) px-2 py-0.5 text-[10px] font-medium tracking-[0.05em] text-(--vscode-badge-foreground) uppercase">{t('settings.page.optional')}</span>
			</h1>
			<p class="max-w-3xl text-sm leading-6 text-(--vscode-descriptionForeground)">{t('settings.accounts.description')}</p>
		</header>
		<div class="rounded-xl border border-(--vscode-widget-border)/50 bg-(--vscode-sideBar-background)/50 px-7 py-6 shadow-xs">
			<!-- OpenCode and Devin managed accounts (Orca's ManagedDataAccountsSection), added with the CLI. -->
			<div class="space-y-8">
				{#each DATA_PROVIDERS as dp (dp)}
					{@const state = managedAccounts.state[dp]}
					<section aria-label={DATA_TITLE[dp]} class="space-y-3">
						<div class="space-y-1">
							<h3 class="text-sm font-semibold">{DATA_TITLE[dp]}</h3>
							<p class="text-xs text-(--vscode-descriptionForeground)">{t('settings.managed.hint')}</p>
						</div>
						<code class="block font-mono text-[13px]">{addCommand(dp)}</code>
						<div class="flex items-center gap-2">
							<button class={[OUTLINE, 'h-8 px-3 text-[13px]']} onclick={() => copyAdd(dp)}>{copied[dp] ? t('settings.managed.copied') : t('settings.managed.copy')}</button>
							<button class={[GHOST, 'h-8 px-3 text-[13px] text-(--vscode-foreground)']} disabled={managedAccounts.busy} onclick={() => managedAccounts.load()}>{t('settings.managed.refresh')}</button>
						</div>
						{#if managedAccounts.error}<p role="alert" class="text-xs text-(--vscode-errorForeground)">{managedAccounts.error}</p>{/if}
						<div class="divide-y divide-(--vscode-widget-border)/40">
							<div class="flex items-center justify-between gap-3 py-2">
								<span class="text-[13px]">{t('settings.accounts.systemDefault')}</span>
								{#if !state?.activeAccountId}
									<span class="text-xs text-(--vscode-descriptionForeground)">{t('settings.accounts.active')}</span>
								{:else}
									<button class={OUTLINE} onclick={() => managedAccounts.select(dp, null)}>{t('settings.managed.select')}</button>
								{/if}
							</div>
							{#each state?.accounts ?? [] as a (a.id)}
								{@const on = state?.activeAccountId === a.id}
								<div class="flex items-center justify-between gap-3 py-2">
									<div class="min-w-0">
										<div class="flex items-center gap-2 text-[13px]">
											<span class="truncate">{a.label}</span>
											{#if on}<span class={BADGE}>{t('settings.accounts.active')}</span>{/if}
										</div>
										{#if a.integrations.length}<div class="truncate text-[11px] text-(--vscode-descriptionForeground)">{a.integrations.join(', ')}</div>{/if}
									</div>
									<div class="flex shrink-0 items-center gap-1">
										{#if !on}<button class={OUTLINE} onclick={() => managedAccounts.select(dp, a.id)}>{t('settings.managed.select')}</button>{/if}
										<button class={[GHOST, 'hover:text-(--vscode-errorForeground)']} onclick={() => managedAccounts.remove(dp, a.id)}><Icon name="trash" size={12} />{t('settings.managed.remove')}</button>
									</div>
								</div>
							{/each}
						</div>
					</section>
				{/each}
			</div>
			<hr class="my-8 border-(--vscode-widget-border)/60" />
			{#each PROVIDERS as p, i (p)}
				{@const title = PROVIDER_TITLE[p]}
				{@const me = own(p)}
				{@const systemActive = !hasActive(p)}
				{#if i}<hr class="my-8 border-(--vscode-widget-border)/60" />{/if}
				<section aria-label={title} class="space-y-4">
					<div class="space-y-1">
						<h3 class="flex items-center gap-2 text-sm font-semibold"><span class="grid place-items-center" style:color={ICON_COLOR[p]}><Icon name={ICON[p]} size={16} /></span>{title}</h3>
						<p class="text-xs text-(--vscode-descriptionForeground)">{t('settings.accounts.providerIntro', { provider: title })}</p>
					</div>
					<div class="space-y-3 py-2">
						<div class="flex items-center justify-between gap-3">
							<div class="space-y-0.5" title={t('settings.accounts.switching')}>
								<div class="text-sm leading-none font-medium">{t('settings.accounts.accounts')}</div>
								<p class="text-xs text-(--vscode-descriptionForeground)">{t('settings.accounts.showing')}</p>
							</div>
							<div class="flex shrink-0 items-center gap-1.5">
								<div class="inline-flex">
									<button class={[OUTLINE, 'rounded-r-none']} onclick={() => accounts.add(p, 'subscription')}><Icon name="plus" size={12} />{t('settings.accounts.add')}</button>
									<button
										class={[OUTLINE, '-ml-px rounded-l-none px-1.5']}
										aria-label={t('settings.accounts.moreAdd')}
										title={t('settings.accounts.moreAdd')}
										aria-haspopup="menu"
										onclick={(e) => openMenu(e, [menuItem('subscription', t('settings.accounts.addSubscription')), menuItem('api_key', t('settings.accounts.addApiKey'))], (id) => accounts.add(p, id as 'subscription' | 'api_key'))}
										><Icon name="chevronDown" size={12} /></button
									>
								</div>
								{#each list(p).filter((a) => accounts.loggingIn.includes(a.id)) as a (a.id)}
									<button class={GHOST} onclick={() => accounts.cancelLogin(a.id)}><Icon name="close" size={12} />{t('settings.accounts.cancel')}</button>
								{/each}
							</div>
						</div>
						<div role="radiogroup" aria-label={title} class="space-y-2">
							<!-- The system default: the provider's own login (Orca's "System default" card). -->
							<button
								type="button"
								role="radio"
								aria-checked={systemActive}
								class={[CARD, systemActive ? CARD_ACTIVE : CARD_IDLE]}
								onclick={() => !systemActive && accounts.setActive(p, null)}
							>
								<div class="flex min-w-0 flex-1 flex-col gap-0.5">
									<div class="flex min-w-0 items-center gap-2">
										<span class="truncate text-sm font-medium">{me?.signed_in && me.email ? t('settings.accounts.systemDefaultNamed', { email: me.email }) : t('settings.accounts.systemDefault')}</span>
										{#if systemActive}<span class={BADGE}>{t('settings.accounts.active')}</span>{/if}
										{#if !me?.signed_in}<span class={[BADGE, 'border-(--vscode-editorWarning-foreground)/50 text-(--vscode-editorWarning-foreground)']}>{t('settings.accounts.needsSignInBadge')}</span>{/if}
									</div>
									<span class="truncate text-[11px] text-(--vscode-descriptionForeground)">
										{me?.signed_in
											? [me.org, t('settings.accounts.systemHint', { provider: title, dir: OWN_DIR[p] })].filter(Boolean).join(' · ')
											: t('settings.accounts.notSignedIn', { command: LOGIN_COMMAND[p] })}
									</span>
									<!-- Signed out: the line above already says so; the usage fetch's own error would repeat it. -->
									{#if me?.signed_in}{@render usageLine(p, null)}{/if}
								</div>
							</button>
							{#each list(p) as a (a.id)}
								{@const busy = accounts.loggingIn.includes(a.id)}
								<div class={[CARD, a.active ? CARD_ACTIVE : CARD_IDLE]}>
									<div class="flex min-w-0 flex-1 flex-col">
										<button
											type="button"
											role="radio"
											aria-checked={a.active}
											aria-label={t('settings.accounts.useAccount', { name: a.label })}
											disabled={!a.signed_in || busy}
											class="flex min-w-0 flex-col gap-0.5 text-left disabled:cursor-default"
											onclick={() => !a.active && accounts.setActive(p, a.id)}
										>
											<div class="flex min-w-0 items-center gap-2">
												<span class="truncate text-sm font-medium">{a.email ?? a.label}</span>
												{#if a.email && a.email !== a.label}<span class="truncate text-xs text-(--vscode-descriptionForeground)">{a.label}</span>{/if}
												<span class={BADGE}>{t('settings.accounts.thisDevice')}</span>
												{#if a.kind === 'api_key'}<span class={BADGE}>{t('settings.accounts.apiKey')}</span>{/if}
												{#if a.active}<span class={BADGE}>{t('settings.accounts.active')}</span>{/if}
											</div>
											<span class={['truncate text-[11px]', a.signed_in || busy ? 'text-(--vscode-descriptionForeground)' : 'text-(--vscode-editorWarning-foreground)']}>{stateText(a)}</span>
										</button>
										{@render usageLine(p, a.id)}
										{#if accounts.editingKey === a.id}{@render keyForm(p, a.id)}{/if}
									</div>
									<div class="flex shrink-0 items-center gap-1 self-start">
										{#if a.kind === 'subscription'}
											<span class="inline-flex">
												<button class={GHOST} disabled={busy} onclick={() => accounts.login(a.id)}>
													<Icon name="refresh" size={12} />{a.signed_in ? t('settings.accounts.signInAgain') : t('settings.accounts.signIn')}
												</button>
												<button
													class={[GHOST, 'px-1']}
													disabled={busy}
													aria-label={t('settings.accounts.moreSignIn')}
													title={t('settings.accounts.moreSignIn')}
													aria-haspopup="menu"
													onclick={(e) => openMenu(e, [menuItem('terminal', t('settings.accounts.signInTerminal')), menuItem('copy', t('settings.accounts.copyLogin'))], (id) => (id === 'copy' ? accounts.copyLoginCommand(a.id) : accounts.login(a.id)))}
													><Icon name="chevronDown" size={12} /></button
												>
											</span>
										{:else}
											<button class={GHOST} onclick={() => editKey(a.id)}><Icon name="key" size={12} />{a.signed_in ? t('settings.accounts.changeKey') : t('settings.accounts.setKey')}</button>
										{/if}
										<button class={[GHOST, 'hover:text-(--vscode-errorForeground)']} onclick={() => accounts.remove(a.id)}><Icon name="trash" size={12} />{t('settings.accounts.remove')}</button>
									</div>
								</div>
							{:else}
								<div class="rounded-md border border-dashed border-(--vscode-widget-border) px-3 py-4 text-xs text-(--vscode-descriptionForeground)">{t('settings.accounts.empty', { provider: title })}</div>
							{/each}
						</div>
					</div>
				</section>
			{/each}
			<hr class="my-8 border-(--vscode-widget-border)/60" />
			<ProviderSections />
			<hr class="my-8 border-(--vscode-widget-border)/60" />
			<p class="text-xs leading-5 text-(--vscode-descriptionForeground)">{t('settings.accounts.storage')}</p>
		</div>
	</div>
</div>

{#if menu}
	{@const m = menu}
	<PopupMenu items={m.items} label={t('settings.accounts.accounts')} x={m.x} y={m.y} onRun={(node) => node.type === 'item' && m.run(node.id)} onClose={() => (menu = null)} />
{/if}
