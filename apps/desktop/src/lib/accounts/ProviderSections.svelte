<script lang="ts">
	// The AI Provider Accounts sections after Claude and Codex, as Orca's: Gemini CLI (legacy),
	// Antigravity, OpenCode Go, MiniMax, Kimi, Grok, Cursor and the GLM Coding Plan. Keys and
	// cookies are typed into password fields and go straight to the Keychain (usage/secrets.rs);
	// the CLIs' own sign-ins are only read. Usage rows come from the shared usage store.
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '#lib/workbench/Icon.svelte';
	import { openUrl } from '#lib/terminal/pty.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import Toggle from '#lib/settings/Toggle.svelte';
	import { usage as live } from '#lib/workbench/usage.svelte.ts';
	import { clampPct, PROVIDER_NAME, windowWhen, type ProviderId, type ProviderState, type Window } from '#lib/workbench/usage.ts';
	import { loadSecretStatus, pastable, saveSecret, toStatus, type SecretId, type SecretStatus } from '#lib/workbench/usageCredentials.ts';

	type AgyIdentity = { email: string | null; subject: string | null; authMethod: string; identityKnown: boolean };
	type AgyState = {
		accounts: { id: string; email: string | null; subject: string | null; authMethod: string; createdAt: number }[];
		activeAccountId: string | null;
		selectedAccountId: string | null;
		currentAccount: AgyIdentity | null;
	};

	const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

	let saved = $state<SecretStatus>(toStatus(null));
	let agy = $state<AgyState | null>(null);
	let agyError = $state('');

	async function antigravity(action: 'list' | 'add-current' | 'select' | 'remove', id?: string) {
		try {
			agy = await invoke<AgyState>('antigravity_accounts', { action, id: id ?? null });
			agyError = '';
		} catch (e) {
			agyError = message(e);
		}
	}

	$effect(() => {
		void loadSecretStatus().then((s) => (saved = s));
		void antigravity('list');
		// The status bar polls; a page opened before its first reading asks once.
		if (!live.refreshing && (['opencode', 'minimax', 'grok', 'cursor', 'zcode'] as ProviderId[]).every((p) => !live.providers[p])) void live.refresh();
	});

	/** Drafts of the credential inputs (cleared after a save). */
	let drafts = $state<Partial<Record<SecretId, string>>>({});
	async function store(id: SecretId, value: string) {
		try {
			await saveSecret(id, value);
			drafts = { ...drafts, [id]: '' };
			void live.refresh();
		} catch (e) {
			notifications.error(message(e));
		} finally {
			saved = await loadSecretStatus();
		}
	}

	async function setSetting(id: string, value: unknown) {
		try {
			await settings.set(id, value, 'user');
			void live.refresh();
		} catch (e) {
			notifications.error(message(e));
		}
	}

	const of = (p: ProviderId) => live.providers[p];
	const windowsOf = (u: ProviderState | null, monthly = t('settings.providers.monthly')) =>
		u
			? ([
					[t('settings.providers.session'), u.session],
					[t('settings.providers.weekly'), u.weekly],
					[monthly, u.monthly]
				].filter(([, w]) => w) as [string, Window][])
			: [];
	/** A sign-in the provider could read: anything but not set up or missing credentials. */
	const found = (u: ProviderState | null) => !!u && u.status !== 'unavailable' && u.failureKind !== 'missing-credentials';
	const expired = (u: ProviderState | null) => u?.failureKind === 'stale-token' || u?.failureKind === 'delegated-refresh-required';
	const loading = (u: ProviderState | null) => !u || u.status === 'idle' || (u.status === 'fetching' && !u.updatedAt);
	const failed = (u: ProviderState | null) => (u?.status === 'error' && !expired(u) ? u.error : null);

	const zcodeSite = $derived(settings.get<string>('kingu.usage.zcode.site') ?? 'zai');
	const minimaxCn = $derived(settings.get<string>('kingu.usage.minimax.endpoint') === 'cn');
	const gemini = $derived(settings.get<boolean>('kingu.usage.gemini') === true);
	const agyUsage = $derived(settings.get<boolean>('kingu.usage.antigravity') === true);
	const mmSet = $derived(saved['minimax.cookie'] || saved['minimax.apiKey']);
	const grok = $derived(of('grok'));
	const cursor = $derived(of('cursor'));
	const kimi = $derived(of('kimi'));
	const zcode = $derived(of('zcode'));
	const siteName = $derived(zcodeSite === 'bigmodel' ? 'Zhipu · BigModel' : 'Z.AI');

	const SECTION = 'space-y-4';
	const OUTLINE = 'inline-flex h-6 items-center gap-1.5 rounded-md border border-(--vscode-widget-border) px-2 text-xs hover:bg-(--vscode-list-hoverBackground) disabled:opacity-50';
	const GHOST = 'inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:opacity-40';
	const BADGE = 'inline-flex h-5 shrink-0 items-center gap-1 rounded border border-(--vscode-widget-border) px-1.5 text-[10px] font-medium text-(--vscode-foreground)/75';
	const INPUT = 'h-7 min-w-0 flex-1 rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 text-xs text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)';
	const CARD = 'flex items-start gap-3 rounded-md border border-(--vscode-widget-border) px-3 py-2.5';
