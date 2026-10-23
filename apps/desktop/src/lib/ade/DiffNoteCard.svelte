<script lang="ts">
	// One review note inside a diff (a Monaco view zone under its line), Orca's DiffCommentCard and
	// DiffCommentDraftCard: a draft is a box to write the note; a saved note shows its text with
	// send / edit / delete. Enter saves, Shift+Enter is a new line, Escape cancels.
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { locationLabel, type DiffNote, type NoteTarget } from './diffNotes.ts';
	import { BUTTON, BUTTON_SECONDARY, ICON_BUTTON, INPUT } from './ui.ts';

	type Props = {
		target: NoteTarget;
		/** A saved note; none for a draft. */
		note?: DiffNote;
		sendLabel?: string;
		sending?: boolean;
		onSave: (body: string) => Promise<boolean>;
		onCancel?: () => void;
		onDelete?: () => void;
		onSend?: () => void;
	};
	let { target, note, sendLabel = t('legacyAde.diffNoteCard.sendNote'), sending = false, onSave, onCancel, onDelete, onSend }: Props = $props();

	// svelte-ignore state_referenced_locally
	let editing = $state(!note);
	// svelte-ignore state_referenced_locally
	let body = $state(note?.body ?? '');
	let saving = $state(false);

	function focus(node: HTMLTextAreaElement) {
		queueMicrotask(() => {
			node.focus();
			node.setSelectionRange(node.value.length, node.value.length);
		});
	}

	async function save() {
		if (saving || !body.trim()) return;
		saving = true;
		const ok = await onSave(body);
		saving = false;
		if (ok && note) editing = false;
	}

	function cancel() {
		if (note) {
			body = note.body;
			editing = false;
		} else onCancel?.();
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.isComposing) return;
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void save();
		} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			void save();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			cancel();
		}
		e.stopPropagation();
	}
</script>

<div class="my-1 ml-2 max-w-[640px] rounded-md border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background,var(--vscode-quickInput-background)) px-2.5 py-1.5 font-sans text-xs text-(--vscode-foreground) shadow-sm">
	<div class="flex items-center gap-1.5">
		<Icon name="note" size={13} />
		<span class="font-medium">{locationLabel(target)}</span>
		<span class="flex-1"></span>
		{#if note && !editing}
			{#if onSend}<button class={ICON_BUTTON} aria-label={sendLabel} title={sendLabel} disabled={sending} onclick={onSend}><Icon name="send" size={13} /></button>{/if}
			<button class={ICON_BUTTON} aria-label={t('legacyAde.diffNoteCard.editNote')} title={t('legacyAde.diffNoteCard.editNote')} onclick={() => (editing = true)}><Icon name="edit" size={13} /></button>
			<button class={ICON_BUTTON} aria-label={t('legacyAde.diffNoteCard.deleteNote')} title={t('legacyAde.diffNoteCard.deleteNote')} onclick={onDelete}><Icon name="trash" size={13} /></button>
		{/if}
	</div>
	{#if editing}
		<textarea
			class={[INPUT, 'mt-1 min-h-14 resize-y font-sans text-xs']}
			placeholder={t('legacyAde.diffNoteCard.placeholder')}
			aria-label={t('legacyAde.diffNoteCard.reviewNote')}
			bind:value={body}
			use:focus
			{onkeydown}
			disabled={saving}
		></textarea>
		<div class="mt-1 flex justify-end gap-1.5">
			<button class={BUTTON_SECONDARY} onclick={cancel} disabled={saving}>{t('legacyAde.diffNoteCard.cancel')}</button>
			<button class={BUTTON} onclick={save} disabled={saving || !body.trim()}>{saving ? t('legacyAde.diffNoteCard.saving') : note ? t('legacyAde.diffNoteCard.save') : t('legacyAde.diffNoteCard.addNote')}</button>
		</div>
	{:else if note}
		<p class="mt-0.5 whitespace-pre-wrap">{note.body}</p>
	{/if}
</div>
