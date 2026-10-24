<script lang="ts">
	// Settings › Arkai › Model providers: each provider Arkai can run chats on (kingu.arkai.providers,
	// and Ollama on this Mac when it answers), its models, and its API key, which Rust keeps in the
	// macOS Keychain. The key is only ever sent to Rust; the page never reads one back.
	import { t } from '#lib/i18n/index.ts';
	import { arkaiProviders } from '#lib/agent/arkai.svelte.ts';
	import { needsKey, providerEntry, withProvider } from '#lib/agent/arkai.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';

	let drafts = $state<Record<string, string>>({});
	let failure = $state('');
	let adding = $state(false);
	let newId = $state('');
	let newName = $state('');
	let newUrl = $state('');
	let newApi = $state<'openai' | 'anthropic'>('openai');
	let newModels = $state('');

	const KEY = 'kingu.arkai.providers';
	const PROVIDERS = () => settings.get<Record<string, unknown>>(KEY) ?? {};
	const URL_OK = /^https?:\/\/\S+$/;

	async function add() {
		failure = '';
		const id = newId.trim();
		const url = newUrl.trim();
		if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return (failure = t('arkai.settings.addBadId'));
		if (!URL_OK.test(url)) return (failure = t('arkai.settings.addBadUrl'));
		const models = newModels.split(',').map((m) => m.trim()).filter(Boolean);
		const next = withProvider(PROVIDERS(), id, providerEntry(url, newApi, models, newName.trim()));
		if (!next) return (failure = t('arkai.settings.addExists', { id }));
		adding = true;
		try {
			await settings.set(KEY, next, 'user');
			await arkaiProviders.load();
			newId = newName = newUrl = newModels = '';
		} catch (e) {
			failure = t('arkai.settings.addFailed', { error: String(e) });
		} finally {
			adding = false;
		}
	}

	async function forget(id: string) {
		failure = '';
		const next = { ...PROVIDERS() };
		delete next[id];
		try {
			await settings.set(KEY, next, 'user');
			await arkaiProviders.load();
		} catch (e) {
			failure = t('arkai.settings.addFailed', { error: String(e) });
		}
	}

	$effect(() => {
		void arkaiProviders.load();
	});

	async function save(id: string) {
		const key = drafts[id]?.trim();
		if (!key) return;
		failure = '';
		try {
			await arkaiProviders.setKey(id, key);
			drafts[id] = '';
		} catch (e) {
			failure = t('arkai.settings.keyFailed', { error: String(e) });
		}
	}

	async function remove(id: string) {
		failure = '';
		try {
			await arkaiProviders.deleteKey(id);
		} catch (e) {
			failure = t('arkai.settings.keyFailed', { error: String(e) });
		}
	}

	const SECTION = 'mt-7 mb-2 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase';
	const INPUT =
		'h-7 w-full max-w-[320px] rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 font-mono text-[12px] text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)';
	const BUTTON = 'h-7 rounded-md border border-(--vscode-button-border,transparent) px-2.5 text-[12px] hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50';
</script>

<div class="flex items-center justify-between">
	<h2 class={SECTION}>{t('arkai.settings.title')}</h2>
	<button type="button" class="{BUTTON} mt-5" disabled={arkaiProviders.loading} onclick={() => void arkaiProviders.refresh()}>{t('arkai.settings.refresh')}</button>
</div>
<p class="text-xs text-(--vscode-descriptionForeground)">{t('arkai.settings.hint')}</p>
{#if failure}<p class="mt-2 text-xs text-(--vscode-errorForeground)" role="alert">{failure}</p>{/if}
{#if !arkaiProviders.list.length && !arkaiProviders.loading}
	<p class="mt-3 text-[13px] text-(--vscode-descriptionForeground)">{t('arkai.settings.empty')}</p>
{/if}
<form class="mt-4 flex flex-wrap items-end gap-2" onsubmit={(e) => { e.preventDefault(); void add(); }}>
	<label class="flex flex-col gap-1 text-xs text-(--vscode-descriptionForeground)">{t('arkai.settings.addId')}
		<input class={INPUT} bind:value={newId} placeholder="ollama" spellcheck="false" autocomplete="off" />
	</label>
	<label class="flex flex-col gap-1 text-xs text-(--vscode-descriptionForeground)">{t('arkai.settings.addName')}
		<input class={INPUT} bind:value={newName} placeholder={newId || t('arkai.settings.addName')} spellcheck="false" />
	</label>
	<label class="flex flex-col gap-1 text-xs text-(--vscode-descriptionForeground)">{t('arkai.settings.addUrl')}
		<input class={INPUT} bind:value={newUrl} placeholder="http://127.0.0.1:11434/v1" spellcheck="false" autocomplete="off" />
	</label>
	<label class="flex flex-col gap-1 text-xs text-(--vscode-descriptionForeground)">{t('arkai.settings.addApi')}
		<select class={INPUT} bind:value={newApi}>
			<option value="openai">OpenAI</option>
			<option value="anthropic">Anthropic</option>
		</select>
	</label>
	<label class="flex flex-col gap-1 text-xs text-(--vscode-descriptionForeground)">{t('arkai.settings.addModels')}
		<input class={INPUT} bind:value={newModels} placeholder="clyde-1x, qwen3.5:9b" spellcheck="false" autocomplete="off" />
	</label>
	<button type="submit" class="{BUTTON} mb-0" disabled={adding}>{adding ? t('arkai.settings.adding') : t('arkai.settings.add')}</button>
</form>
<ul class="mt-3 flex flex-col gap-2">
	{#each arkaiProviders.list as p (p.id)}
		<li class="rounded-md border border-(--vscode-widget-border) px-3 py-2">
			<div class="flex flex-wrap items-baseline gap-x-2">
				<span class="text-[13px] font-medium">{p.name}</span>
				<span class="font-mono text-xs text-(--vscode-descriptionForeground)">{p.base_url}</span>
				<span class="text-xs text-(--vscode-descriptionForeground)">
					{t('arkai.settings.models', { count: p.models.length })}{#if p.local}
						· {t('arkai.settings.local')}{/if}{#if p.implicit}
						· {t('arkai.settings.found')}{/if}
				</span>
			</div>
			{#if !p.implicit}
				<button type="button" class="{BUTTON} ml-auto" onclick={() => void forget(p.id)}>{t('arkai.settings.remove')}</button>
			{/if}
			{#if p.error}<p class="mt-1 text-xs text-(--vscode-errorForeground)">{t('arkai.settings.listFailed', { error: p.error })}</p>{/if}
			{#if !p.implicit}
				<div class="mt-2 flex flex-wrap items-center gap-2">
					<span class="text-xs {needsKey(p) ? 'text-(--vscode-editorWarning-foreground)' : 'text-(--vscode-descriptionForeground)'}">{p.has_key ? t('arkai.settings.hasKey') : t('arkai.settings.noKey')}</span>
					<input
						type="password"
						class={INPUT}
						autocomplete="off"
						spellcheck="false"
						aria-label={t('arkai.settings.keyLabel', { name: p.name })}
						placeholder={t('arkai.settings.keyPlaceholder')}
						bind:value={drafts[p.id]}
						onkeydown={(e) => e.key === 'Enter' && void save(p.id)}
					/>
					<button type="button" class={BUTTON} disabled={!drafts[p.id]?.trim()} onclick={() => void save(p.id)}>{t('arkai.settings.saveKey')}</button>
					{#if p.has_key}<button type="button" class={BUTTON} onclick={() => void remove(p.id)}>{t('arkai.settings.removeKey')}</button>{/if}
				</div>
			{/if}
		</li>
	{/each}
</ul>