</script>

<!-- Section header: title, subtitle, and a link at the right (Orca's provider headers). -->
{#snippet header(title: string, hint: string, link?: { label: string; url: string })}
	<div class="flex items-start justify-between gap-3">
		<div class="space-y-1">
			<h3 class="text-sm font-semibold">{title}</h3>
			<p class="text-xs text-(--vscode-descriptionForeground)">{hint}</p>
		</div>
		{#if link}
			<button class={[GHOST, 'shrink-0 whitespace-nowrap']} onclick={() => void openUrl(link.url)}>{link.label}<Icon name="openExternal" size={12} /></button>
		{/if}
	</div>
{/snippet}

<!-- A status card with the shield, a bold and a muted line, and Refresh usage. -->
{#snippet status(on: boolean, bold: string | null, muted: string, error?: string | null)}
	<div class={CARD}>
		<span class={['mt-0.5 shrink-0', on ? 'text-(--vscode-foreground)' : 'text-(--vscode-descriptionForeground)/60']}><Icon name="shield" size={16} /></span>
		<div class="min-w-0 flex-1 space-y-0.5">
			{#if bold}<div class="truncate text-[13px] font-medium">{bold}</div>{/if}
			<div class="text-xs text-(--vscode-descriptionForeground)">{muted}</div>
			{#if error}<div class="text-xs text-(--vscode-errorForeground)">{error}</div>{/if}
		</div>
		<button class={OUTLINE} disabled={live.refreshing} onclick={() => live.refresh()}>
			<span class={['grid place-items-center', live.refreshing && 'animate-spin']}><Icon name="refresh" size={12} /></span>{t('settings.providers.refreshUsage')}
		</button>
	</div>
{/snippet}

<!-- One usage row: a percent badge, the window's name, when it resets. -->
{#snippet row(label: string, w: Window)}
	<div class="flex items-center gap-2 text-xs">
		<span class={BADGE}>{clampPct(w.usedPercent)}%</span><span>{label}</span>
		{#if w.resetsAt !== null}<span class="text-(--vscode-descriptionForeground)">· {t('settings.providers.resets', { when: windowWhen(w, live.now) })}</span>{/if}
	</div>
{/snippet}

<!-- Usage rows: the named pools, then session / weekly / monthly, the plan and a stale reason. -->
{#snippet usage(u: ProviderState | null, withBuckets = true, monthly = t('settings.providers.monthly'))}
	{#if u && (windowsOf(u).length || (withBuckets && u.buckets?.length))}
		<div class="space-y-1.5">
			{#if withBuckets}
				{#each u.buckets ?? [] as b (b.name)}{@render row(b.name, b)}{/each}
			{/if}
			{#each windowsOf(u, monthly) as [label, w] (label)}{@render row(label, w)}{/each}
			{#if u.planType}<div class="text-[11px] text-(--vscode-descriptionForeground)">{t('settings.providers.plan', { plan: u.planType })}</div>{/if}
			{#if u.status === 'error' && u.error}<div class="text-[11px] text-(--vscode-errorForeground)">{t('settings.providers.lastKnown', { reason: u.error })}</div>{/if}
		</div>
	{:else if u?.error && u.status !== 'idle' && u.status !== 'unavailable' && u.failureKind !== 'missing-credentials'}
		<!-- Missing credentials are what the section's own card or inputs already say. -->
		<p class={['text-xs', u.status === 'error' ? 'text-(--vscode-errorForeground)' : 'text-(--vscode-descriptionForeground)']}>{u.error}</p>
	{/if}
{/snippet}

<!-- A Keychain credential: label + Saved badge, a password field, Save / Replace, Forget. -->
{#snippet credential(id: SecretId, label: string, hint: string, placeholder: string, forget: string)}
	<div class="space-y-1.5">
		<div class="flex items-center gap-2">
			<span class="text-[13px] font-medium">{label}</span>
			<span class={BADGE}><Icon name={saved[id] ? 'check' : 'minus'} size={10} />{saved[id] ? t('settings.providers.saved') : t('settings.providers.notSaved')}</span>
		</div>
		<form class="flex items-center gap-2" onsubmit={(e) => (e.preventDefault(), pastable(drafts[id] ?? '') && store(id, drafts[id] ?? ''))}>
			<input type="password" class={INPUT} autocomplete="off" spellcheck="false" aria-label={label} {placeholder} bind:value={drafts[id]} />
			<button type="submit" class={OUTLINE} disabled={!pastable(drafts[id] ?? '')}>{saved[id] ? t('settings.providers.replace') : t('settings.providers.save')}</button>
			{#if saved[id]}<button type="button" class={GHOST} onclick={() => store(id, '')}>{forget}</button>{/if}
		</form>
		<p class="text-[11px] text-(--vscode-descriptionForeground)">{hint}</p>
	</div>
{/snippet}

<!-- A text setting saved on change (Workspace ID, Group ID, model names). -->
{#snippet textSetting(id: string, label: string, hint: string, placeholder: string)}
	<label class="block space-y-1">
		<span class="text-[13px] font-medium">{label}</span>
		<input class={[INPUT, 'w-full']} {placeholder} value={settings.get<string>(id) ?? ''} onchange={(e) => setSetting(id, e.currentTarget.value.trim() || undefined)} />
		<span class="block text-[11px] text-(--vscode-descriptionForeground)">{hint}</span>
	</label>
{/snippet}

<!-- A switch row: label and hint at the left. -->
{#snippet toggleRow(label: string, hint: string, on: boolean, change: (on: boolean) => void)}
	<div class="flex items-center justify-between gap-4">
		<div class="min-w-0 flex-1 space-y-1">
			<div class="text-[13px] font-medium">{label}</div>
			<p class="text-xs text-(--vscode-descriptionForeground)">{hint}</p>
		</div>
		<Toggle checked={on} {label} onchange={change} />
	</div>
{/snippet}

<div class="space-y-8">
	<!-- Gemini CLI (legacy) -->
	<section id="accounts-gemini" class={SECTION}>
		{@render header(t('settings.providers.geminiTitle'), t('settings.providers.geminiHint'))}
		{@render toggleRow(t('settings.providers.geminiToggle'), t('settings.providers.geminiToggleHint'), gemini, (on) => setSetting('kingu.usage.gemini', on || undefined))}
		{#if gemini}{@render usage(of('gemini'))}{/if}
	</section>
	<hr class="border-(--vscode-widget-border)/60" />

	<!-- Antigravity -->
	<section id="accounts-antigravity" class={SECTION}>
		{@render header(t('settings.providers.agyTitle'), t('settings.providers.agyHint'), { label: t('settings.providers.agyDocs'), url: 'https://antigravity.google/docs/cli/install/' })}
		<p class="text-xs text-(--vscode-descriptionForeground)">{t('settings.providers.agyHelp')}</p>
		{#if agyError}<p role="alert" class="text-xs text-(--vscode-errorForeground)">{agyError}</p>{/if}
		<div class="text-[13px]">
			{agy?.currentAccount ? (agy.currentAccount.email ?? t('settings.providers.agyNoIdentity')) : t('settings.providers.agyNone')}
		</div>
		{#if agy?.selectedAccountId && agy.selectedAccountId !== agy.activeAccountId}
			<p class="text-xs text-(--vscode-errorForeground)">{t('settings.providers.agyChanged')}</p>
		{/if}
		<div class="flex flex-wrap items-center gap-2">
			<button class={OUTLINE} disabled={!agy?.currentAccount?.identityKnown} onclick={() => antigravity('add-current')}>{t('settings.providers.agySave')}</button>
			<button class={OUTLINE} onclick={() => antigravity('list')}>{t('settings.providers.agyRefresh')}</button>
			<button class={GHOST} disabled={!agy?.currentAccount || !agyUsage || live.refreshing} onclick={() => live.refresh()}>{t('settings.providers.refreshUsage')}</button>
		</div>
		{#each agy?.accounts ?? [] as a (a.id)}
			{@const active = agy?.activeAccountId === a.id}
			{@const selected = agy?.selectedAccountId === a.id}
			<div class="flex items-center justify-between gap-3 rounded-md border border-(--vscode-widget-border) px-3 py-2">
				<div class="flex min-w-0 items-center gap-2 text-[13px]">
					<span class="truncate">{a.email ?? t('settings.providers.agySaved')}</span>
					{#if active}<span class={BADGE}>{t('settings.providers.agyNative')}</span>{/if}
				</div>
				<div class="flex shrink-0 items-center gap-1">
					<button class={OUTLINE} disabled={selected && active} onclick={() => antigravity('select', a.id)}>{selected && active ? t('settings.providers.agySelected') : t('settings.providers.agySelect')}</button>
					<button class={GHOST} disabled={active || selected} onclick={() => antigravity('remove', a.id)}>{t('settings.providers.agyRemove')}</button>
				</div>
			</div>
		{/each}
		{@render toggleRow(t('settings.providers.agyStatusBar'), t('settings.providers.agyStatusBarHint'), agyUsage, (on) => setSetting('kingu.usage.antigravity', on || undefined))}
		{#if agyUsage}{@render usage(of('antigravity'))}{/if}
		<p class="text-[11px] text-(--vscode-descriptionForeground)">{t('settings.providers.agyFooter')}</p>
	</section>
	<hr class="border-(--vscode-widget-border)/60" />

	<!-- OpenCode Go -->
	<section id="accounts-opencode-go" class={SECTION}>
		{@render header(t('settings.providers.ocgTitle'), t('settings.providers.ocgHint'))}
		{@render credential('opencode.apiKey', t('settings.providers.ocgKey'), t('settings.providers.ocgKeyHelp'), t('settings.providers.ocgKeyPlaceholder'), t('settings.providers.clear'))}
		<p class="-mt-2 text-[11px] text-(--vscode-descriptionForeground)">{t('settings.providers.ocgKeyHint')}</p>
		{@render credential('opencode.cookie', t('settings.providers.ocgCookie'), t('settings.providers.ocgCookieHelp'), 'auth=…; __Host-console_session=…', t('settings.providers.clear'))}
		{@render textSetting('kingu.usage.opencode.workspaceId', t('settings.providers.ocgWorkspace'), t('settings.providers.ocgWorkspaceHint'), 'wrk_…')}
		{@render usage(of('opencode'))}
	</section>
	<hr class="border-(--vscode-widget-border)/60" />

	<!-- MiniMax -->
	<section id="accounts-minimax" class={SECTION}>
		{@render header(t('settings.providers.mmTitle'), t('settings.providers.mmHint'), {
			label: t('settings.providers.mmConsole'),
			url: minimaxCn ? 'https://platform.minimaxi.com/console/usage' : 'https://platform.minimax.io/console/usage'
		})}
		{@render status(!!mmSet, mmSet ? t('settings.providers.mmStored') : t('settings.providers.mmNotSet'), t('settings.providers.mmStoredHint'))}
		<div class="flex items-center justify-between gap-4">
			<div class="min-w-0 flex-1 space-y-1">
				<div class="text-[13px] font-medium">{t('settings.providers.mmEndpoint')}</div>
				<p class="text-xs text-(--vscode-descriptionForeground)">{t('settings.providers.mmEndpointHint')}</p>
			</div>
			<select
				class="h-7 rounded-md border border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) px-1.5 text-xs text-(--vscode-dropdown-foreground)"
				aria-label={t('settings.providers.mmEndpoint')}
				value={minimaxCn ? 'cn' : 'overseas'}
				onchange={(e) => setSetting('kingu.usage.minimax.endpoint', e.currentTarget.value === 'cn' ? 'cn' : undefined)}
			>
				<option value="overseas">{t('settings.providers.mmOverseas')}</option>
				<option value="cn">{t('settings.providers.mmChina')}</option>
			</select>
		</div>
		{@render credential('minimax.cookie', t('settings.providers.mmCookie'), t('settings.providers.mmCookieHint'), t('settings.providers.mmCookiePlaceholder'), t('settings.providers.mmForgetCookie'))}
		{@render credential('minimax.apiKey', t('settings.providers.mmKey'), t('settings.providers.mmKeyHint'), t('settings.providers.mmKeyPlaceholder'), t('settings.providers.mmForgetKey'))}
		{@render textSetting('kingu.usage.minimax.groupId', t('settings.providers.mmGroup'), t('settings.providers.mmGroupHint'), '')}
		{@render textSetting('kingu.usage.minimax.models', t('settings.providers.mmModels'), t('settings.providers.mmModelsHint'), 'general')}
		{@render usage(of('minimax'))}
	</section>
	<hr class="border-(--vscode-widget-border)/60" />

	<!-- Kimi -->
	<section id="accounts-kimi" class={SECTION}>
		{@render header(PROVIDER_NAME.kimi, t('settings.providers.kimiHint'))}
		{#if loading(kimi)}
			{@render status(false, null, t('settings.providers.loading'))}
		{:else if found(kimi)}
			{@render status(!expired(kimi), t('settings.providers.signedIn'), expired(kimi) ? t('settings.providers.kimiExpired') : t('usage.cli.kimi'), failed(kimi))}
		{:else}
			{@render status(false, t('settings.providers.kimiSignedOut'), t('usage.cli.kimi'))}
		{/if}
		{@render usage(kimi)}
	</section>
	<hr class="border-(--vscode-widget-border)/60" />

	<!-- Grok -->
	<section id="accounts-grok" class={SECTION}>
		{@render header(t('settings.providers.grokTitle'), t('settings.providers.grokHint'), { label: t('settings.providers.grokDocs'), url: 'https://docs.x.ai/build/overview' })}
		{#if loading(grok)}
			{@render status(false, null, t('settings.providers.loading'))}
		{:else if found(grok)}
			{@render status(!expired(grok), t('settings.providers.signedIn'), expired(grok) ? t('settings.providers.grokExpired') : t('settings.providers.grokSignedIn'), failed(grok))}
		{:else}
			{@render status(false, t('settings.providers.grokSignedOut'), t('settings.providers.grokSignedOutHint'))}
		{/if}
		{@render usage(grok)}
	</section>
	<hr class="border-(--vscode-widget-border)/60" />

	<!-- Cursor -->
	<section id="accounts-cursor" class={SECTION}>
		{@render header(t('settings.providers.cursorTitle'), t('settings.providers.cursorHint'), { label: t('settings.providers.cursorDashboard'), url: 'https://cursor.com/dashboard/spending' })}
		{#if loading(cursor)}
			{@render status(false, null, t('settings.providers.loading'))}
		{:else if found(cursor)}
			{@render status(!expired(cursor), t('settings.providers.signedIn'), expired(cursor) ? t('settings.providers.cursorExpired') : t('usage.cli.cursor'), failed(cursor))}
		{:else}
			{@render status(false, t('settings.providers.cursorNone'), t('settings.providers.cursorNoneHint'))}
		{/if}
		{#if cursor && (cursor.buckets?.length || cursor.monthly)}
			<div class="space-y-1">
				<div class="text-[13px] font-medium">{t('settings.providers.cursorUsage')}</div>
				<p class="text-xs text-(--vscode-descriptionForeground)">{t('settings.providers.cursorUsageHint')}</p>
			</div>
		{/if}
		{@render usage(cursor)}
	</section>
	<hr class="border-(--vscode-widget-border)/60" />

	<!-- GLM Coding Plan (ZCode) -->
	<section id="accounts-zcode" class={SECTION}>
		{@render header(t('settings.providers.zcTitle'), t('settings.providers.zcHint'), {
			label: t('settings.providers.zcGetKey'),
			url: zcodeSite === 'bigmodel' ? 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys' : 'https://z.ai/manage-apikey'
		})}
		{#if saved['zcode.apiKey']}
			{@render status(true, t('settings.providers.zcKeySaved', { site: siteName }), t('settings.providers.zcKeySavedHint'), failed(zcode))}
		{:else if found(zcode)}
			{@render status(true, t('settings.providers.zcCli'), t('settings.providers.zcCliHint'), failed(zcode))}
		{:else}
			{@render status(false, t('settings.providers.zcNone'), t('settings.providers.zcNoneHint'))}
		{/if}
		<div class="flex items-center justify-between gap-4">
			<div class="min-w-0 flex-1 space-y-1">
				<div class="text-[13px] font-medium">{t('settings.providers.zcSite')}</div>
				<p class="text-xs text-(--vscode-descriptionForeground)">{t('settings.providers.zcSiteHint')}</p>
			</div>
			<select
				class="h-7 rounded-md border border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) px-1.5 text-xs text-(--vscode-dropdown-foreground)"
				aria-label={t('settings.providers.zcSite')}
				value={zcodeSite}
				onchange={(e) => setSetting('kingu.usage.zcode.site', e.currentTarget.value === 'bigmodel' ? 'bigmodel' : undefined)}
			>
				<option value="zai">Z.AI (z.ai)</option>
				<option value="bigmodel">Zhipu · BigModel (open.bigmodel.cn)</option>
			</select>
		</div>
		{@render credential('zcode.apiKey', t('settings.providers.zcKey'), t('settings.providers.zcKeyHint'), t('settings.providers.zcKeyPlaceholder'), t('settings.providers.zcForget'))}
		{@render usage(zcode, false, t('settings.providers.zcMcp'))}
	</section>
</div>
