<script lang="ts">
	// The AI Provider Accounts sections after Claude and Codex, as Orca's: Gemini CLI (legacy),
	// Antigravity, OpenCode Go, MiniMax, Grok, Cursor and the GLM Coding Plan. Credentials Kingu
	// keeps are typed into password fields and go straight to the Keychain (Rust); the CLIs' own
	// sign-ins are only read. Usage rows come from accounts/providers (providers.svelte.ts).
	import Icon from '#lib/workbench/Icon.svelte';
	import { openUrl } from '#lib/terminal/pty.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import Toggle from '#lib/settings/Toggle.svelte';
	import { providers, type CredentialName, type ExtraProvider, type ProviderUsage } from './providers.svelte';
	import { pct, resetLabel, type UsageWindow } from './usage';
	import { accounts } from './accounts.svelte';

	$effect(() => providers.start());
	$effect(() => void providers.antigravityAction('list'));

	/** Drafts of the credential inputs (cleared after a save). */
	let drafts = $state<Partial<Record<CredentialName, string>>>({});
	async function saveCredential(name: CredentialName) {
		const value = drafts[name]?.trim();
		if (!value) return;
		if (await providers.setCredential(name, value)) drafts = { ...drafts, [name]: '' };
	}

	async function setSetting(id: string, value: unknown) {
		try {
			await settings.set(id, value, 'user');
			void providers.refresh(true);
		} catch (e) {
			notifications.error(e instanceof Error ? e.message : String(e));
		}
	}

	const busy = (p: ExtraProvider) => providers.refreshing.includes(p) || providers.refreshing.includes('all');
	const windowsOf = (u: ProviderUsage | undefined, monthly = t('settings.providers.monthly')) =>
		u
			? ([
					[t('settings.providers.session'), u.session],
					[t('settings.providers.weekly'), u.weekly],
					[monthly, u.monthly]
				].filter(([, w]) => w) as [string, UsageWindow][])
			: [];

	const zcodeSite = $derived(settings.get<string>('kingu.usage.zcode.site') ?? 'zai');
	const minimaxCn = $derived(settings.get<string>('kingu.usage.minimax.endpoint') === 'cn');
	const agy = $derived(providers.antigravity);
	const ocg = $derived(providers.of('opencode-go'));
	const mmSet = $derived(providers.credentials['minimax:cookie'] || providers.credentials['minimax:api-key']);
	const g = $derived(providers.grok);
	const c = $derived(providers.cursor);
	const cu = $derived(providers.of('cursor'));
	const z = $derived(providers.zcode);
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
{#snippet status(on: boolean, bold: string | null, muted: string, p: ExtraProvider, error?: string | null)}
	<div class={CARD}>
		<span class={['mt-0.5 shrink-0', on ? 'text-(--vscode-foreground)' : 'text-(--vscode-descriptionForeground)/60']}><Icon name="shield" size={16} /></span>
		<div class="min-w-0 flex-1 space-y-0.5">
			{#if bold}<div class="truncate text-[13px] font-medium">{bold}</div>{/if}
			<div class="text-xs text-(--vscode-descriptionForeground)">{muted}</div>
			{#if error}<div class="text-xs text-(--vscode-errorForeground)">{error}</div>{/if}
		</div>
		<button class={OUTLINE} disabled={busy(p)} onclick={() => providers.refresh(true, p)}>
			<span class={['grid place-items-center', busy(p) && 'animate-spin']}><Icon name="refresh" size={12} /></span>{t('settings.providers.refreshUsage')}
		</button>
	</div>
{/snippet}

<!-- Usage rows: a percent badge, the window's name, when it resets. -->
{#snippet usage(u: ProviderUsage | undefined, withBuckets = true, monthly = t('settings.providers.monthly'))}
	{#if u && (windowsOf(u).length || (withBuckets && u.buckets.length))}
		<div class="space-y-1.5">
			{#if withBuckets}
				{#each u.buckets as b (b.name)}
					<div class="flex items-center gap-2 text-xs">
						<span class={BADGE}>{pct(b.window.used_percent)}%</span><span>{b.name}</span>
						{#if b.window.resets_at}<span class="text-(--vscode-descriptionForeground)">· {t('settings.providers.resets', { when: resetLabel(b.window, accounts.now) })}</span>{/if}
					</div>
				{/each}
			{/if}
			{#each windowsOf(u, monthly) as [label, w] (label)}
				<div class="flex items-center gap-2 text-xs">
					<span class={BADGE}>{pct(w.used_percent)}%</span><span>{label}</span>
					{#if w.resets_at}<span class="text-(--vscode-descriptionForeground)">· {t('settings.providers.resets', { when: resetLabel(w, accounts.now) })}</span>{/if}
				</div>
			{/each}
			{#if u.plan}<div class="text-[11px] text-(--vscode-descriptionForeground)">{t('settings.providers.plan', { plan: u.plan })}</div>{/if}
			{#if u.status === 'error' && u.error}<div class="text-[11px] text-(--vscode-errorForeground)">{t('settings.providers.lastKnown', { reason: u.error })}</div>{/if}
		</div>
	{:else if u?.error && u.status !== 'idle' && u.failure !== 'missing-credentials'}
		<!-- Missing credentials are what the section's own card or inputs already say. -->
		<p class={['text-xs', u.status === 'error' ? 'text-(--vscode-errorForeground)' : 'text-(--vscode-descriptionForeground)']}>{u.error}</p>
	{/if}
{/snippet}

<!-- A Keychain credential: label + Saved badge, a password field, Save / Replace, Forget. -->
{#snippet credential(name: CredentialName, label: string, hint: string, placeholder: string, forget: string)}
	{@const saved = providers.credentials[name] === true}
	<div class="space-y-1.5">
		<div class="flex items-center gap-2">
			<span class="text-[13px] font-medium">{label}</span>
			<span class={BADGE}><Icon name={saved ? 'check' : 'minus'} size={10} />{saved ? t('settings.providers.saved') : t('settings.providers.notSaved')}</span>
		</div>
		<form class="flex items-center gap-2" onsubmit={(e) => (e.preventDefault(), saveCredential(name))}>
			<input type="password" class={INPUT} autocomplete="off" spellcheck="false" aria-label={label} {placeholder} bind:value={drafts[name]} />
			<button type="submit" class={OUTLINE} disabled={!drafts[name]?.trim()}>{saved ? t('settings.providers.replace') : t('settings.providers.save')}</button>
			{#if saved}<button type="button" class={GHOST} onclick={() => providers.setCredential(name, null)}>{forget}</button>{/if}
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

<div class="space-y-8">
	<!-- Gemini CLI (legacy) -->
	<section id="accounts-gemini" class={SECTION}>
		{@render header(t('settings.providers.geminiTitle'), t('settings.providers.geminiHint'))}
		<div class="flex items-center justify-between gap-4">
			<div class="min-w-0 flex-1 space-y-1">
				<div class="text-sm leading-none font-medium">{t('settings.providers.geminiToggle')}</div>
				<p class="text-xs text-(--vscode-descriptionForeground)">{t('settings.providers.geminiToggleHint')}</p>
			</div>
			<Toggle checked={settings.get<boolean>('kingu.usage.gemini.cliOAuth') === true} label={t('settings.providers.geminiToggle')} onchange={(on) => setSetting('kingu.usage.gemini.cliOAuth', on || undefined)} />
		</div>
		{#if settings.get<boolean>('kingu.usage.gemini.cliOAuth') === true}{@render usage(providers.of('gemini'))}{/if}
	</section>
	<hr class="border-(--vscode-widget-border)/60" />

	<!-- Antigravity -->
	<section id="accounts-antigravity" class={SECTION}>
		{@render header(t('settings.providers.agyTitle'), t('settings.providers.agyHint'), { label: t('settings.providers.agyDocs'), url: 'https://antigravity.google/docs/cli/install/' })}
		<p class="text-xs text-(--vscode-descriptionForeground)">{t('settings.providers.agyHelp')}</p>
		{#if providers.antigravityError}<p role="alert" class="text-xs text-(--vscode-errorForeground)">{providers.antigravityError}</p>{/if}
		<div class="text-[13px]">
			{agy?.currentAccount ? (agy.currentAccount.email ?? t('settings.providers.agyNoIdentity')) : t('settings.providers.agyNone')}
		</div>
		{#if agy?.selectedAccountId && agy.selectedAccountId !== agy.activeAccountId}
			<p class="text-xs text-(--vscode-errorForeground)">{t('settings.providers.agyChanged')}</p>
		{/if}
		<div class="flex flex-wrap items-center gap-2">
			<button class={OUTLINE} disabled={!agy?.currentAccount?.identityKnown} onclick={() => providers.antigravityAction('add-current')}>{t('settings.providers.agySave')}</button>
			<button class={OUTLINE} onclick={() => providers.antigravityAction('list')}>{t('settings.providers.agyRefresh')}</button>
			<button class={GHOST} disabled={!agy?.currentAccount || busy('antigravity')} onclick={() => providers.refresh(true, 'antigravity')}>{t('settings.providers.refreshUsage')}</button>
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
					<button class={OUTLINE} disabled={selected && active} onclick={() => providers.antigravityAction('select', a.id)}>{selected && active ? t('settings.providers.agySelected') : t('settings.providers.agySelect')}</button>
					<button class={GHOST} disabled={active || selected} onclick={() => providers.antigravityAction('remove', a.id)}>{t('settings.providers.agyRemove')}</button>
				</div>
			</div>
		{/each}
		<div class="flex items-center justify-between gap-4">
			<div class="min-w-0 flex-1 space-y-1">
				<div class="text-[13px] font-medium">{t('settings.providers.agyStatusBar')}</div>
				<p class="text-xs text-(--vscode-descriptionForeground)">{t('settings.providers.agyStatusBarHint')}</p>
			</div>
			<Toggle checked={settings.get<boolean>('kingu.statusBar.antigravity.visible') !== false} label={t('settings.providers.agyStatusBar')} onchange={(on) => setSetting('kingu.statusBar.antigravity.visible', on ? undefined : false)} />
		</div>
		{@render usage(providers.of('antigravity'))}
		<p class="text-[11px] text-(--vscode-descriptionForeground)">{t('settings.providers.agyFooter')}</p>
	</section>
	<hr class="border-(--vscode-widget-border)/60" />

	<!-- OpenCode Go -->
	<section id="accounts-opencode-go" class={SECTION}>
		{@render header(t('settings.providers.ocgTitle'), t('settings.providers.ocgHint'))}
		{@render credential('opencode-go:api-key', t('settings.providers.ocgKey'), t('settings.providers.ocgKeyHelp'), t('settings.providers.ocgKeyPlaceholder'), t('settings.providers.clear'))}
		<p class="-mt-2 text-[11px] text-(--vscode-descriptionForeground)">{t('settings.providers.ocgKeyHint')}</p>
		{@render credential('opencode-go:cookie', t('settings.providers.ocgCookie'), t('settings.providers.ocgCookieHelp'), 'auth=…; __Host-console_session=…', t('settings.providers.clear'))}
		{@render textSetting('kingu.usage.opencodeGo.workspaceId', t('settings.providers.ocgWorkspace'), t('settings.providers.ocgWorkspaceHint'), 'wrk_…')}
		{@render usage(ocg)}
		{#if ocg?.balance != null}<p class="text-xs">{t('settings.providers.ocgBalance', { amount: ocg.balance.toFixed(2) })}</p>{/if}
	</section>
	<hr class="border-(--vscode-widget-border)/60" />

	<!-- MiniMax -->
	<section id="accounts-minimax" class={SECTION}>
		{@render header(t('settings.providers.mmTitle'), t('settings.providers.mmHint'), {
			label: t('settings.providers.mmConsole'),
			url: minimaxCn ? 'https://platform.minimaxi.com/console/usage' : 'https://platform.minimax.io/console/usage'
		})}
		{@render status(!!mmSet, mmSet ? t('settings.providers.mmStored') : t('settings.providers.mmNotSet'), t('settings.providers.mmStoredHint'), 'minimax')}
		<div class="flex items-center justify-between gap-4">
			<div class="min-w-0 flex-1 space-y-1">
				<div class="text-[13px] font-medium">{t('settings.providers.mmEndpoint')}</div>
				<p class="text-xs text-(--vscode-descriptionForeground)">{t('settings.providers.mmEndpointHint')}</p>
			</div>
			<select
				class="h-7 rounded-md border border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) px-1.5 text-xs text-(--vscode-dropdown-foreground)"
				value={minimaxCn ? 'cn' : 'overseas'}
				onchange={(e) => setSetting('kingu.usage.minimax.endpoint', e.currentTarget.value === 'cn' ? 'cn' : undefined)}
			>
				<option value="overseas">{t('settings.providers.mmOverseas')}</option>
				<option value="cn">{t('settings.providers.mmChina')}</option>
			</select>
		</div>
		{@render credential('minimax:cookie', t('settings.providers.mmCookie'), t('settings.providers.mmCookieHint'), t('settings.providers.mmCookiePlaceholder'), t('settings.providers.mmForgetCookie'))}
		{@render credential('minimax:api-key', t('settings.providers.mmKey'), t('settings.providers.mmKeyHint'), t('settings.providers.mmKeyPlaceholder'), t('settings.providers.mmForgetKey'))}
		{@render textSetting('kingu.usage.minimax.groupId', t('settings.providers.mmGroup'), t('settings.providers.mmGroupHint'), '')}
		{@render textSetting('kingu.usage.minimax.models', t('settings.providers.mmModels'), t('settings.providers.mmModelsHint'), 'general')}
		{@render usage(providers.of('minimax'))}
	</section>
	<hr class="border-(--vscode-widget-border)/60" />

	<!-- Grok -->
	<section id="accounts-grok" class={SECTION}>
		{@render header(t('settings.providers.grokTitle'), t('settings.providers.grokHint'), { label: t('settings.providers.grokDocs'), url: 'https://docs.x.ai/build/overview' })}
		{#if !g}
			{@render status(false, null, t('settings.providers.loading'), 'grok')}
		{:else if g.signedIn}
			{@render status(g.tokenFresh, g.email ?? t('settings.providers.signedIn'), g.tokenFresh ? t('settings.providers.grokSignedIn') : t('settings.providers.grokExpired'), 'grok', g.error)}
		{:else}
			{@render status(false, t('settings.providers.grokSignedOut'), t('settings.providers.grokSignedOutHint'), 'grok', g.error)}
		{/if}
		{@render usage(providers.of('grok'))}
	</section>
	<hr class="border-(--vscode-widget-border)/60" />

	<!-- Cursor -->
	<section id="accounts-cursor" class={SECTION}>
		{@render header(t('settings.providers.cursorTitle'), t('settings.providers.cursorHint'), { label: t('settings.providers.cursorDashboard'), url: 'https://cursor.com/dashboard/spending' })}
		{#if !c}
			{@render status(false, null, t('settings.providers.loading'), 'cursor')}
		{:else if c.signedIn}
			{@const source = c.credentialSource === 'keychain' ? t('settings.providers.cursorKeychain') : c.credentialSource === 'cli' ? t('settings.providers.cursorCli') : t('settings.providers.cursorIde')}
			{@render status(c.tokenFresh, c.email ?? c.displayName ?? t('settings.providers.signedIn'), c.tokenFresh ? t('settings.providers.cursorReads', { source }) : t('settings.providers.cursorExpired'), 'cursor', c.error)}
		{:else}
			{@render status(false, t('settings.providers.cursorNone'), t('settings.providers.cursorNoneHint'), 'cursor', c.error)}
		{/if}
		{#if cu && (cu.buckets.length || cu.monthly)}
			<div class="space-y-1">
				<div class="text-[13px] font-medium">{t('settings.providers.cursorUsage')}</div>
				<p class="text-xs text-(--vscode-descriptionForeground)">{t('settings.providers.cursorUsageHint')}</p>
			</div>
		{/if}
		{@render usage(cu)}
	</section>
	<hr class="border-(--vscode-widget-border)/60" />

	<!-- GLM Coding Plan (ZCode) -->
	<section id="accounts-zcode" class={SECTION}>
		{@render header(t('settings.providers.zcTitle'), t('settings.providers.zcHint'), {
			label: t('settings.providers.zcGetKey'),
			url: zcodeSite === 'bigmodel' ? 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys' : 'https://z.ai/manage-apikey'
		})}
		{#if z?.apiKeyConfigured}
			{@render status(true, t('settings.providers.zcKeySaved', { site: siteName }), t('settings.providers.zcKeySavedHint'), 'zcode', providers.of('zcode')?.status === 'error' ? providers.of('zcode')?.error : null)}
		{:else if z?.zcodeCliConfigured}
			{@render status(true, t('settings.providers.zcCli'), t('settings.providers.zcCliHint'), 'zcode')}
		{:else}
			{@render status(false, t('settings.providers.zcNone'), t('settings.providers.zcNoneHint'), 'zcode')}
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
		{@render credential('zcode:api-key', t('settings.providers.zcKey'), t('settings.providers.zcKeyHint'), t('settings.providers.zcKeyPlaceholder'), t('settings.providers.zcForget'))}
		{@render usage(providers.of('zcode'), false, t('settings.providers.zcMcp'))}
	</section>
</div>
