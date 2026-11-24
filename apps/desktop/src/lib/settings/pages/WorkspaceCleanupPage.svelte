<script lang="ts">
	// Settings › Workspace Cleanup (Orca 1.4.259's Workspace Cleanup rules): which finished workspaces
	// Kingu may remove for you. Every rule is off by default. "All projects" edits the global rules
	// (kingu.workspaceCleanup.rules); "This project" picks inherit / off / own rules for the open
	// folder (kingu.workspaceCleanup.project, in Kingu's per-repository store). The rules' shapes and
	// the decision itself live in ade/workspaceCleanupPolicy.ts and ade/workspaceCleanupEvaluation.ts;
	// this page only edits them.
	import Icon from '#lib/workbench/Icon.svelte';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { ask } from '#lib/workbench/messageBox.ts';
	import { CHAT_HISTORY_ID, cleanup } from '#lib/ade/cleanup.svelte.ts';
	import { codexHistoryBadge } from '#lib/ade/autoCleanup.ts';
	import { formatBytes } from '#lib/ade/workspaceCleanupBrowse.ts';
	import { untrack } from 'svelte';
	import { t } from '#lib/i18n/index.ts';
	import {
		getDefaultWorkspaceCleanupRules,
		hasEnabledWorkspaceCleanupRule,
		normalizeRepoWorkspaceCleanupPolicy,
		normalizeWorkspaceCleanupRules,
		WORKSPACE_CLEANUP_POLICY_MAX_DAYS,
		WORKSPACE_CLEANUP_POLICY_MIN_DAYS,
		type RepoWorkspaceCleanupPolicy,
		type WorkspaceCleanupInactiveAction,
		type WorkspaceCleanupKeepWhen,
		type WorkspaceCleanupRules
	} from '#lib/ade/workspaceCleanupPolicy.ts';
	import { settings } from '../settings.svelte';
	import Segmented from '../Segmented.svelte';
	import Toggle from '../Toggle.svelte';
	import Switch from './Switch.svelte';
	import { timeAgo } from '#lib/ade/model.ts';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';

	// Activity is per folder: show the open folder's rows, and again when the folder changes.
	$effect(() => {
		void workspace.root;
		untrack(() => cleanup.reloadActivity());
	});

	// Codex history size beside the switch (Orca's badge): read when the page shows, and again after each run, which may have freed some.
	$effect(() => {
		void cleanup.activity;
		untrack(() => void cleanup.readCodexUsage());
	});
	const codexBadge = $derived(codexHistoryBadge(cleanup.codexUsage));

	const RULES_ID = 'kingu.workspaceCleanup.rules';
	const PROJECT_ID = 'kingu.workspaceCleanup.project';

	let scope = $state<'global' | 'project'>('global');
	const hasProject = $derived(!!workspace.root);
	const projectName = $derived(workspace.root?.split(/[\\/]/).filter(Boolean).pop() ?? '');
	$effect(() => {
		if (!hasProject) scope = 'global';
	});

	const globalRules = $derived(normalizeWorkspaceCleanupRules(settings.get(RULES_ID)));
	const override = $derived(normalizeRepoWorkspaceCleanupPolicy(settings.inspect(PROJECT_ID, 'repo')));
	type Mode = 'inherit' | 'off' | 'custom';
	const mode = $derived<Mode>(override?.mode ?? 'inherit');

	/** The rules the editor below shows: the global ones, or this project's own. */
	const editing = $derived(scope === 'global' ? globalRules : mode === 'custom' && override?.mode === 'custom' ? override.rules : globalRules);
	const editable = $derived(scope === 'global' || mode === 'custom');

	async function save(id: string, value: unknown, where: 'user' | 'repo') {
		try {
			await settings.set(id, value, where);
		} catch (e) {
			notifications.error(t('workspaceCleanup.saveFailed', { error: String(e) }));
		}
	}

	/** Turning it on deletes history of workspaces deleted before now, so it asks first (as Orca), then sweeps the open folder. */
	async function setChatHistory(on: boolean) {
		if (on && !(await ask(t('workspaceCleanup.chatHistory.confirm'), { title: t('workspaceCleanup.chatHistory.confirmTitle'), kind: 'warning', okLabel: t('workspaceCleanup.chatHistory.turnOn') }))) return;
		await save(CHAT_HISTORY_ID, on ? true : undefined, 'user');
		if (on && cleanup.chatHistoryOn && workspace.root && !cleanup.running) void cleanup.runRules('dialog', { rules: false }).catch(() => {});
	}

	const sameAsDefault = (rules: WorkspaceCleanupRules) => JSON.stringify(rules) === JSON.stringify(getDefaultWorkspaceCleanupRules());

	function writeRules(rules: WorkspaceCleanupRules) {
		if (scope === 'global') return save(RULES_ID, sameAsDefault(rules) ? undefined : rules, 'user');
		return save(PROJECT_ID, { mode: 'custom', rules } satisfies RepoWorkspaceCleanupPolicy, 'repo');
	}

	function setMode(next: Mode) {
		if (next === 'inherit') return save(PROJECT_ID, undefined, 'repo');
		if (next === 'off') return save(PROJECT_ID, { mode: 'off' } satisfies RepoWorkspaceCleanupPolicy, 'repo');
		// Own rules start as a copy of what applies now, so switching does not silently turn rules on or off.
		return save(PROJECT_ID, { mode: 'custom', rules: globalRules } satisfies RepoWorkspaceCleanupPolicy, 'repo');
	}

	type Toggled = 'merged' | 'unchanged' | 'inactive' | 'automationRuns' | 'orchestrationWorkers';
	const toggle = (key: Toggled, on: boolean) => writeRules({ ...editing, [key]: { ...editing[key], enabled: on } });
	const setDays = (key: 'unchanged' | 'inactive', raw: string) => {
		const n = Math.round(Number(raw));
		if (!Number.isFinite(n)) return;
		return writeRules(normalizeWorkspaceCleanupRules({ ...editing, [key]: { ...editing[key], afterDays: n } }));
	};
	const setAction = (action: WorkspaceCleanupInactiveAction) => writeRules({ ...editing, inactive: { ...editing.inactive, action } });
	const setKeep = (keepWhen: WorkspaceCleanupKeepWhen) => writeRules({ ...editing, keepWhen });

	const SECTION = 'mt-7 mb-2 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase';
	const CARD = 'divide-y divide-(--vscode-widget-border) rounded-xl border border-(--vscode-widget-border)';
	const HINT = 'text-xs text-(--vscode-descriptionForeground)';
	const NUMBER = 'h-8 w-20 rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2.5 text-[13px] outline-none focus:border-(--vscode-focusBorder) disabled:opacity-50';
