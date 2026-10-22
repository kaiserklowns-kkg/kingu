<script lang="ts">
	// Settings › Stats & Usage: the keys and cookies Orca's other usage providers read (Orca's AI
	// Provider Accounts pane), each straight into the Keychain, with the settings that go with it,
	// then the providers that read a CLI's own sign-in. Logic: #lib/workbench/usageCredentials.ts.
	import { t } from '#lib/i18n/index.ts';
	import AgentIcon from '#lib/agent/AgentIcon.svelte';
	import { providerIconKey } from '#lib/agent/agentIcons.ts';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { PROVIDER_NAME } from '#lib/workbench/usage.ts';
	import { usage } from '#lib/workbench/usage.svelte.ts';
	import { CLI_SIGN_INS, loadSecretStatus, pastable, saveSecret, SECRET_FIELDS, toStatus, type SecretField, type SecretStatus } from '#lib/workbench/usageCredentials.ts';
	import { SCHEMA } from '../registry';
	import { settings } from '../settings.svelte';
	import SettingChoice from './SettingChoice.svelte';

	let saved = $state<SecretStatus>(toStatus(null));
	let drafts = $state<Record<string, string>>({});
	let busy = $state(false);

	$effect(() => void loadSecretStatus().then((s) => (saved = s)));

	async function store(f: SecretField, value: string) {
		busy = true;
		try {
			await saveSecret(f.id, value);
			drafts[f.id] = '';
			status.flash(value ? t('usage.cred.savedFlash', { name: t(f.label) }) : t('usage.cred.removedFlash', { name: t(f.label) }));
			void usage.refresh();
		} catch (e) {
			notifications.error(String(e));
		} finally {
			saved = await loadSecretStatus();
			busy = false;
		}
	}

	const setText = (id: string, v: string) => void settings.set(id, v.trim() || undefined, 'user');
	const CARD = 'divide-y divide-(--vscode-widget-border) rounded-xl border border-(--vscode-widget-border)';
	const INPUT = 'h-8 min-w-0 flex-1 rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2.5 font-mono text-[13px] outline-none focus:border-(--vscode-focusBorder)';
	const BUTTON = 'h-8 rounded-md px-3.5 text-[13px] disabled:opacity-50';
	const HINT = 'block text-xs text-(--vscode-descriptionForeground)';
</script>

<p class="mb-2 text-[13px] text-(--vscode-descriptionForeground)">{t('usage.cred.intro')}</p>
<div class={CARD}>
	{#each SECRET_FIELDS as f (f.id)}
		<div class="px-4 py-3">
			<div class="flex items-center gap-2 text-[13px]">
				<AgentIcon agent={providerIconKey(f.provider)} size={14} />{t(f.label)}
				<span class="ml-auto text-xs text-(--vscode-descriptionForeground)">{saved[f.id] ? t('usage.cred.saved') : t('usage.cred.missing')}</span>
			</div>
			<span class={HINT}>{t(f.hint)}</span>
			<div class="mt-1.5 flex items-center gap-2">
				<input
					class={INPUT}
					type="password"
					autocomplete="off"
					spellcheck="false"
					placeholder={t('usage.cred.placeholder')}
					aria-label={t(f.label)}
					bind:value={drafts[f.id]}
					onkeydown={(e) => e.key === 'Enter' && pastable(drafts[f.id] ?? '') && void store(f, drafts[f.id])}
				/>
				<button class="{BUTTON} bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:opacity-90" disabled={busy || !pastable(drafts[f.id] ?? '')} onclick={() => store(f, drafts[f.id])}>{t('usage.cred.save')}</button>
				{#if saved[f.id]}
					<button class="{BUTTON} bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground) hover:opacity-90" disabled={busy} onclick={() => store(f, '')}>{t('usage.cred.remove')}</button>
				{/if}
			</div>
			{#each f.settings as id (id)}
				{@const s = SCHEMA.get(id)}
				{#if s && s.type === 'string' && s.enum}
					<div class="mt-2"><SettingChoice {id} /></div>
				{:else if s}
					<label class="mt-2 block">
						<span class="font-mono text-xs text-(--vscode-descriptionForeground)">{id}</span>
						<input class="{INPUT} mt-1 w-full max-w-[520px]" value={settings.get<string>(id) ?? ''} spellcheck="false" onchange={(e) => setText(id, e.currentTarget.value)} />
					</label>
				{/if}
			{/each}
		</div>
	{/each}
</div>
<div class="mt-4 mb-1.5 text-xs text-(--vscode-descriptionForeground)">{t('usage.cli.title')}</div>
<div class={CARD}>
	{#each CLI_SIGN_INS as c (c.provider)}
		<div class="flex items-start gap-2 px-4 py-2.5 text-[13px]">
			<span class="mt-0.5"><AgentIcon agent={providerIconKey(c.provider)} size={14} /></span>
			<span class="w-24 shrink-0">{PROVIDER_NAME[c.provider]}</span>
			<span class="min-w-0 flex-1 text-xs text-(--vscode-descriptionForeground)">{t(c.hint)}</span>
		</div>
	{/each}
</div>
