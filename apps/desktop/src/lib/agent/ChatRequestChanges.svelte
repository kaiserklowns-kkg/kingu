<script lang="ts">
	// Under a finished response: "N files changed" for its request (VS Code's
	// ChatCheckpointFileChangesSummaryContentPart), a collapsible list of the files with their
	// `+/−` while they are in the working set, a diff on click, and View All File Changes.
	import Icon from '#lib/workbench/Icon.svelte';
	import FileIcon from '#lib/workbench/FileIcon.svelte';
	import { fileIcon } from '#lib/workbench/fileIcons.ts';
	import { splitPath } from '#lib/workbench/scm.ts';
	import { t } from '#lib/i18n/index.ts';
	import { chatEdits } from './chatEdits.svelte.ts';

	let { chatId, request }: { chatId: string; request: number } = $props();

	let open = $state(false);
	const view = $derived(chatEdits.view(chatId));
	const req = $derived(view?.requests.find((r) => r.index === request && !r.reverted));
	const paths = $derived(req?.paths ?? []);
	const stats = $derived(new Map((view?.files ?? []).filter((f) => f.request === request).map((f) => [f.path, f])));
</script>

{#if paths.length}
	<div class="overflow-hidden rounded border border-(--vscode-widget-border)">
		<div class="flex h-7 items-center gap-1 pr-1 pl-1">
			<button type="button" class="flex min-w-0 flex-1 items-center gap-1 text-left" aria-expanded={open} title={t('chatParts.changes.toggle')} onclick={() => (open = !open)}>
				<Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
				<span class="truncate">{t('chatParts.changes.files', { count: paths.length })}</span>
			</button>
			<button
				type="button"
				class="h-[22px] shrink-0 rounded-sm px-2 text-xs text-(--vscode-textLink-foreground) hover:bg-(--vscode-toolbar-hoverBackground)"
				onclick={() => chatEdits.openAll(chatId, paths)}>{t('chatParts.changes.viewAll')}</button
			>
		</div>
		{#if open}
			<ul class="max-h-48 overflow-y-auto border-t border-(--vscode-widget-border) py-0.5 text-xs">
				{#each paths as p (p)}
					{@const [name, dir] = splitPath(p)}
					{@const f = stats.get(p)}
					<li>
						<button type="button" class="flex h-[22px] w-full min-w-0 items-center gap-1.5 pr-2 pl-2 text-left hover:bg-(--vscode-list-hoverBackground)" title={p} aria-label={t('chatParts.edit.open', { path: p })} onclick={() => chatEdits.openEdited(chatId, p, p)}>
							<FileIcon icon={fileIcon(name)} size={13} />
							<span class={['truncate', f?.deleted && 'line-through']}>{name}</span>
							{#if dir}<span class="min-w-0 flex-1 truncate text-(--vscode-descriptionForeground)">{dir}</span>{:else}<span class="flex-1"></span>{/if}
							{#if f && f.added !== null && f.removed !== null}
								<span class="shrink-0 font-mono text-[11px]"
									><span class="text-(--vscode-gitDecoration-addedResourceForeground,#73c991)">+{f.added}</span>
									<span class="text-(--vscode-gitDecoration-deletedResourceForeground,#f14c4c)">−{f.removed}</span></span
								>
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}
