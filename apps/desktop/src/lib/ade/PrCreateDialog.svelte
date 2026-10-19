<script lang="ts">
	// Create pull request (Orca's New PR composer): title, description, base and draft, seeded
	// once from the branch's commits and the task, then pushed and created with `gh` (Rust), or as
	// a merge request when the folder is on GitLab. Errors stay in the form so nothing typed is lost.
	import AdeDialog from './AdeDialog.svelte';
	import { adeTasks } from './tasks.svelte.ts';
	import { prFormProblem, prSubmitLabel, type PrForm } from './prForm.ts';
	import { BUTTON, BUTTON_SECONDARY, INPUT } from './ui.ts';
	import Icon from '#lib/workbench/Icon.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { aiText, aiTextEnabled, generatePrDetails, prTemplate } from './aiText.svelte.ts';
	import { forgeOf, ft } from './forge.ts';
	import { t } from '#lib/i18n/index.ts';

	let { slug, onClose }: { slug: string; onClose: () => void } = $props();
	const forge = $derived(forgeOf(adeTasks.gh));

	const branch = $derived(adeTasks.branchOf(slug));
	const stat = $derived(adeTasks.stats[slug]);
	let form = $state<PrForm | null>(null);
	let error = $state('');
	let busy = $state(false);

	/** The repository's PR template when kingu.pr.useTemplate is on (the agent fills it too). */
	let template: string | null = null;
	$effect(() => {
		const s = slug;
		void adeTasks.prDefaults(s).then(async (f) => {
			if (s !== slug || form || !f) return;
			template = settings.get<boolean>('kingu.pr.useTemplate') === true ? await prTemplate(s) : null;
			form = template ? { ...f, body: adeTasks.prBodyFrom(s, template) } : f;
			// kingu.pr.generateDetailsOnOpen: draft the title and description right away.
			if (aiTextEnabled() && settings.get<boolean>('kingu.pr.generateDetailsOnOpen') === true) void draft();
		});
	});

	// Orca's PR details generation (kingu.git.ai.*): replaces the title and description.
	const drafting = $derived(aiText.busy[slug] === 'pr');
	async function draft() {
		if (!form) return;
		error = '';
		try {
			const d = await generatePrDetails(slug, form.base, template);
			if (form) form = { ...form, title: d.title, body: adeTasks.prBodyFrom(slug, d.body) };
		} catch (e) {
			error = ft('forge.create.generateFailed', forge, { error: e instanceof Error ? e.message : String(e) });
		}
	}

	const problem = $derived(form ? prFormProblem(form, branch, forge) : t('forge.create.preparing'));
	const bases = $derived(form && !adeTasks.branches.includes(form.base) ? [form.base, ...adeTasks.branches] : adeTasks.branches);

	async function submit(e?: Event) {
		e?.preventDefault();
		if (!form || problem || busy) return;
		busy = true;
		error = '';
		const err = await adeTasks.submitPr(slug, $state.snapshot(form));
		busy = false;
		if (err) error = err;
		else onClose();
	}

	// The form appears after the commits are read, so the dialog's first focus missed it.
	function focusTitle(node: HTMLInputElement) {
		node.focus();
		node.select();
	}

	function onBodyKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e);
	}
</script>

<AdeDialog title={ft('forge.create.title', forge)} {busy} {onClose} width={560}>
	{#if !form}
		<p class="py-6 text-center text-(--vscode-descriptionForeground)">{t('forge.create.readingCommits', { branch })}</p>
	{:else}
		<form class="space-y-2.5" onsubmit={submit}>
			<p class="text-xs text-(--vscode-descriptionForeground)">{ft('forge.create.pushHint', forge, { branch })}</p>
			<label class="block space-y-1">
				<span class="flex items-center text-xs text-(--vscode-descriptionForeground)">
					<span class="flex-1">{t('forge.create.titleField')}</span>
					{#if aiTextEnabled()}
						<button
							type="button"
							class="flex items-center gap-1 rounded px-1 text-(--vscode-textLink-foreground) hover:underline disabled:opacity-50"
							disabled={busy || drafting}
							title={ft('forge.create.generateTip', forge)}
							onclick={draft}
						>
							<Icon name="sparkle" size={12} />{drafting ? t('forge.create.agentWriting') : t('forge.create.agentWrite')}
						</button>
					{/if}
				</span>
				<input class={INPUT} bind:value={form.title} placeholder={t('forge.create.titleField')} use:focusTitle disabled={busy || drafting} />
			</label>
			<label class="block space-y-1">
				<span class="text-xs text-(--vscode-descriptionForeground)">{t('forge.create.descriptionField')}</span>
				<textarea class={[INPUT, 'h-40 resize-y font-mono text-xs']} bind:value={form.body} placeholder={t('forge.create.descriptionPlaceholder')} disabled={busy || drafting} onkeydown={onBodyKey}></textarea>
			</label>
			<div class="flex flex-wrap items-center gap-3">
				<label class="flex items-center gap-1.5">
					<span class="text-xs text-(--vscode-descriptionForeground)">{t('forge.create.baseField')}</span>
					<select class={[INPUT, 'w-auto max-w-56']} bind:value={form.base} disabled={busy}>
						{#each bases as b (b)}<option value={b}>{b}</option>{/each}
					</select>
				</label>
				<label class="flex items-center gap-1.5">
					<input type="checkbox" bind:checked={form.draft} disabled={busy} />
					<span>{t('forge.create.asDraft')}</span>
				</label>
			</div>
			{#if stat?.dirty}
				<p class="rounded border border-(--vscode-editorWarning-foreground) px-2 py-1 text-xs text-(--vscode-editorWarning-foreground)">{ft('forge.create.uncommitted', forge)}</p>
			{/if}
			{#if error}
				<p role="alert" class="rounded border border-(--vscode-errorForeground) px-2 py-1 text-xs whitespace-pre-wrap text-(--vscode-errorForeground)">{error}</p>
			{/if}
		</form>
	{/if}
	{#snippet footer()}
		{#if form && problem}<span class="mr-auto text-xs text-(--vscode-descriptionForeground)">{problem}</span>{/if}
		<button class={BUTTON_SECONDARY} disabled={busy} onclick={onClose}>{t('common.cancel')}</button>
		<button class={BUTTON} disabled={!!problem || busy} title="{prSubmitLabel(form?.draft ?? false, false, forge)} (⌘Enter)" onclick={() => submit()}>{prSubmitLabel(form?.draft ?? false, busy, forge)}</button>
	{/snippet}
</AdeDialog>
