<script lang="ts">
	// Settings › Voice (Orca's Voice pane): dictation on/off, the speech engine (whisper.cpp here,
	// or OpenAI with a key kept only in the Keychain), the microphone, language and shortcut mode.
	// The key goes straight to Rust (voice.rs); this page only learns whether one is saved.
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '#lib/workbench/Icon.svelte';
	import { commands, keyOf } from '#lib/workbench/commands.svelte.ts';
	import { keyLabel } from '#lib/workbench/keys.ts';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { DICTATION_COMMAND } from '#lib/voice/dictation.svelte.ts';
	import { settings } from '../settings.svelte';
	import Switch from './Switch.svelte';
	import SettingChoice from './SettingChoice.svelte';

	type VoiceStatus = { openaiKeySaved: boolean; whisper: string | null; whisperError: string | null };

	let info = $state<VoiceStatus | null>(null);
	let key = $state('');
	let busy = $state(false);
	let devices = $state<MediaDeviceInfo[]>([]);

	const engine = $derived(settings.get<string>('kingu.voice.engine') === 'openai' ? 'openai' : 'local');
	const whisperPath = $derived(settings.get<string>('kingu.voice.whisperPath') ?? '');
	const mic = $derived(settings.get<string>('kingu.voice.microphone') ?? '');
	const shortcut = $derived.by(() => {
		const cmd = commands.get(DICTATION_COMMAND);
		const k = cmd ? keyOf(cmd) : undefined;
		return k ? keyLabel(k) : 'Voice: Dictation';
	});

	async function refresh() {
		info = await invoke<VoiceStatus>('voice_status', { whisperPath }).catch(() => null);
	}

	async function listDevices() {
		devices = ((await navigator.mediaDevices?.enumerateDevices().catch(() => [])) ?? []).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default');
	}

	$effect(() => {
		void whisperPath;
		void refresh();
	});
	$effect(() => void listDevices());

	async function saveKey() {
		if (!key.trim() || busy) return;
		busy = true;
		try {
			await invoke('voice_set_openai_key', { key });
			key = '';
			status.flash(t('voice.page.keySavedFlash'));
		} catch (e) {
			notifications.error(String(e));
		} finally {
			busy = false;
			void refresh();
		}
	}

	async function removeKey() {
		busy = true;
		try {
			await invoke('voice_clear_openai_key');
			status.flash(t('voice.page.keyRemoved'));
		} catch (e) {
			notifications.error(String(e));
		} finally {
			busy = false;
			void refresh();
		}
	}

	const set = (id: string, v: string) => void settings.set(id, v.trim() || undefined, 'user');
	const SECTION = 'mt-7 mb-2 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase';
	const CARD = 'divide-y divide-(--vscode-widget-border) rounded-xl border border-(--vscode-widget-border)';
	const INPUT = 'mt-1.5 h-8 w-full max-w-[520px] rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2.5 font-mono text-[13px] outline-none focus:border-(--vscode-focusBorder)';
	const BUTTON = 'h-8 rounded-md px-3.5 text-[13px] disabled:opacity-50';
	const HINT = 'block text-xs text-(--vscode-descriptionForeground)';
</script>

