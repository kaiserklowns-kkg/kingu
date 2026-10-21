<script lang="ts">
	// One past session from the AI Vault, read-only (an editor tab `vault:<agent>:<path>`): who
	// asked what and what the agent answered, its tool calls as one line each, and the session's
	// folder, branch and model. "Continue here" picks it up again (vault.svelte.ts).
	import { untrack } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '#lib/workbench/Icon.svelte';
	import ChatMarkdown from '#lib/agent/ChatMarkdown.svelte';
	import { locale, t } from '#lib/i18n/index.ts';
	import { vault } from './vault.svelte';
	import { AGENT_NAME, parseVaultKey, projectName, type VaultTranscript } from './vault';

	let { vaultKey: key }: { vaultKey: string } = $props();

	const target = $derived(parseVaultKey(key));
	const session = $derived(target ? vault.byPath(target.path) : undefined);
	let transcript = $state<VaultTranscript | null>(null);
	let error = $state('');
	let showTools = $state(true);

	$effect(() => {
		const tg = target;
		transcript = null;
		error = '';
		if (!tg) return;
		// The row (title, folder, Continue) comes from the list; only the target re-runs this.
		untrack(() => !vault.loaded && !vault.loading && void vault.load());
		let stale = false;
		invoke<VaultTranscript>('vault_transcript', { agent: tg.agent, path: tg.path })
			.then((tr) => !stale && (transcript = tr))
			.catch((e) => !stale && (error = String(e)));
		return () => (stale = true);
	});

	const turns = $derived((transcript?.turns ?? []).filter((x) => showTools || x.role !== 'tool'));
	const when = (ms: number) => new Date(ms).toLocaleString(locale() === 'th' ? 'th-TH' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
	const MUTED = 'text-(--vscode-descriptionForeground)';
	const BTN = 'flex h-7 items-center gap-1.5 rounded-md border border-(--vscode-widget-border) px-2.5 text-[12px] hover:bg-(--vscode-list-hoverBackground) disabled:opacity-50';
</script>

<div class="h-full overflow-y-auto bg-(--vscode-editor-background)">
	<div class="mx-auto max-w-[860px] px-6 py-5">
		{#if !target}
			<p class={MUTED}>{t('vault.transcript.badKey')}</p>
		{:else}
			<div class="flex items-start gap-3">
				<div class="min-w-0 flex-1">
					<h1 class="text-base font-semibold break-words">{session?.title ?? target.path.split('/').pop()}</h1>
					<p class="mt-1 text-xs {MUTED}">
						{[AGENT_NAME[target.agent], session?.cwd ? projectName(session.cwd) : null, session?.branch, session?.model, session ? when(session.updated) : null].filter(Boolean).join(' · ')}
					</p>
					{#if session?.cwd}<p class="mt-0.5 truncate text-xs {MUTED}" title={session.cwd}>{session.cwd}</p>{/if}
				</div>
				{#if session}
					<button class={BTN} disabled={!session.resume || !session.cwdExists} title={!session.cwdExists ? t('vault.continue.noFolder') : ''} onclick={() => vault.continue(session)}><Icon name="play" size={14} />{t('vault.continue')}</button>
					<button class={BTN} disabled={!session.resume} onclick={() => vault.copyResume(session)}><Icon name="copy" size={14} />{t('vault.copyResume')}</button>
				{/if}
			</div>
			<div class="mt-3 flex items-center gap-3 border-b border-(--vscode-widget-border) pb-2 text-xs {MUTED}">
				<span>{t('vault.transcript.readOnly')}</span>
				<label class="ml-auto flex items-center gap-1"><input type="checkbox" bind:checked={showTools} />{t('vault.transcript.showTools')}</label>
			</div>
			{#if error}
				<p role="alert" class="mt-4 text-[13px] text-(--vscode-errorForeground)">{t('vault.transcript.failed', { error })}</p>
			{:else if !transcript}
				<p class="mt-4 text-[13px] {MUTED}">{t('vault.loading')}</p>
			{:else}
				{#if transcript.truncated}<p class="mt-3 text-xs {MUTED}">{t('vault.transcript.truncated')}</p>{/if}
				<div class="mt-3 space-y-3">
					{#each turns as turn, i (i)}
						{#if turn.role === 'tool'}
							<div class="flex items-center gap-1.5 truncate pl-1 font-mono text-[11px] {MUTED}" title={turn.text}><Icon name="terminal" size={12} />{turn.text}</div>
						{:else if turn.role === 'user'}
							<div class="rounded-lg bg-(--vscode-input-background) px-3 py-2 text-[13px] whitespace-pre-wrap break-words">{turn.text}</div>
						{:else}
							<div class="px-1 text-[13px]"><ChatMarkdown text={turn.text} /></div>
						{/if}
					{:else}
						<p class="text-[13px] {MUTED}">{t('vault.transcript.empty')}</p>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</div>
