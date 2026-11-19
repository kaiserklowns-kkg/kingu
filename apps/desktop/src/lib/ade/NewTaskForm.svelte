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
	import { issueUrlRef, parseIssueUrl, titleAfterLink } from './issueUrl';
	import { lookupIssueUrl, type LinkedIssue } from './issueUrlLookup';
	import { taskForLink } from './taskSources';
	import { splitBranchOverride, suggestCreatureName, taskName } from './taskNaming';
	import { activeShortcode, applySuggestion, completeShortcode, searchShortcodes, type EmojiEntry } from './emojiShortcodes';

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
	// Default name (Orca): an empty name takes the prompt's first line, else a marine creature no
	// task uses. The creature stays the same while the form is open, unless a task takes it.
	let creature = $state('');
	$effect(() => {
		if (!creature || taken.has(creature)) creature = suggestCreatureName(taken);
	});
	const plain = $derived(kind === 'new' && !parent && count === 1);
	const named = $derived(taskName(title, prompt, creature));
	/** Best-of-N and stacked tasks start from words the user wrote: a creature is not a prompt. */
	const name = $derived(kind === 'new' && (plain || !named.generated) ? named.title : '');
	/** Advanced → Branch name (Orca's branchNameOverride): the whole branch name of a plain new task. */
	let advanced = $state(false);
	let branchName = $state('');
	const override = $derived(plain && branchName.trim() ? splitBranchOverride(branchName) : undefined);
	const slug = $derived(name ? (count > 1 && !parent ? attemptSlugs(name, count, taken).slugs.join(', ') : uniqueSlug(name, taken)) : '');
	const badModel = $derived(kind === 'new' && !parent ? models.find((m) => m.trim() && !validModel(m.trim())) : undefined);
	const picked = $derived(prs?.find((p) => String(p.number) === pr.trim().replace(/^#/, '')) ?? null);
	/** Starting from a merge request is not built for GitLab yet; the form says so instead. */
	const prOnGitlab = $derived(adeTasks.gh?.provider === 'gitlab');
	const mac = keyLabel('cmd+a').startsWith('⌘');

	// Link issue at create (Orca's smart name field): an issue URL as the whole name is looked up on
	// its tracker (200ms after typing stops) and offered as a link; taking it keeps the issue on the
	// task, names the task after it and starts the agent from the issue when the prompt is empty.
	// Only a plain new task carries a link: best-of-N and stacked tasks have their own flows.
	type Lookup = { text: string; ref: string } & ({ state: 'resolving' } | { state: 'found'; issue: LinkedIssue } | { state: 'error'; message: string });
	const LOOKUP_DEBOUNCE_MS = 200;
	let linked = $state<LinkedIssue | null>(null);
	let lookup = $state<Lookup | null>(null);
	const linkable = $derived(kind === 'new' && !parent && count === 1);
	const pasted = $derived(linkable && !linked ? parseIssueUrl(title) : null);
	const linkedRef = $derived(linked ? (linked.link.key ?? `#${linked.link.number}`) : '');
	const linkedTask = $derived(linked ? taskForLink(adeTasks.list, linked.link) : undefined);
	$effect(() => {
		const u = pasted;
		if (!u) {
			lookup = null;
			return;
		}
		const text = title;
		const ref = issueUrlRef(u);
		lookup = { text, ref, state: 'resolving' };
		const timer = setTimeout(async () => {
			let next: Lookup;
			try {
				next = { text, ref, state: 'found', issue: await lookupIssueUrl(u) };
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				next = { text, ref, state: 'error', message };
			}
			// The answer of a URL the field no longer holds is dropped.
			if (title === text && !linked) lookup = next;
		}, LOOKUP_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	});
	// A link does not follow the form to a source that cannot carry it.
	$effect(() => {
		if (!linkable && linked) linked = null;
	});
	const ready = $derived(kind === 'new' ? !!name && !badModel && override !== null && lookup?.state !== 'resolving' : kind === 'branch' ? !!branch : !prOnGitlab && looksLikePr(pr));
	function takeLink() {
		if (lookup?.state !== 'found') return;
		linked = lookup.issue;
		title = titleAfterLink(title, lookup.text, lookup.issue.link.title);
		lookup = null;
	}
	function removeLink() {
		if (!linked) return;
		// The name the link gave goes with it; a name the user typed stays (Orca issue-source-actions.ts).
		if (title.trim() === linked.link.title.trim()) title = '';
		linked = null;
		input?.focus();
	}

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
		// Enter on a looked-up URL takes the link; it never becomes the task's name by accident.
		if (lookup?.state === 'found') return takeLink();
		if (!ready || busy) return;
		// A plain new task is created in the background (Orca): the form closes at once.
		if (kind === 'new' && !parent && count === 1) {
			adeTasks.startCreate({ title: name, nameGenerated: named.generated && !linked, branch: override ? branchName.trim() : undefined, prompt: prompt.trim() ? prompt : (linked?.prompt ?? prompt), base, model: models[0].trim() || undefined, sparse: sparseOn ? sparseDirs : undefined, agent: agentPick || undefined, issue: linked?.link });
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
							? await attempts.createStacked(parent.meta.slug, { title: name, prompt })
							: await attempts.createAttempts({ title: name, prompt, base, models });
			if (created) adeTasks.composing = false;
		} finally {
			busy = false;
		}
	}

	// Emoji names (Orca's workspace-emoji input): `:rocket:` becomes 🚀 as it closes, and `:roc`
	// lists matches; ↑↓ pick, Enter or Tab takes one, Escape closes the list (not the form).
	let cursor = $state<number | null>(null);
	let pick = $state(0);
	const shortcode = $derived(busy ? null : activeShortcode(title, cursor));
	const emojis = $derived(shortcode ? searchShortcodes(shortcode.query) : []);
	/** The new value and caret go on the element now, so keys typed next land after the emoji. */
	function replaceTitle(next: { value: string; cursor: number }) {
		title = next.value;
		cursor = null;
		if (!input) return;
		input.value = next.value;
		input.focus({ preventScroll: true });
		input.setSelectionRange(next.cursor, next.cursor);
	}
	function onTitleInput() {
		const value = input?.value ?? title;
		const at = input?.selectionStart ?? value.length;
		const done = completeShortcode(value, at);
		if (done) return replaceTitle(done);
		cursor = at;
		pick = 0;
	}
	function takeEmoji(entry: EmojiEntry) {
		if (!shortcode) return;
		replaceTitle(applySuggestion(title, shortcode, entry));
	}
	function onTitleKey(e: KeyboardEvent) {
		if (!emojis.length || e.isComposing) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			pick = (pick + (e.key === 'ArrowDown' ? 1 : -1) + emojis.length) % emojis.length;
		} else if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) {
			e.preventDefault();
			e.stopPropagation();
			takeEmoji(emojis[Math.min(pick, emojis.length - 1)]);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			cursor = null;
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
	<div class="relative">
		<input
			bind:this={input}
			class={INPUT}
			placeholder={titleHint}
			aria-label={t('adeWorktrees.form.title')}
			role="combobox"
			aria-expanded={emojis.length > 0}
			aria-controls="kingu-new-task-emoji"
			aria-autocomplete="list"
			bind:value={title}
			disabled={busy}
			oninput={onTitleInput}
			onkeydown={onTitleKey}
			onclick={() => (cursor = input?.selectionStart ?? null)}
			onblur={() => (cursor = null)}
		/>
		{#if emojis.length}
			<div id="kingu-new-task-emoji" role="listbox" aria-label={t('adeWorktrees.form.emoji')} class="absolute top-full right-0 left-0 z-20 mt-0.5 max-h-56 overflow-auto rounded-sm border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) py-0.5 shadow-lg">
				{#each emojis as e, i (e.shortcode)}
					<button
						type="button"
						role="option"
						aria-selected={i === pick}
						class={['flex w-full items-center gap-2 px-1.5 py-0.5 text-left', i === pick ? 'bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)' : 'hover:bg-(--vscode-list-hoverBackground)']}
						onmousedown={(ev) => ev.preventDefault()}
						onclick={() => takeEmoji(e)}><span class="w-4 text-center">{e.emoji}</span><span class="truncate font-mono">:{e.shortcode}:</span></button
					>
				{/each}
			</div>
		{/if}
	</div>
	{#if linked}
		<div class="flex items-center gap-1.5 rounded-sm border border-(--vscode-widget-border) px-1.5 py-1" title={linked.link.url}>
			<Icon name="bug" size={12} />
			<span class="min-w-0 flex-1 truncate" aria-label={t('adeWorktrees.link.linked', { ref: linkedRef, title: linked.link.title })}><span class="font-mono text-(--vscode-descriptionForeground)">{linkedRef}</span> {linked.link.title}</span>
			<button type="button" class="grid size-4 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={t('adeWorktrees.link.remove')} title={t('adeWorktrees.link.remove')} disabled={busy} onclick={removeLink}><Icon name="close" size={11} /></button>
		</div>
		{#if linkedTask}<div class="truncate text-[11px] text-(--vscode-descriptionForeground)">{t('adeWorktrees.link.exists', { ref: linkedRef, title: linkedTask.title })}</div>{/if}
	{:else if lookup?.state === 'resolving'}
		<div class="truncate text-[11px] text-(--vscode-descriptionForeground)" role="status">{t('adeWorktrees.link.resolving', { ref: lookup.ref })}</div>
	{:else if lookup?.state === 'found'}
		<button type="button" class="flex w-full items-center gap-1.5 rounded-sm border border-(--vscode-focusBorder) px-1.5 py-1 text-left hover:bg-(--vscode-list-hoverBackground)" title={t('adeWorktrees.link.offerTitle')} onclick={takeLink}>
			<Icon name="bug" size={12} />
			<span class="min-w-0 flex-1 truncate">{t('adeWorktrees.link.offer', { ref: lookup.ref, title: lookup.issue.link.title })}</span>
		</button>
	{:else if lookup?.state === 'error'}
		<div class="text-[11px] text-(--vscode-errorForeground)" role="alert">{t('adeWorktrees.link.failed', { ref: lookup.ref, error: lookup.message })}</div>
	{/if}
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
	{#if plain}
		<!-- Advanced (Orca's composer): a branch name of your own instead of prefix + name. -->
		<button type="button" class="flex items-center gap-1 text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)" aria-expanded={advanced} disabled={busy} onclick={() => (advanced = !advanced)}>
			<Icon name={advanced ? 'chevronDown' : 'chevronRight'} size={11} />{t('adeWorktrees.form.advanced')}
		</button>
		{#if advanced}
			<label class="flex items-center gap-2">
				<span class="shrink-0 text-(--vscode-descriptionForeground)">{t('adeWorktrees.form.branchName')}</span>
				<input class={[INPUT, 'font-mono']} placeholder={t('adeWorktrees.form.branchNamePlaceholder')} aria-label={t('adeWorktrees.form.branchName')} aria-invalid={override === null} bind:value={branchName} disabled={busy} spellcheck="false" autocapitalize="off" />
			</label>
			{#if override === null}
				<div class="text-[11px] text-(--vscode-errorForeground)" role="alert">{t('adeWorktrees.form.badBranchName', { branch: branchName.trim() })}</div>
			{:else}
				<div class="text-[11px] text-(--vscode-descriptionForeground)">{t('adeWorktrees.form.branchNameHint')}</div>
			{/if}
		{/if}
	{/if}
	{#if override}
		<div class="truncate font-mono text-[11px] text-(--vscode-descriptionForeground)">→ {override.prefix}{override.leaf}</div>
	{:else if slug}
		<div class="truncate font-mono text-[11px] text-(--vscode-descriptionForeground)">→ kingu/{slug}</div>
	{/if}
	<div class="flex items-center gap-1.5">
		<button type="submit" class={BUTTON} disabled={!ready || busy} title={t('adeWorktrees.form.submitTitle', { keys: mac ? '⌘Enter' : 'Ctrl+Enter' })}>{busy ? t('adeWorktrees.form.creating') : t('adeWorktrees.form.create')}</button>
		<button type="button" class={BUTTON_SECONDARY} onclick={() => ((adeTasks.composing = false), (attempts.stackOn = null))}>{t('common.cancel')}</button>
	</div>
</form>
