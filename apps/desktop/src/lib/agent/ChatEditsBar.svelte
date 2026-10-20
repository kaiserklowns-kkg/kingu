<script lang="ts">
	// The status / review row on top of the chat composer (Cursor's composer toolbar, VS Code's chat
	// editing widget): what the agent is doing (Generating, Waiting for Approval) with Stop, and the
	// files it changed that are not kept or undone yet, with +/− lines, a diff on click, Keep and
	// Undo per file, Review (every diff), Keep All and Undo All (a second click confirms). Hidden
	// while there is nothing to show. `flat`: drawn as a row of the stacked toolbar (no own frame).
	import Icon from '#lib/workbench/Icon.svelte';
	import { splitPath } from '#lib/workbench/scm.ts';
	import { t } from '#lib/i18n/index.ts';
	import { chatEdits } from './chatEdits.svelte.ts';
	import { summary, type WorkingFile } from './chatEdits.ts';

	let {
		chatId,
		status = null,
		onstop,
		flat = false
	}: {
		chatId: string;
		/** The turn's state: a spinner with its label and a Stop button. */
		status?: 'running' | 'waiting' | null;
		onstop?: () => void;
		flat?: boolean;
	} = $props();

	const MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
	let open = $state(false);
	let busy = $state(false);
	/** Undo All was clicked once: the next click within a few seconds undoes. */
	let confirmUndo = $state(false);
	let confirmTimer: ReturnType<typeof setTimeout> | undefined;
	const view = $derived(chatEdits.view(chatId));
	const files = $derived(view?.files ?? []);
	const sum = $derived(summary({ files }));
	const running = $derived(!!view?.running);

	async function act(fn: () => Promise<unknown>) {
		busy = true;
		try {
			await fn();
		} finally {
			busy = false;
		}
	}

	function undoAll() {
		if (!confirmUndo) {
			confirmUndo = true;
			clearTimeout(confirmTimer);
			confirmTimer = setTimeout(() => (confirmUndo = false), 4000);
			return;
		}
		confirmUndo = false;
		clearTimeout(confirmTimer);
		void act(() => chatEdits.undo(chatId, null));
	}

	const REASON: Record<string, () => string> = {
		too_large: () => t('chatEdits.reason.tooLarge'),
		budget: () => t('chatEdits.reason.budget'),
		outside: () => t('chatEdits.reason.outside'),
		symlink: () => t('chatEdits.reason.symlink'),
		unreadable: () => t('chatEdits.reason.unreadable'),
		untracked: () => t('chatEdits.reason.untracked'),
		dirty_before: () => t('chatEdits.reason.dirtyBefore'),
		head_moved: () => t('chatEdits.reason.headMoved')
	};
	function hint(f: WorkingFile): string {
		const lines = [f.path];
		if (f.source === 'shell') lines.push(t('chatEdits.shellHint'));
		if (f.from_head) lines.push(t('chatEdits.fromHead'));
		if (!f.restorable && f.reason) lines.push(t('chatEdits.noUndo', { reason: REASON[f.reason]?.() ?? f.reason }));
		return lines.join('\n');
	}

	const BTN = 'h-5 shrink-0 rounded-md px-1.5 text-xs disabled:opacity-50';
	const ICON = 'grid size-5 shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
</script>

