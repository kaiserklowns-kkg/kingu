<script lang="ts">
	// Settings › Account & Team (Orca's Accounts pane): the team server, sign-in and sync health.
	import Icon from '#lib/workbench/Icon.svelte';
	import { team } from '#lib/team/team.svelte.ts';
	import { settings } from '../settings.svelte';
	import { t } from '#lib/i18n/index.ts';

	$effect(() => void team.refresh());

	const s = $derived(team.status);
	const set = (id: string, v: string) => void settings.set(id, v.trim() || undefined, 'user');
	const state = $derived(
		!team.serverUrl
			? { tone: 'text-(--vscode-descriptionForeground)', text: t('team.accountPage.notConfigured') }
			: !s
				? { tone: 'text-(--vscode-descriptionForeground)', text: t('team.accountPage.checking') }
				: !s.signed_in
					? { tone: 'text-(--vscode-editorWarning-foreground)', text: t('team.accountPage.signedOut') }
					: s.online === false
						? { tone: 'text-(--vscode-editorWarning-foreground)', text: t('team.accountPage.offline') }
						: { tone: 'text-[#73C991]', text: t('team.accountPage.signedIn') }
	);
	const SECTION = 'mt-7 mb-2 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase';
	const INPUT = 'mt-1.5 h-8 w-full max-w-[460px] rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2.5 font-mono text-[13px] outline-none focus:border-(--vscode-focusBorder)';
	const BTN = 'h-8 rounded-md px-3.5 text-[13px] disabled:opacity-40';
</script>

<div class="h-full overflow-y-auto">
	<div class="mx-auto max-w-4xl px-8 pt-10 pb-24">
		<h1 class="flex items-center gap-2 text-2xl leading-tight font-semibold"><Icon name="account" size={20} />{t('team.accountPage.title')}</h1>
		<p class="mt-2 max-w-3xl text-sm leading-6 text-(--vscode-descriptionForeground)">{t('team.accountPage.intro')}</p>

		<h2 class={SECTION}>{t('team.accountPage.status')}</h2>
		<div class="flex items-center gap-4 rounded-xl border border-(--vscode-widget-border) px-4 py-3.5">
			<span class={['size-2.5 rounded-full bg-current', state.tone]}></span>
			<div class="min-w-0 flex-1">
				<div class={['text-[13px] font-medium', state.tone]}>{state.text}</div>
				<div class="truncate text-xs text-(--vscode-descriptionForeground)">
					{team.serverUrl || '—'}{s?.pending ? ` · ${t('team.accountPage.pending', { count: s.pending })}` : ''}{s?.last_error ? ` · ${s.last_error}` : ''}
				</div>
			</div>
			<button class="{BTN} hover:bg-(--vscode-toolbar-hoverBackground)" disabled={!team.serverUrl} onclick={() => team.refresh()}>{t('team.accountPage.refresh')}</button>
			{#if s?.signed_in}
				<button class="{BTN} border border-(--vscode-widget-border) hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => team.signOut()}>{t('team.accountPage.signOut')}</button>
			{:else}
				<button class="{BTN} bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:opacity-90" disabled={!team.serverUrl} onclick={() => team.startSignIn()}>{t('team.accountPage.signIn')}</button>
			{/if}
		</div>

		<h2 class={SECTION}>{t('team.accountPage.server')}</h2>
		<div class="divide-y divide-(--vscode-widget-border) rounded-xl border border-(--vscode-widget-border)">
			<label class="block px-4 py-3">
				<span class="text-[13px]">{t('team.accountPage.serverUrl')}</span>
				<span class="block text-xs text-(--vscode-descriptionForeground)">{t('team.accountPage.serverUrlHint')}</span>
				<input class={INPUT} value={team.serverUrl} placeholder="https://team.example.com" spellcheck="false" onchange={(e) => set('kingu.team.serverUrl', e.currentTarget.value)} />
			</label>
			<label class="block px-4 py-3">
				<span class="text-[13px]">{t('team.accountPage.project')}</span>
				<span class="block text-xs text-(--vscode-descriptionForeground)">{t('team.accountPage.projectHint')}</span>
				<input class={INPUT} value={team.project} spellcheck="false" onchange={(e) => set('kingu.team.project', e.currentTarget.value)} />
			</label>
		</div>
	</div>
</div>
