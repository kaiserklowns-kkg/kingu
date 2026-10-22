<script lang="ts">
	// "Used N references" above a response (VS Code's chatReferencesContentPart): collapsed to its
	// count, open it lists the files the agent read or found as pills; a pill opens its file (at
	// the line for a Grep match or a ranged Read).
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { shortPath } from './chatParts';
	import { referenceLabel, type Reference } from './chatReferences';

	let { refs, cwd = null, root = null }: { refs: Reference[]; cwd?: string | null; root?: string | null } = $props();

	let open = $state(false);

	/** A path the tool gave, made absolute against where the agent ran, then relative to the open folder. */
	function target(path: string): string {
		const abs = path.startsWith('/') || !cwd ? path : `${cwd.replace(/\/+$/, '')}/${path}`;
		return shortPath(abs, root);
	}

	function openRef(r: Reference) {
		const rel = target(r.path);
		if (r.line) editors.openAt(rel, r.line);
		else editors.open(rel);
	}
</script>

<div class="flex flex-col gap-1">
	<button type="button" class="flex items-center gap-1 self-start text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)" aria-expanded={open} onclick={() => (open = !open)}>
		<Codicon id={open ? 'chevron-down' : 'chevron-right'} size={12} />
		<span>{t('chatRender.references', { count: refs.length })}</span>
	</button>
	{#if open}
		<ul class="flex flex-wrap gap-1 pl-4" aria-label={t('chatRender.referencesList')}>
			{#each refs as r (r.path)}
				{@const label = referenceLabel(shortPath(r.path, cwd))}
				<li class="min-w-0">
					<button
						type="button"
						class="flex max-w-64 min-w-0 items-center gap-1 rounded border border-(--vscode-widget-border) px-1.5 text-xs hover:bg-(--vscode-toolbar-hoverBackground)"
						title={t('chatRender.referenceOpen', { path: r.line ? `${r.path}:${r.line}` : r.path })}
						onclick={() => openRef(r)}
					>
						<Codicon id="file" size={11} />
						<span class="truncate">{label.name}{r.line ? `:${r.line}` : ''}</span>
						{#if label.dir}<span class="min-w-0 truncate text-(--vscode-descriptionForeground)">{label.dir}</span>{/if}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