<div class="h-full overflow-y-auto">
	<div class="mx-auto max-w-[880px] px-8 py-6">
		<h1 class="flex items-center gap-2 text-lg font-semibold"><Icon name="mic" size={20} />{t('voice.title')}</h1>
		<p class="mt-1 text-[13px] text-(--vscode-descriptionForeground)">{t('voice.page.intro', { key: shortcut })}</p>

		<div class="mt-5 {CARD}">
			<Switch id="kingu.voice.enabled" label={t('voice.page.enable')} hint={t('voice.page.permission')} />
		</div>

		<h2 class={SECTION}>{t('voice.page.engine')}</h2>
		<SettingChoice id="kingu.voice.engine" labels={{ local: t('voice.page.local'), openai: t('voice.page.openai') }} />
		<div class="mt-3 {CARD}">
			{#if engine === 'local'}
				<div class="flex items-start gap-2 px-4 py-3 text-[13px]">
					<Icon name={info?.whisper ? 'checkCircle' : 'warning'} size={15} />
					<span class="min-w-0 flex-1 break-all">{info?.whisper ? t('voice.page.whisperFound', { path: info.whisper }) : (info?.whisperError ?? t('voice.page.whisperMissing'))}</span>
					<button class="{BUTTON} hover:bg-(--vscode-toolbar-hoverBackground)" onclick={refresh}>{t('voice.page.refreshDevices')}</button>
				</div>
				<label class="block px-4 py-3">
					<span class="text-[13px]">{t('voice.page.model')}</span>
					<span class={HINT}>{t('voice.page.modelHint')}</span>
					<input class={INPUT} value={settings.get<string>('kingu.voice.localModel') ?? ''} placeholder="/…/ggml-base.bin" spellcheck="false" onchange={(e) => set('kingu.voice.localModel', e.currentTarget.value)} />
				</label>
			{:else}
				<div class="px-4 py-3">
					<div class="text-[13px]">{t('voice.page.key')}</div>
					<div class={HINT}>{info?.openaiKeySaved ? t('voice.page.keySaved') : t('voice.page.keyMissing')}</div>
					<div class="mt-1.5 flex items-center gap-2">
						<input
							class="{INPUT} flex-1"
							type="password"
							autocomplete="off"
							spellcheck="false"
							placeholder={t('voice.page.keyPlaceholder')}
							aria-label={t('voice.page.key')}
							bind:value={key}
							onkeydown={(e) => e.key === 'Enter' && void saveKey()}
						/>
						<button class="{BUTTON} bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:opacity-90" disabled={busy || !key.trim()} onclick={saveKey}>{t('voice.page.keySave')}</button>
						{#if info?.openaiKeySaved}
							<button class="{BUTTON} bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground) hover:opacity-90" disabled={busy} onclick={removeKey}>{t('voice.page.keyRemove')}</button>
						{/if}
					</div>
					<div class="mt-2 text-xs text-(--vscode-descriptionForeground)">{t('voice.page.cloudNote')}</div>
				</div>
				<div class="px-4 py-3"><SettingChoice id="kingu.voice.openaiModel" /></div>
			{/if}
		</div>

		<h2 class={SECTION}>{t('voice.page.microphone')}</h2>
		<div class={CARD}>
			<div class="flex items-center gap-2 px-4 py-3">
				<select
					class="h-8 min-w-0 flex-1 rounded-md border border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) px-2 text-[13px] text-(--vscode-dropdown-foreground)"
					aria-label={t('voice.page.microphone')}
					value={mic}
					onchange={(e) => set('kingu.voice.microphone', e.currentTarget.value)}
				>
					<option value="">{t('voice.page.systemDefault')}</option>
					{#each devices as d (d.deviceId)}<option value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>{/each}
					{#if mic && !devices.some((d) => d.deviceId === mic)}<option value={mic}>{t('voice.page.unplugged')}</option>{/if}
				</select>
				<button class="{BUTTON} hover:bg-(--vscode-toolbar-hoverBackground)" onclick={listDevices}>{t('voice.page.refreshDevices')}</button>
			</div>
			<label class="block px-4 py-3">
				<span class="text-[13px]">{t('voice.page.language')}</span>
				<span class={HINT}>{t('voice.page.languageHint')}</span>
				<input class="{INPUT} max-w-[160px]" value={settings.get<string>('kingu.voice.language') ?? 'auto'} spellcheck="false" onchange={(e) => set('kingu.voice.language', e.currentTarget.value.toLowerCase() === 'auto' ? '' : e.currentTarget.value.toLowerCase())} />
			</label>
		</div>

		<h2 class={SECTION}>{t('voice.page.mode')}</h2>
		<SettingChoice id="kingu.voice.dictationMode" />
		<div class="mt-3 {CARD}">
			<Switch id="kingu.voice.terminalConfirmBeforeInsert" label={t('voice.page.confirmTerminal')} hint={t('voice.page.confirmTerminalHint')} />
		</div>
	</div>
</div>
