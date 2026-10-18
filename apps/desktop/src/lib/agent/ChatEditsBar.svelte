<script lang="ts">
	// The working set above the chat composer (VS Code's chat editing widget): the files the agent
	// changed and the user has not kept or undone yet, with +/− lines, a diff on click, Keep and
	// Undo per file, and Keep All / Undo All. Hidden while there is nothing to show.
	import Icon from '#lib/workbench/Icon.svelte';
	import { splitPath } from '#lib/workbench/scm.ts';
	import { t } from '#lib/i18n/index.ts';
	import { chatEdits } from './chatEdits.svelte.ts';
	import { summary, type WorkingFile } from './chatEdits.ts';

	let { chatId }: { chatId: string } = $props();

	let open = $state(true);
	let busy = $state(false);
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

	const BTN = 'h-[22px] rounded-sm px-2 text-xs disabled:opacity-50';
	const ICON = 'grid size-5 shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
</script>

{#if files.length}
	<div class="mb-1.5 overflow-hidden rounded border border-(--vscode-widget-border,var(--vscode-input-border)) bg-(--vscode-sideBar-background) text-xs" role="region" aria-label={t('chatEdits.filesChanged', { count: sum.files })}>
		<div class="flex h-7 items-center gap-1 pr-1 pl-1">
			<button class="flex min-w-0 flex-1 items-center gap-1 text-left" aria-expanded={open} title={t('chatEdits.toggle')} onclick={() => (open = !open)}>
				<Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
				<span class="truncate">{t('chatEdits.filesChanged', { count: sum.files })}</span>
				{#if sum.added || sum.removed}
					<span class="shrink-0 font-mono text-[11px]"
						><span class="text-(--vscode-gitDecoration-addedResourceForeground,#73c991)">+{sum.added}</span>
						<span class="text-(--vscode-gitDecoration-deletedResourceForeground,#f14c4c)">−{sum.removed}</span></span
					>
				{/if}
			</button>
			<button
				class={[BTN, 'bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)']}
				title={t('chatEdits.keepAllHint')}
				disabled={busy}
				onclick={() => act(() => chatEdits.keep(chatId, null))}>{t('chatEdits.keepAll')}</button
			>
			<button
				class={[BTN, 'bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground) hover:bg-(--vscode-button-secondaryHoverBackground)']}
				title={running ? t('chatEdits.running') : t('chatEdits.undoAllHint')}
				disabled={busy || running || !sum.restorable}
				onclick={() => act(() => chatEdits.undo(chatId, null))}>{t('chatEdits.undoAll')}</button
			>
		</div>
		{#if open}
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
