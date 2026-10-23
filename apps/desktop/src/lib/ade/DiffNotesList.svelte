<script lang="ts">
	// Review notes of a worktree (Orca's Source Control notes shelf): every note with its file and
	// lines (click opens the diff there), edit / delete, and Send to the agent, Copy, Clear.
	import { ask } from '#lib/workbench/messageBox.ts';
	import Icon from '#lib/workbench/Icon.svelte';
	import { diffKey, splitPath, taskDiffKey } from '#lib/workbench/scm.ts';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { adeLayout } from './adeLayout.svelte.ts';
	import { diffNotes } from './diffNotes.svelte.ts';
	import { locationLabel, sortedNotes, type DiffNote } from './diffNotes.ts';
	import { BUTTON, BUTTON_SECONDARY, ICON_BUTTON, INPUT } from './ui.ts';

	/** '' = the folder itself, else a task slug. */
	let { worktree }: { worktree: string } = $props();

	const notes = $derived(sortedNotes(diffNotes.list(worktree)));
	const delivery = $derived(diffNotes.delivery(worktree));
	const sendLabel = $derived(
		delivery === 'cli'
			? t('legacyAde.diffNotesList.sendCli')
			: delivery === 'launch'
				? t('legacyAde.diffNotesList.sendLaunch')
				: t('legacyAde.diffNotesList.copyNotes')
	);
	const busy = $derived(notes.some((n) => diffNotes.sending[n.id]));
	let editing = $state<string | null>(null);
	let draft = $state('');

	function open(n: DiffNote) {
		const key = worktree ? taskDiffKey(worktree, n.filePath) : diffKey(n.filePath);
		diffNotes.revealRequest = { diffKey: key, line: Math.max(1, n.lineNumber) };
		if (appMode.isAgents) adeLayout.openFile(worktree, key);
		else editors.open(key, { preview: true });
	}

	function edit(n: DiffNote) {
		editing = n.id;
		draft = n.body;
	}

	async function save(n: DiffNote) {
		if (await diffNotes.update(worktree, n.id, draft)) editing = null;
	}

	async function clear() {
		const ok = await ask(t('legacyAde.diffNotesList.clearAsk', { count: notes.length }), {
			title: t('legacyAde.diffNotesList.clearTitle'),
			kind: 'warning',
			okLabel: t('legacyAde.diffNotesList.deleteAll'),
			cancelLabel: t('legacyAde.diffNotesList.cancel')
		});
		if (ok) await diffNotes.clear(worktree);
	}
</script>

{#if notes.length}
	<section aria-label={t('legacyAde.diffNotesList.reviewNotes')} class="space-y-1 px-3 py-2 text-xs">
		<div class="flex items-center gap-1">
			<h3 class="flex-1 text-[11px] font-bold text-(--vscode-descriptionForeground) uppercase">{t('legacyAde.diffNotesList.reviewNotesCount', { count: notes.length })}</h3>
			<button class={ICON_BUTTON} aria-label={t('legacyAde.diffNotesList.copyAllNotes')} title={t('legacyAde.diffNotesList.copyAllNotes')} onclick={() => diffNotes.copy(notes)}><Icon name="copy" size={13} /></button>
			<button class={ICON_BUTTON} aria-label={t('legacyAde.diffNotesList.clearAllNotes')} title={t('legacyAde.diffNotesList.clearAllNotes')} disabled={busy} onclick={clear}><Icon name="trash" size={13} /></button>
		</div>
		<ul class="space-y-1">
			{#each notes as n (n.id)}
				{@const [name] = splitPath(n.filePath)}
				<li class="group rounded border border-(--vscode-widget-border) px-2 py-1">
					<div class="flex items-center gap-1">
						<button class="min-w-0 flex-1 truncate text-left hover:underline" title={t('legacyAde.diffNotesList.openDiffTitle', { path: n.filePath, location: locationLabel(n) })} onclick={() => open(n)}>
							<span>{name}</span> <span class="text-(--vscode-descriptionForeground)">{locationLabel(n)}</span>
						</button>
						{#if editing !== n.id}
							<button class={[ICON_BUTTON, 'invisible group-focus-within:visible group-hover:visible']} aria-label={t('legacyAde.diffNotesList.editNote')} title={t('legacyAde.diffNotesList.editNote')} onclick={() => edit(n)}><Icon name="edit" size={12} /></button>
							<button class={[ICON_BUTTON, 'invisible group-focus-within:visible group-hover:visible']} aria-label={t('legacyAde.diffNotesList.deleteNote')} title={t('legacyAde.diffNotesList.deleteNote')} disabled={!!diffNotes.sending[n.id]} onclick={() => diffNotes.remove(worktree, n.id)}><Icon name="trash" size={12} /></button>
						{/if}
					</div>
					{#if editing === n.id}
						<textarea
							class={[INPUT, 'mt-1 min-h-12 resize-y text-xs']}
							aria-label={t('legacyAde.diffNotesList.editNote')}
							bind:value={draft}
							onkeydown={(e) => {
								if (e.isComposing) return;
								if (e.key === 'Enter' && !e.shiftKey) (e.preventDefault(), void save(n));
								else if (e.key === 'Escape') (e.preventDefault(), (editing = null));
							}}
						></textarea>
						<div class="mt-1 flex justify-end gap-1">
							<button class={BUTTON_SECONDARY} onclick={() => (editing = null)}>{t('legacyAde.diffNotesList.cancel')}</button>
							<button class={BUTTON} disabled={!draft.trim()} onclick={() => save(n)}>{t('legacyAde.diffNotesList.save')}</button>
						</div>
					{:else}
						<p class="line-clamp-3 whitespace-pre-wrap text-(--vscode-foreground)/90">{n.body}</p>
					{/if}
				</li>
			{/each}
		</ul>
		<button class={BUTTON} disabled={busy} title={delivery === 'none' ? t('legacyAde.diffNotesList.sendNoneTitle') : t('legacyAde.diffNotesList.sendAllTitle')} onclick={() => diffNotes.send(worktree, notes)}>
			<Icon name="send" size={12} /> {busy ? t('legacyAde.diffNotesList.sending') : sendLabel}
		</button>
	</section>
{/if}
