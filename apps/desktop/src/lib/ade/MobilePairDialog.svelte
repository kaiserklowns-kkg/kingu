<script lang="ts">
	// Mobile: Pair Device… (Orca's Mobile page: MobileHero, NetworkInterfacePicker, paired devices).
	// Phone access is off until switched on here; a code is single-use and replaced a minute before
	// it expires. Rules: MECHANICS.md › Mobile pairing.
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { mobilePairing as m } from './mobile.svelte';
	import { minutesLeft } from './mobile';

	$effect(() => {
		const timer = setInterval(() => m.tick(), 1000);
		return () => clearInterval(timer);
	});

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			m.close();
		}
	}
	const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	const s = $derived(m.status);
	const address = $derived(m.address ?? s?.default_address ?? '');
	const MUTED = 'text-(--vscode-descriptionForeground)';
	const BTN = 'h-7 rounded-md px-2.5 text-[12px] hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
	const PRIMARY = 'h-7 rounded-md bg-(--vscode-button-background) px-3 text-[12px] text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground) disabled:opacity-40';
	const ICON_BTN = 'grid size-6 shrink-0 place-items-center rounded text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)';
</script>

<svelte:window {onkeydown} />

<div class="fixed inset-0 z-[65] grid place-items-center bg-black/40 p-6" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && m.close()}>
	<div role="dialog" aria-modal="true" aria-labelledby="kg-mobile-title" class="flex max-h-[85vh] w-full max-w-[620px] flex-col overflow-hidden rounded-xl border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) text-(--vscode-foreground) shadow-2xl shadow-black/50">
		<header class="flex items-center gap-2.5 px-5 pt-5 pb-2">
			<h2 id="kg-mobile-title" class="flex-1 text-[14px] font-semibold">{t('mobile.title')}</h2>
			<button class={ICON_BTN} aria-label={t('common.close')} title={t('common.close')} onclick={() => m.close()}><Icon name="close" size={14} /></button>
		</header>
		<div class="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
			<p class="text-[12px] {MUTED}">{t('mobile.intro')}</p>

			<label class="mt-3 flex items-start gap-2 text-[13px]">
				<input type="checkbox" class="mt-0.5" checked={s?.enabled ?? false} disabled={m.busy || !s} onchange={(e) => m.setEnabled(e.currentTarget.checked)} />
				<span>
					<span class="block">{t('mobile.enable')}</span>
					<span class="block text-[11px] {MUTED}">{t('mobile.enableHint', { port: s?.port ?? 6768 })}</span>
				</span>
			</label>
			{#if m.error || s?.error}<p class="mt-2 text-[12px] text-(--vscode-errorForeground)">{m.error ?? s?.error}</p>{/if}

			{#if s?.running}
				<div class="mt-4 flex flex-wrap items-center gap-2">
					<label for="kg-mobile-address" class="text-[12px] {MUTED}">{t('mobile.address')}</label>
					<select id="kg-mobile-address" class="h-7 min-w-0 flex-1 rounded-md border border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) px-2 text-[12px]" value={address} onchange={(e) => m.pickAddress(e.currentTarget.value)}>
						{#if !s.addresses.length && !m.address}<option value="">{t('mobile.noAddresses')}</option>{/if}
						{#each s.addresses as a (a.address)}<option value={a.address}>{a.address} ({a.name})</option>{/each}
						{#if m.address && !s.addresses.some((a) => a.address === m.address)}<option value={m.address}>{m.address}</option>{/if}
						<option value="__custom__">{t('mobile.customAddress')}</option>
					</select>
					<button class={ICON_BTN} aria-label={t('mobile.refreshAddresses')} title={t('mobile.refreshAddresses')} onclick={() => m.refresh()}><Icon name="refresh" size={13} /></button>
				</div>

				{#if m.justPaired}
					<p class="mt-4 flex items-center gap-1.5 text-[13px] text-[#73C991]"><Icon name="checkCircle" size={14} />{t('mobile.paired')}</p>
				{/if}
				{#if m.pairing}
					<div class="mt-4 flex flex-wrap items-start gap-4">
						<img src={m.pairing.qr} alt={m.pairing.url} class="size-[200px] shrink-0 rounded-md bg-white p-1" />
						<div class="min-w-[200px] flex-1">
							<p class="text-[12px] {MUTED}">{t('mobile.scan')}</p>
							<p class="mt-2 text-[11px] {MUTED}">{t('mobile.code')}</p>
							<p class="font-mono text-[22px] font-semibold tracking-[0.12em] select-all">{m.pairing.code}</p>
							<p class="mt-1 font-mono text-[11px] break-all select-all">http://{m.pairing.address}:{m.pairing.port}/</p>
							<p class="mt-1 text-[11px] {MUTED}">{t('mobile.expires', { minutes: minutesLeft(m.pairing.expires_at, m.now) })} · {t('mobile.singleUse')}</p>
							<div class="mt-2 flex gap-1">
								<button class={BTN} onclick={() => m.copyLink()}><span class="inline-flex items-center gap-1"><Icon name="copy" size={12} />{t('mobile.copyLink')}</span></button>
								<button class={BTN} disabled={m.busy} onclick={() => m.generate(true)}>{t('mobile.regenerate')}</button>
							</div>
						</div>
					</div>
				{:else}
					<button class="mt-4 {PRIMARY}" disabled={m.busy} onclick={() => m.generate(false)}>{t('mobile.generate')}</button>
				{/if}
			{/if}

			<h3 class="mt-5 mb-1 text-[12px] font-semibold">{t('mobile.devices')}</h3>
			{#if m.devices.length}
				<ul class="rounded-md border border-(--vscode-widget-border)">
					{#each m.devices as d (d.id)}
						<li class="flex items-center gap-2 border-b border-(--vscode-widget-border) px-3 py-2 last:border-b-0">
							<span class="min-w-0 flex-1">
								<span class="block truncate text-[13px]">{d.name}</span>
								<span class="block text-[11px] {MUTED}">{t('mobile.pairedAt', { date: when(d.paired_at) })}{d.last_seen_at ? ` · ${t('mobile.lastSeen', { date: when(d.last_seen_at) })}` : ''}</span>
							</span>
							<button class={BTN} onclick={() => m.revoke(d.id, d.name)}>{t('mobile.revoke')}</button>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-[12px] {MUTED}">{t('mobile.noDevices')}</p>
			{/if}
		</div>
	</div>
</div>
