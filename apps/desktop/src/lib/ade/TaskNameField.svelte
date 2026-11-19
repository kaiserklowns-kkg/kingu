<script lang="ts">
	// The task name field shared by the New Task form and the folder's composer (Orca's smart name
	// field, NewWorkspaceComposerNameSection.tsx):
	// - emoji names (Orca's workspace-emoji input): `:rocket:` becomes 🚀 as it closes, `:roc`
	//   lists matches; ↑↓ pick, Enter or Tab takes one, Escape closes the list (not the form);
	// - link issue at create: an issue URL as the whole name is looked up on its tracker (200ms
	//   after typing stops) and offered as a link; taking it names the task after the issue.
	// Plain Enter (no list open, no link offered) is the caller's `onenter`.
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { adeTasks } from './tasks.svelte';
	import { INPUT } from './ui';
	import { activeShortcode, applySuggestion, completeShortcode, searchShortcodes, type EmojiEntry } from './emojiShortcodes';
	import { issueUrlRef, parseIssueUrl, titleAfterLink } from './issueUrl';
	import { lookupIssueUrl, type LinkedIssue } from './issueUrlLookup';
	import { taskForLink } from './taskSources';

	let {
		title = $bindable(''),
		linked = $bindable(null),
		resolving = $bindable(false),
		input = $bindable(),
		linkable = true,
		disabled = false,
		placeholder = '',
		label = t('adeWorktrees.form.title'),
		inputClass = INPUT,
		onlink,
		onenter
	}: {
		title?: string;
		linked?: LinkedIssue | null;
		/** A pasted issue URL is being looked up: creating now would name the task after the URL. */
		resolving?: boolean;
		input?: HTMLInputElement;
		/** Only a plain new task carries a link (best-of-N and stacked tasks have their own flows). */
		linkable?: boolean;
		disabled?: boolean;
		placeholder?: string;
		label?: string;
		inputClass?: string | string[];
		/** A link was taken (the composer fills an empty prompt from the issue). */
		onlink?: (issue: LinkedIssue) => void;
		onenter?: (e: KeyboardEvent) => void;
	} = $props();

	type Lookup = { text: string; ref: string } & ({ state: 'resolving' } | { state: 'found'; issue: LinkedIssue } | { state: 'error'; message: string });
	const LOOKUP_DEBOUNCE_MS = 200;
	let lookup = $state<Lookup | null>(null);
	const pasted = $derived(linkable && !linked ? parseIssueUrl(title) : null);
	const linkedRef = $derived(linked ? (linked.link.key ?? `#${linked.link.number}`) : '');
	const linkedTask = $derived(linked ? taskForLink(adeTasks.list, linked.link) : undefined);
	$effect(() => {
		resolving = lookup?.state === 'resolving';
	});
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
	/** Takes the offered link; false when none is offered. */
	export function takeLink(): boolean {
		if (lookup?.state !== 'found') return false;
		const issue = lookup.issue;
		linked = issue;
		title = titleAfterLink(title, lookup.text, issue.link.title);
		lookup = null;
		onlink?.(issue);
		return true;
	}
	function removeLink() {
		if (!linked) return;
		// The name the link gave goes with it; a name the user typed stays (Orca issue-source-actions.ts).
		if (title.trim() === linked.link.title.trim()) title = '';
		linked = null;
		input?.focus();
	}

	let cursor = $state<number | null>(null);
	let pick = $state(0);
	const shortcode = $derived(disabled ? null : activeShortcode(title, cursor));
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
	function onInput() {
		const value = input?.value ?? title;
		const at = input?.selectionStart ?? value.length;
		const done = completeShortcode(value, at);
		if (done) return replaceTitle(done);
		cursor = at;
		pick = 0;
	}
	function takeEmoji(entry: EmojiEntry) {
		if (shortcode) replaceTitle(applySuggestion(title, shortcode, entry));
	}
	function onKey(e: KeyboardEvent) {
		if (e.isComposing) return;
		const plainEnter = e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
		if (emojis.length) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				pick = (pick + (e.key === 'ArrowDown' ? 1 : -1) + emojis.length) % emojis.length;
				return;
			}
			if (plainEnter || (e.key === 'Tab' && !e.shiftKey)) {
				e.preventDefault();
				e.stopPropagation();
				return takeEmoji(emojis[Math.min(pick, emojis.length - 1)]);
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				cursor = null;
				return;
			}
		}
		if (!plainEnter) return;
		// Enter on a looked-up URL takes the link; it never becomes the task's name by accident.
		if (takeLink() || resolving) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		onenter?.(e);
	}
</script>

<div class="relative">
	<input
		bind:this={input}
		class={inputClass}
		{placeholder}
		aria-label={label}
		role="combobox"
		aria-expanded={emojis.length > 0}
		aria-controls="kingu-task-name-emoji"
		aria-autocomplete="list"
		bind:value={title}
		{disabled}
		oninput={onInput}
		onkeydown={onKey}
		onclick={() => (cursor = input?.selectionStart ?? null)}
		onblur={() => (cursor = null)}
	/>
	{#if emojis.length}
		<div id="kingu-task-name-emoji" role="listbox" aria-label={t('adeWorktrees.form.emoji')} class="absolute top-full right-0 left-0 z-20 mt-0.5 max-h-56 overflow-auto rounded-sm border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) py-0.5 text-xs shadow-lg">
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
	<div class="flex items-center gap-1.5 rounded-sm border border-(--vscode-widget-border) px-1.5 py-1 text-xs" title={linked.link.url}>
		<Icon name="bug" size={12} />
		<span class="min-w-0 flex-1 truncate" aria-label={t('adeWorktrees.link.linked', { ref: linkedRef, title: linked.link.title })}><span class="font-mono text-(--vscode-descriptionForeground)">{linkedRef}</span> {linked.link.title}</span>
		<button type="button" class="grid size-4 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={t('adeWorktrees.link.remove')} title={t('adeWorktrees.link.remove')} {disabled} onclick={removeLink}><Icon name="close" size={11} /></button>
	</div>
	{#if linkedTask}<div class="truncate text-[11px] text-(--vscode-descriptionForeground)">{t('adeWorktrees.link.exists', { ref: linkedRef, title: linkedTask.title })}</div>{/if}
{:else if lookup?.state === 'resolving'}
	<div class="truncate text-[11px] text-(--vscode-descriptionForeground)" role="status">{t('adeWorktrees.link.resolving', { ref: lookup.ref })}</div>
{:else if lookup?.state === 'found'}
	<button type="button" class="flex w-full items-center gap-1.5 rounded-sm border border-(--vscode-focusBorder) px-1.5 py-1 text-left text-xs hover:bg-(--vscode-list-hoverBackground)" title={t('adeWorktrees.link.offerTitle')} onclick={takeLink}>
		<Icon name="bug" size={12} />
		<span class="min-w-0 flex-1 truncate">{t('adeWorktrees.link.offer', { ref: lookup.ref, title: lookup.issue.link.title })}</span>
	</button>
{:else if lookup?.state === 'error'}
	<div class="text-[11px] text-(--vscode-errorForeground)" role="alert">{t('adeWorktrees.link.failed', { ref: lookup.ref, error: lookup.message })}</div>
{/if}