</script>

{#snippet days(key: 'unchanged' | 'inactive')}
	<label class="flex items-center gap-2 pt-2 text-xs">
		<span class="text-(--vscode-descriptionForeground)">{t('workspaceCleanup.afterDays')}</span>
		<input
			class={NUMBER}
			type="number"
			min={WORKSPACE_CLEANUP_POLICY_MIN_DAYS}
			max={WORKSPACE_CLEANUP_POLICY_MAX_DAYS}
			step="1"
			disabled={!editable}
			value={editing[key].afterDays}
			onchange={(e) => void setDays(key, e.currentTarget.value)}
		/>
	</label>
{/snippet}

{#snippet rule(key: Toggled, label: string, hint: string, extra?: 'unchanged' | 'inactive')}
	<div class="flex items-start gap-3 px-4 py-3">
		<div class="min-w-0 flex-1">
			<div class="text-[13px]">{label}</div>
			<div class={HINT}>{hint}</div>
			{#if extra && editing[key].enabled}{@render days(extra)}{/if}
			{#if key === 'inactive' && editing.inactive.enabled}
				<div class="flex items-center gap-2 pt-2 text-xs">
					<span class="text-(--vscode-descriptionForeground)">{t('workspaceCleanup.action')}</span>
					<Segmented
						label={t('workspaceCleanup.action')}
						value={editing.inactive.action}
						options={[
							{ value: 'delete', label: t('workspaceCleanup.delete') },
							{ value: 'archive', label: t('workspaceCleanup.archive') }
						]}
						onchange={(a) => void setAction(a)}
					/>
				</div>
				{#if editing.inactive.action === 'archive'}
					<div class="mt-2 text-xs text-(--vscode-descriptionForeground)">{t('workspaceCleanup.archiveHint')}</div>
				{/if}
			{/if}
		</div>
		<Toggle checked={editing[key].enabled} {label} disabled={!editable} onchange={(on) => void toggle(key, on)} />
	</div>
{/snippet}

<div class="h-full overflow-y-auto">
	<div class="mx-auto max-w-[880px] px-8 py-6">
		<h1 class="flex items-center gap-2 text-lg font-semibold"><Icon name="trash" size={20} />{t('workspaceCleanup.title')}</h1>
		<p class="mt-1 text-[13px] text-(--vscode-descriptionForeground)">{t('workspaceCleanup.intro')}</p>

		{#if hasProject}
			<button class="mt-4 h-8 rounded-md bg-(--vscode-button-secondaryBackground) px-3.5 text-[13px] text-(--vscode-button-secondaryForeground) hover:opacity-90" onclick={() => (cleanup.open = true)}>{t('workspaceCleanup.review')}</button>
		{/if}

		<div class="mt-5 flex items-center gap-3">
			<span class="text-[13px]">{t('workspaceCleanup.scope')}</span>
			<Segmented
				label={t('workspaceCleanup.scope')}
				value={scope}
				options={[
					{ value: 'global', label: t('workspaceCleanup.scopeGlobal') },
					{ value: 'project', label: hasProject ? `${t('workspaceCleanup.scopeProject')} · ${projectName}` : t('workspaceCleanup.scopeProject'), title: hasProject ? undefined : t('workspaceCleanup.noProject') }
				]}
				onchange={(s) => hasProject && (scope = s)}
			/>
		</div>

		{#if scope === 'project'}
			<h2 class={SECTION}>{t('workspaceCleanup.projectMode')}</h2>
			<Segmented
				label={t('workspaceCleanup.projectMode')}
				value={mode}
				options={[
					{ value: 'inherit', label: t('workspaceCleanup.inherit') },
					{ value: 'off', label: t('workspaceCleanup.off') },
					{ value: 'custom', label: t('workspaceCleanup.custom') }
				]}
				onchange={(m) => void setMode(m)}
			/>
			{#if mode === 'inherit'}<p class="mt-2 {HINT}">{t('workspaceCleanup.inheritHint')}</p>{/if}
			{#if mode === 'off'}<p class="mt-2 {HINT}">{t('workspaceCleanup.offHint')}</p>{/if}
		{/if}

		{#if editable}
			<h2 class={SECTION}>{t('workspaceCleanup.rules')}</h2>
			<div class={CARD}>
				{@render rule('merged', t('workspaceCleanup.merged'), t('workspaceCleanup.mergedHint'))}
				{@render rule('unchanged', t('workspaceCleanup.unchanged'), t('workspaceCleanup.unchangedHint'), 'unchanged')}
				{@render rule('inactive', t('workspaceCleanup.inactive'), t('workspaceCleanup.inactiveHint'), 'inactive')}
				{@render rule('automationRuns', t('workspaceCleanup.automationRuns'), t('workspaceCleanup.automationRunsHint'))}
				{@render rule('orchestrationWorkers', t('workspaceCleanup.orchestrationWorkers'), t('workspaceCleanup.orchestrationWorkersHint'))}
			</div>
			{#if !hasEnabledWorkspaceCleanupRule(editing)}<p class="mt-2 {HINT}">{t('workspaceCleanup.noRules')}</p>{/if}

			<h2 class={SECTION}>{t('workspaceCleanup.keep')}</h2>
			<Segmented
				label={t('workspaceCleanup.keep')}
				value={editing.keepWhen}
				options={[
					{ value: 'uncommitted', label: t('workspaceCleanup.keepUncommitted'), title: t('workspaceCleanup.keepUncommittedHint') },
					{ value: 'any-local-files', label: t('workspaceCleanup.keepAnyLocal'), title: t('workspaceCleanup.keepAnyLocalHint') }
				]}
				onchange={(k) => void setKeep(k)}
			/>
			<p class="mt-2 {HINT}">{editing.keepWhen === 'uncommitted' ? t('workspaceCleanup.keepUncommittedHint') : t('workspaceCleanup.keepAnyLocalHint')}</p>
		{/if}

		<h2 class={SECTION}>{t('workspaceCleanup.auto.title')}</h2>
		<div class={CARD}>
			<Switch id="kingu.workspaceCleanup.auto" label={t('workspaceCleanup.auto.label')} hint={t('workspaceCleanup.auto.hint')} />
		</div>

		<h2 class={SECTION}>{t('workspaceCleanup.chatHistory.title')}</h2>
		<div class={CARD}>
			<div class="flex items-center gap-3 px-4 py-3">
				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-center gap-2 text-[13px]">
						{t('workspaceCleanup.chatHistory.label')}
						{#if codexBadge}
							<span
								class="min-w-0 rounded-full border border-(--vscode-widget-border) px-2 py-px text-[11px] [overflow-wrap:anywhere] text-(--vscode-descriptionForeground)"
								title={t(codexBadge.atLeast ? 'workspaceCleanup.chatHistory.codexTooltipAtLeast' : 'workspaceCleanup.chatHistory.codexTooltip')}
							>
								{t(codexBadge.atLeast ? 'workspaceCleanup.chatHistory.codexBadgeAtLeast' : 'workspaceCleanup.chatHistory.codexBadge', { size: formatBytes(codexBadge.bytes) })}
							</span>
						{/if}
					</div>
					<div class={HINT}>{t('workspaceCleanup.chatHistory.hint')}</div>
				</div>
				<Toggle checked={cleanup.chatHistoryOn} label={t('workspaceCleanup.chatHistory.label')} onchange={(on) => void setChatHistory(on)} />
			</div>
		</div>

		<h2 class={SECTION}>{t('workspaceCleanup.activity.title')}</h2>
		{#if cleanup.activity.length}
			<ul class={CARD}>
				{#each cleanup.activity as a (a.at)}
					<li class="px-4 py-2.5 text-[13px]">
						<div>
							{t('workspaceCleanup.activity.row', { source: t(`workspaceCleanup.activity.source.${a.source}`), removed: a.removed.length, archived: a.archived.length, failed: a.failed.length, kept: a.kept })}
							<span class={HINT}>· {timeAgo(a.at, adeTasks.now)}</span>
						</div>
						{#if a.removed.length}<div class="truncate font-mono {HINT}">{a.removed.join(', ')}</div>{/if}
						{#if a.archived.length}<div class="truncate font-mono {HINT}">{a.archived.join(', ')}</div>{/if}
						{#each a.failed as f (f.slug)}<div class="truncate text-xs text-(--vscode-errorForeground)">{f.slug}: {f.error}</div>{/each}
						{#if a.chatHistory && a.chatHistory.deleted > 0}
							<div class={HINT}>{t('workspaceCleanup.chatHistory.deleted', { count: a.chatHistory.deleted })}{a.chatHistory.freedBytes > 0 ? ` · ${formatBytes(a.chatHistory.freedBytes)}` : ''}</div>
						{/if}
						{#if a.chatHistory && a.chatHistory.failed > 0}<div class="text-xs text-(--vscode-errorForeground)">{t('workspaceCleanup.chatHistory.failed', { count: a.chatHistory.failed })}</div>{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class={HINT}>{t('workspaceCleanup.activity.empty')}</p>
		{/if}
	</div>
</div>