{#if files.length || status}
	<div
		class={['overflow-hidden text-xs', !flat && 'mb-1.5 rounded border border-(--vscode-widget-border,var(--vscode-input-border)) bg-(--vscode-sideBar-background)']}
		role="region"
		aria-label={files.length ? t('chatEdits.filesChanged', { count: sum.files }) : t('composer.status.label')}
	>
		<div class="flex h-[26px] items-center gap-1 pr-1 pl-1.5">
			<button class="flex min-w-0 flex-1 items-center gap-1 text-left" aria-expanded={files.length ? open : undefined} title={files.length ? t('chatEdits.toggle') : undefined} disabled={!files.length} onclick={() => (open = !open)}>
				{#if files.length}<span class={['shrink-0 transition-transform', open && 'rotate-90']}><Icon name="chevronRight" size={12} /></span>{/if}
				{#if status}
					<span class="size-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent text-(--vscode-descriptionForeground)" aria-hidden="true"></span>
					<span class="shrink-0 text-(--vscode-descriptionForeground)" role="status">{status === 'waiting' ? t('composer.status.waiting') : t('composer.status.running')}</span>
					{#if files.length}<span class="shrink-0 text-(--vscode-descriptionForeground)">·</span>{/if}
				{/if}
				{#if files.length}
					<span class="truncate">{t('composer.status.edited', { count: sum.files })}</span>
					{#if sum.added || sum.removed}
						<span class="shrink-0 font-mono text-[11px]"
							><span class="text-(--vscode-gitDecoration-addedResourceForeground,#73c991)">+{sum.added}</span>
							<span class="text-(--vscode-gitDecoration-deletedResourceForeground,#f14c4c)">−{sum.removed}</span></span
						>
					{/if}
				{/if}
			</button>
			{#if status && onstop}
				<button
					class={[BTN, 'text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)']}
					title={`${t('chatView.stop')} (${MAC ? '⌘⇧⌫' : 'Ctrl+Shift+Backspace'})`}
					onclick={() => onstop?.()}>{t('chatView.stop')}</button
				>
			{/if}
			{#if files.length}
				<button
					class={[BTN, confirmUndo ? 'bg-(--vscode-inputValidation-warningBackground,var(--vscode-button-secondaryBackground)) text-(--vscode-foreground)' : 'text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)']}
					title={running ? t('chatEdits.running') : confirmUndo ? t('composer.review.confirmHint') : t('chatEdits.undoAllHint')}
					disabled={busy || running || !sum.restorable}
					onclick={undoAll}>{confirmUndo ? t('composer.review.confirm') : sum.files > 1 ? t('chatEdits.undoAll') : t('chatEdits.undo')}</button
				>
				<button
					class={[BTN, 'bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground) hover:bg-(--vscode-button-secondaryHoverBackground)']}
					title={t('chatEdits.keepAllHint')}
					disabled={busy}
					onclick={() => act(() => chatEdits.keep(chatId, null))}>{sum.files > 1 ? t('chatEdits.keepAll') : t('chatEdits.keep')}</button
				>
				<button
					class={[BTN, 'bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)']}
					title={t('composer.review.reviewHint')}
					onclick={() => chatEdits.openAll(chatId, files.map((f) => f.path))}>{t('composer.review.review')}</button
				>
			{/if}
		</div>
		{#if open && files.length}
			<ul class="max-h-40 overflow-y-auto border-t border-(--vscode-widget-border,transparent) py-0.5">
				{#each files as f (f.path)}
					{@const [name, dir] = splitPath(f.path)}
					<li class="group flex h-[22px] items-center gap-1.5 pr-1 pl-2 hover:bg-(--vscode-list-hoverBackground)">
						<button class="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={hint(f)} aria-label={t('chatEdits.openDiff', { path: f.path })} disabled={!f.restorable && f.deleted} onclick={() => chatEdits.openDiff(chatId, f.path)}>
							<Icon name={f.source === 'shell' ? 'terminal' : 'file'} size={13} />
							<span class={['truncate', f.deleted && 'line-through']}>{name}</span>
							{#if dir}<span class="min-w-0 truncate text-(--vscode-descriptionForeground)">{dir}</span>{/if}
							{#if f.created}<span class="shrink-0 text-(--vscode-gitDecoration-addedResourceForeground,#73c991)">{t('chatEdits.created')}</span>{/if}
							{#if f.deleted}<span class="shrink-0 text-(--vscode-gitDecoration-deletedResourceForeground,#f14c4c)">{t('chatEdits.deleted')}</span>{/if}
							{#if f.source === 'shell'}<span class="shrink-0 text-(--vscode-descriptionForeground)">{t('chatEdits.shell')}</span>{/if}
						</button>
						{#if f.added !== null && f.removed !== null}
							<span class="shrink-0 font-mono text-[11px]"
								><span class="text-(--vscode-gitDecoration-addedResourceForeground,#73c991)">+{f.added}</span>
								<span class="text-(--vscode-gitDecoration-deletedResourceForeground,#f14c4c)">−{f.removed}</span></span
							>
						{/if}
						<span class="flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
							<button class={ICON} aria-label={t('chatEdits.keepFile', { path: f.path })} title={t('chatEdits.keep')} disabled={busy} onclick={() => act(() => chatEdits.keep(chatId, [f.path]))}
								><Icon name="check" size={13} /></button
							>
							<button
								class={ICON}
								aria-label={t('chatEdits.undoFile', { path: f.path })}
								title={running ? t('chatEdits.running') : f.restorable ? t('chatEdits.undo') : hint(f)}
								disabled={busy || running || !f.restorable}
								onclick={() => act(() => chatEdits.undo(chatId, [f.path]))}><Icon name="discard" size={13} /></button
							>
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}
