<script lang="ts">
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { openUrl } from '#lib/terminal/pty.ts';
	import { setup } from './setup.svelte.ts';
	import { failures, readiness, warnings, type SetupCheck, type SetupStatus } from './setup.ts';
	import { INSTALL_URL, metaOf } from './setupMeta.ts';

	type StatusKey = 'setup.status.ok' | 'setup.status.warn' | 'setup.status.fail';
	type ActionLabel = 'setup.action.install' | 'setup.action.copy' | 'setup.action.agents';
	type Action = { label: ActionLabel; url?: string; copy?: string; agents?: boolean };

	const report = $derived(setup.report);
	const state = $derived(readiness(report));

	const TONE: Record<SetupStatus, string> = {
		ok: 'text-[#73C991]',
		warn: 'text-(--vscode-editorWarning-foreground)',
		fail: 'text-(--vscode-errorForeground)'
	};
	const ICON: Record<SetupStatus, 'check' | 'warning' | 'error'> = { ok: 'check', warn: 'warning', fail: 'error' };
	const STATUS: Record<SetupStatus, StatusKey> = { ok: 'setup.status.ok', warn: 'setup.status.warn', fail: 'setup.status.fail' };

	function actionOf(c: SetupCheck): Action | null {
		if (c.status === 'ok') return null;
		if (c.id === 'agents') return { label: 'setup.action.agents', agents: true };
		if (c.id === 'gh_auth') {
			const gh = report?.checks.find((x) => x.id === 'gh')?.status === 'ok';
			return gh ? { label: 'setup.action.copy', copy: 'gh auth login' } : null;
		}
		if (c.id === 'ripgrep') {
			return report?.os === 'macos'
				? { label: 'setup.action.copy', copy: 'brew install ripgrep' }
				: { label: 'setup.action.install', url: 'https://github.com/BurntSushi/ripgrep#installation' };
		}
		const url = INSTALL_URL[c.id];
		return url ? { label: 'setup.action.install', url } : null;
	}

	async function run(c: SetupCheck) {
		const action = actionOf(c);
		if (!action) return;
		if (action.agents) return systemSettings.show('Agent');
		if (action.url) return void openUrl(action.url);
		if (action.copy) {
			await navigator.clipboard.writeText(action.copy).then(() => status.flash(t('setup.copied')));
		}
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-center gap-3 rounded-xl border border-(--vscode-widget-border) px-4 py-3.5">
		<span class={['grid size-8 shrink-0 place-items-center rounded-full bg-current/10', state === 'blocked' ? TONE.fail : state === 'warn' ? TONE.warn : TONE.ok]}>
			<Icon name={state === 'blocked' ? 'error' : state === 'warn' ? 'warning' : 'check'} size={17} />
		</span>
		<div class="min-w-0 flex-1" aria-live="polite">
			{#if state === 'loading'}
				<div class="text-[13px] font-medium">{t('setup.checking')}</div>
			{:else if state === 'ready'}
				<div class="text-[13px] font-medium">{t('setup.ready')}</div>
				<div class="text-xs text-(--vscode-descriptionForeground)">{t('setup.readyHint')}</div>
			{:else}
				<div class="text-[13px] font-medium">{state === 'blocked' ? t('setup.summaryBlocked', { count: failures(report).length }) : t('setup.summaryWarn', { count: warnings(report).length })}</div>
				<div class="text-xs text-(--vscode-descriptionForeground)">{report ? t('setup.env', { os: report.os, arch: report.arch }) : ''}</div>
			{/if}
		</div>
		<button
			class="h-8 shrink-0 rounded-md border border-(--vscode-widget-border) px-3 text-[13px] hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50"
			disabled={setup.checking}
			onclick={() => void setup.check()}>{setup.checking ? t('setup.checking') : t('setup.check')}</button
		>
	</div>

	{#if setup.error}
		<p role="alert" class="rounded-lg border border-(--vscode-inputValidation-errorBorder) bg-(--vscode-inputValidation-errorBackground) px-3 py-2 text-xs text-(--vscode-errorForeground)">{t('setup.error', { error: setup.error })}</p>
	{/if}

	{#if report}
		<ul class="divide-y divide-(--vscode-widget-border) rounded-xl border border-(--vscode-widget-border)">
			{#each report.checks as c (c.id)}
				{@const meta = metaOf(c.id)}
				{@const action = actionOf(c)}
				<li class="flex gap-3 px-4 py-3">
					<span class={['mt-0.5 shrink-0', TONE[c.status]]}><Icon name={ICON[c.status]} size={16} /></span>
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2">
							<span class="text-[13px] font-medium">{t(meta.title)}</span>
							<span class={['rounded-full border border-current px-1.5 text-[10px]', TONE[c.status]]}>{t(STATUS[c.status])}</span>
						</div>
						<p class="mt-0.5 text-xs text-(--vscode-descriptionForeground)">{t(meta.desc)}</p>
						{#if c.found?.length}
							<p class="mt-1 font-mono text-xs text-(--vscode-descriptionForeground)">{c.found.join(', ')}</p>
						{:else if c.detail}
							<p class="mt-1 truncate font-mono text-xs text-(--vscode-descriptionForeground)" title={c.detail}>{c.detail}</p>
						{/if}
						{#if action}
							<button class="mt-2 h-7 rounded-md border border-(--vscode-widget-border) px-2.5 text-xs hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => void run(c)}>{t(action.label)}</button>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>
