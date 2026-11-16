<script lang="ts">
	// "งานใหม่": title, prompt and where the branch comes from (Orca's new-workspace composer): a new
	// branch `kingu/<slug>` from the base, an existing branch ("Reuse branch"), or a GitHub pull
	// request. Creating makes the worktree and starts the agent in it. ⌘Enter submits, Escape closes.
	// A new branch can run as 2-4 attempts (best-of-N, a model each: `<slug>-a`, `-b`…), and New
	// Task from This Task forks the new branch from another task's (stacked worktrees).
	import { onMount } from 'svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { keyLabel } from '#lib/workbench/keys.ts';
	import type { BranchRef } from '#lib/workbench/scmRemote.ts';
	import { t } from '#lib/i18n/index.ts';
	import { uniqueSlug } from './model';
	import { adeTasks } from './tasks.svelte';
	import { attempts } from './attempts.svelte';
	import { attemptSlugs, MAX_ATTEMPTS, MODEL_SUGGESTIONS, resizeModels, validModel } from './attempts';
	import { branchChoices, branchTitle, looksLikePr, prTitle, type BranchChoice, type PrHead } from './worktreeSource';
	import { BUTTON, BUTTON_SECONDARY, INPUT } from './ui';
	import AgentPick from './AgentPick.svelte';

	type Kind = 'new' | 'branch' | 'pr';
	let kind = $state<Kind>('new');
	let title = $state('');
	let prompt = $state('');
	let base = $state('');
	let branch = $state('');
	let pr = $state('');
	let busy = $state(false);
	/** AgentPick.svelte: '' = kingu.agent.cli. */
	let agentPick = $state('');
	let input: HTMLInputElement | undefined = $state();
	let choices = $state<BranchChoice[] | null>(null);
	let prs = $state<PrHead[] | null>(null);
	let prsError = $state('');
	/** Sparse checkout (Orca's sparsePresets): only some folders, typed or from a saved preset. */
	type SparsePreset = { id: string; name: string; directories: string[] };
	let sparseOn = $state(false);
	let sparseText = $state('');
	let presets = $state<SparsePreset[]>([]);
	let presetId = $state('');
	let presetName = $state('');
	let naming = $state(false);
	let sparseError = $state('');
	const sparseDirs = $derived(sparseText.split(/[\n,]/).map((d) => d.trim()).filter(Boolean));
	const loadPresets = () => invoke<SparsePreset[]>('sparse_presets_list').then((p) => (presets = p)).catch(() => (presets = []));
	function pickPreset(id: string) {
		presetId = id;
		const p = presets.find((x) => x.id === id);
		if (p) sparseText = p.directories.join('\n');
	}
	async function savePreset() {
		sparseError = '';
		try {
			const p = await invoke<SparsePreset>('sparse_presets_save', { id: presetId || null, name: presetName || presets.find((x) => x.id === presetId)?.name || '', directories: sparseDirs });
			await loadPresets();
			presetId = p.id;
			naming = false;
			presetName = '';
		} catch (e) {
			sparseError = String(e);
		}
	}
	async function removePreset() {
		if (!presetId) return;
		await invoke('sparse_presets_remove', { id: presetId }).catch((e) => (sparseError = String(e)));
		presetId = '';
		await loadPresets();
	}
	/** Best-of-N: one model per attempt (`''`: the agent's default). */
	let models = $state<string[]>(['']);
	const count = $derived(models.length);
	/** New Task from This Task: the task (and branch) the new one forks from. */
	const parent = $derived(attempts.stackOn ? adeTasks.find(attempts.stackOn) : undefined);
	const parentBranch = $derived(parent ? adeTasks.branchOf(parent.meta.slug) : '');
	// A stacked task always gets a new branch.
	$effect(() => {
		if (parent) kind = 'new';
	});

	const taken = $derived(new Set([...adeTasks.list.map((t) => t.slug), ...adeTasks.worktrees.map((w) => w.slug ?? '')]));
	const slug = $derived(kind === 'new' && title.trim() ? (count > 1 && !parent ? attemptSlugs(title, count, taken).slugs.join(', ') : uniqueSlug(title, taken)) : '');
	const badModel = $derived(kind === 'new' && !parent ? models.find((m) => m.trim() && !validModel(m.trim())) : undefined);
	const picked = $derived(prs?.find((p) => String(p.number) === pr.trim().replace(/^#/, '')) ?? null);
	/** Starting from a merge request is not built for GitLab yet; the form says so instead. */
	const prOnGitlab = $derived(adeTasks.gh?.provider === 'gitlab');
	const ready = $derived(kind === 'new' ? !!title.trim() && !badModel : kind === 'branch' ? !!branch : !prOnGitlab && looksLikePr(pr));
	const mac = keyLabel('cmd+a').startsWith('⌘');

	onMount(() => {
		void loadPresets();
		void adeTasks.refreshBranches().then(() => {
			if (!base) base = adeTasks.defaultBase();
		});
		input?.focus();
		// The form forks from that task only while it is open.
		return () => (attempts.stackOn = null);
	});

	/** The lists a source needs, read the first time it is chosen. */
	function choose(next: Kind) {
		kind = next;
		if (next === 'branch' && !choices)
			void invoke<BranchRef[]>('git_refs', {})
				.then((refs) => (choices = branchChoices(refs)))
				.catch(() => (choices = []));
		if (next === 'pr' && !prs && !prOnGitlab)
			void invoke<PrHead[]>('gh_pr_list', { limit: 50 })
				.then((list) => (prs = list))
				.catch((e) => {
					prs = [];
					prsError = String(e);
				});
	}

	async function submit(e?: Event) {
		e?.preventDefault();
		if (!ready || busy) return;
		// A plain new task is created in the background (Orca): the form closes at once.
		if (kind === 'new' && !parent && count === 1) {
			adeTasks.startCreate({ title, prompt, base, model: models[0].trim() || undefined, sparse: sparseOn ? sparseDirs : undefined, agent: agentPick || undefined });
			adeTasks.composing = false;
			return;
		}
		busy = true;
		try {
			const created =
				kind === 'branch'
					? await adeTasks.createFromBranch(branch, { title, prompt, base })
					: kind === 'pr'
						? await adeTasks.createFromPr(picked ?? pr.trim(), { title, prompt })
						: parent
							? await attempts.createStacked(parent.meta.slug, { title, prompt })
							: await attempts.createAttempts({ title, prompt, base, models });
			if (created) adeTasks.composing = false;
		} finally {
			busy = false;
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			adeTasks.composing = false;
		} else if (e.key === 'Enter' && (mac ? e.metaKey : e.ctrlKey)) void submit(e);
	}

	const KINDS: { id: Kind; label: () => string }[] = [
		{ id: 'new', label: () => t('adeWorktrees.form.newBranch') },
		{ id: 'branch', label: () => t('adeWorktrees.form.existingBranch') },
		{ id: 'pr', label: () => t('adeWorktrees.form.pullRequest') }
	];
	const titleHint = $derived(
		kind === 'branch' && branch ? branchTitle(branch) : kind === 'pr' && picked ? prTitle(picked) : kind === 'new' ? t('adeWorktrees.form.titlePlaceholder') : t('adeWorktrees.form.titleOptional')
	);
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape / ⌘Enter from any field) -->
<form class="space-y-1.5 border-b border-(--vscode-sideBarSectionHeader-border) p-2 text-xs" onsubmit={submit} onkeydown={onKey}>
	{#if parent}
		<div class="flex items-center gap-1.5 rounded-sm border border-(--vscode-widget-border) px-1.5 py-1">
			<Icon name="branch" size={12} />
			<span class="min-w-0 flex-1 truncate" title={t('adeAttempts.form.stackedTitle')}>{t('adeAttempts.form.stackedOn', { title: parent.meta.title })} <span class="font-mono text-(--vscode-descriptionForeground)">{parentBranch}</span></span>
			<button type="button" class="grid size-4 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={t('adeAttempts.form.unstack')} title={t('adeAttempts.form.unstack')} disabled={busy} onclick={() => (attempts.stackOn = null)}><Icon name="close" size={11} /></button>
		</div>
	{/if}
	<div class={['flex gap-1', parent && 'hidden']} role="radiogroup" aria-label={t('adeWorktrees.form.source')}>
		{#each KINDS as k (k.id)}
			<button
				type="button"
				role="radio"
				aria-checked={kind === k.id}
				class={['rounded px-1.5 py-0.5', kind === k.id ? 'bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground)' : 'text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)']}
				disabled={busy}
				onclick={() => choose(k.id)}>{k.label()}</button
			>
		{/each}
	</div>
	{#if kind === 'branch'}
		<select class={[INPUT, 'py-0.5']} bind:value={branch} aria-label={t('adeWorktrees.form.branch')} disabled={busy || !choices}>
			<option value="" disabled>{choices ? t('adeWorktrees.form.pickBranch') : t('adeWorktrees.form.loading')}</option>
			{#each choices ?? [] as b (b.name)}
				<option value={b.name} disabled={!!b.busy}>{b.name}{b.busy ? ` ${t('adeWorktrees.form.inUse')}` : ''}</option>
			{/each}
		</select>
	{:else if kind === 'pr' && prOnGitlab}
		<p class="text-[11px] text-(--vscode-descriptionForeground)">{t('forge.prStart.notOnGitlab')}</p>
	{:else if kind === 'pr'}
		<input class={INPUT} list="kingu-new-task-prs" placeholder={t('adeWorktrees.form.prPlaceholder')} aria-label={t('adeWorktrees.form.pullRequest')} bind:value={pr} disabled={busy} />
		<datalist id="kingu-new-task-prs">
			{#each prs ?? [] as p (p.number)}<option value={String(p.number)}>{prTitle(p)} ({p.head_ref})</option>{/each}
		</datalist>
		{#if prsError}<div class="truncate text-[11px] text-(--vscode-errorForeground)" title={prsError}>{prsError}</div>{/if}
	{/if}
	<input bind:this={input} class={INPUT} placeholder={titleHint} aria-label={t('adeWorktrees.form.title')} bind:value={title} disabled={busy} />
	<textarea
		class={[INPUT, 'h-20 resize-none']}
		placeholder={kind === 'new' ? t('adeWorktrees.form.promptPlaceholder') : t('adeWorktrees.form.promptOptional')}
		aria-label={t('adeWorktrees.form.prompt')}
		bind:value={prompt}
		disabled={busy}
	></textarea>
	{#if kind === 'new' && !parent}
		<!-- Best-of-N (Cursor): the same prompt as up to four attempts, each in its own worktree with its own model. -->
		<label class="flex items-center gap-2">
			<span class="shrink-0 text-(--vscode-descriptionForeground)">{t('adeAttempts.form.attempts')}</span>
			<select class={[INPUT, 'w-auto py-0.5']} aria-label={t('adeAttempts.form.attempts')} title={t('adeAttempts.form.attemptsTitle')} value={count} disabled={busy} onchange={(e) => (models = resizeModels(models, Number(e.currentTarget.value)))}>
				{#each Array.from({ length: MAX_ATTEMPTS }, (_, i) => i + 1) as n (n)}<option value={n}>{n}</option>{/each}
			</select>
		</label>
		{#each models as _, i (i)}
			<label class="flex items-center gap-2">
				<span class="w-14 shrink-0 text-(--vscode-descriptionForeground)">{count > 1 ? t('adeAttempts.attempt', { letter: 'ABCD'[i] }) : t('adeAttempts.form.model')}</span>
				<input class={INPUT} list="kingu-new-task-models" placeholder={t('adeAttempts.form.modelPlaceholder')} aria-label={t('adeAttempts.form.modelOf', { letter: 'ABCD'[i] })} bind:value={models[i]} disabled={busy} spellcheck="false" />
			</label>
		{/each}
		<datalist id="kingu-new-task-models">{#each MODEL_SUGGESTIONS as m (m)}<option value={m}></option>{/each}</datalist>
		{#if badModel}<div class="truncate text-[11px] text-(--vscode-errorForeground)">{t('adeAttempts.badModel', { model: badModel })}</div>{/if}
	{/if}
	{#if kind !== 'pr' && !parent}
		<label class="flex items-center gap-2">
			<span class="shrink-0 text-(--vscode-descriptionForeground)">{kind === 'new' ? t('adeWorktrees.form.forkFrom') : t('adeWorktrees.form.compareWith')}</span>
			<select class={[INPUT, 'py-0.5']} bind:value={base} aria-label={t('adeWorktrees.form.base')} disabled={busy}>
				{#each adeTasks.branches as b (b)}<option value={b}>{b}</option>{/each}
				{#if !adeTasks.branches.length}<option value="">HEAD</option>{/if}
			</select>
		</label>
	{/if}
	{#if kind === 'new' && !parent && count === 1}
		<div class="flex flex-wrap items-center gap-2">
			<span class="shrink-0 text-(--vscode-descriptionForeground)">{t('ade.agentPick.label')}</span>
			<AgentPick bind:value={agentPick} disabled={busy} />
		</div>
	{/if}
	{#if kind === 'new' && !parent && count === 1}
		<!-- Sparse checkout (Orca): the task's worktree holds only these folders. -->
		<label class="flex items-center gap-2">
			<span class="shrink-0 text-(--vscode-descriptionForeground)">{t('adeWorktrees.form.sparse')}</span>
			<select class={[INPUT, 'py-0.5']} aria-label={t('adeWorktrees.form.sparse')} value={sparseOn ? 'some' : 'all'} disabled={busy} onchange={(e) => (sparseOn = e.currentTarget.value === 'some')}>
				<option value="all">{t('adeWorktrees.form.sparseAll')}</option>
				<option value="some">{t('adeWorktrees.form.sparseSome')}</option>
			</select>
		</label>
		{#if sparseOn}
			<div class="space-y-1 rounded-sm border border-(--vscode-widget-border) p-1.5">
				{#if presets.length}
					<div class="flex items-center gap-1">
						<select class={[INPUT, 'py-0.5']} aria-label={t('adeWorktrees.form.sparsePreset')} value={presetId} disabled={busy} onchange={(e) => pickPreset(e.currentTarget.value)}>
							<option value="">{t('adeWorktrees.form.sparseNoPreset')}</option>
							{#each presets as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
						</select>
						{#if presetId}<button type="button" class="grid size-5 shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={t('adeWorktrees.form.sparseRemove')} title={t('adeWorktrees.form.sparseRemove')} disabled={busy} onclick={removePreset}><Icon name="trash" size={11} /></button>{/if}
					</div>
				{/if}
				<textarea class={[INPUT, 'h-14 resize-none font-mono']} placeholder={t('adeWorktrees.form.sparsePlaceholder')} aria-label={t('adeWorktrees.form.sparseSome')} bind:value={sparseText} disabled={busy} spellcheck="false"></textarea>
				<div class="text-[11px] text-(--vscode-descriptionForeground)">{t('adeWorktrees.form.sparseHint')}</div>
				{#if naming}
					<div class="flex items-center gap-1">
						<input class={INPUT} placeholder={t('adeWorktrees.form.sparsePresetName')} aria-label={t('adeWorktrees.form.sparsePresetName')} bind:value={presetName} maxlength="80" disabled={busy} />
						<button type="button" class={BUTTON_SECONDARY} disabled={busy || !presetName.trim() || !sparseDirs.length} onclick={savePreset}>{t('adeWorktrees.form.sparseSave')}</button>
					</div>
				{:else}
					<button type="button" class="text-[11px] text-(--vscode-textLink-foreground) hover:underline disabled:opacity-50" disabled={busy || !sparseDirs.length} onclick={() => (naming = true)}>{t('adeWorktrees.form.sparseSaveAs')}</button>
				{/if}
				{#if sparseError}<div class="truncate text-[11px] text-(--vscode-errorForeground)" title={sparseError}>{sparseError}</div>{/if}
			</div>
		{/if}
	{/if}
	{#if slug}<div class="truncate font-mono text-[11px] text-(--vscode-descriptionForeground)">→ kingu/{slug}</div>{/if}
	<div class="flex items-center gap-1.5">
		<button type="submit" class={BUTTON} disabled={!ready || busy} title={t('adeWorktrees.form.submitTitle', { keys: mac ? '⌘Enter' : 'Ctrl+Enter' })}>{busy ? t('adeWorktrees.form.creating') : t('adeWorktrees.form.create')}</button>
		<button type="button" class={BUTTON_SECONDARY} onclick={() => ((adeTasks.composing = false), (attempts.stackOn = null))}>{t('common.cancel')}</button>
	</div>
</form>
