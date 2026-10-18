<script lang="ts">
	// Orca's Ctrl+Tab switcher: while Ctrl is held each Tab (Shift+Tab back) moves through the
	// worktree's tabs by recent use; releasing Ctrl shows the selected one, Escape or leaving the window cancels.
	import { onMount } from 'svelte';
	import FileIcon from '#lib/workbench/FileIcon.svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { fileIcon } from '#lib/workbench/fileIcons.ts';
	import { adeLayout } from './adeLayout.svelte';

	const s = $derived(adeLayout.switcher);
	const rows = $derived.by(() => {
		if (!s) return [];
		const tabs = adeLayout.tabs(s.key);
		return s.ids.map((id) => tabs.find((t) => t.id === id)).filter((t) => t !== undefined);
	});

	onMount(() => {
		// Capture phase: a focused terminal would otherwise take the Escape.
		const up = (e: KeyboardEvent) => {
			if (adeLayout.switcher && (e.key === 'Control' || !e.ctrlKey)) adeLayout.commitSwitcher();
		};
		const down = (e: KeyboardEvent) => {
			if (adeLayout.switcher && e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				adeLayout.switcher = null;
			}
		};
		const blur = () => (adeLayout.switcher = null);
		window.addEventListener('keyup', up, true);
		window.addEventListener('keydown', down, true);
		window.addEventListener('blur', blur);
		return () => {
			window.removeEventListener('keyup', up, true);
			window.removeEventListener('keydown', down, true);
			window.removeEventListener('blur', blur);
		};
	});
</script>

{#if s && rows.length}
	<div class="pointer-events-none absolute inset-0 z-40 flex justify-center pt-[12vh]">
		<div
			role="listbox"
			aria-label="Switch Tab"
			class="w-[min(520px,calc(100vw-48px))] self-start overflow-hidden rounded-md border border-(--vscode-widget-border) bg-(--vscode-quickInput-background,var(--vscode-editorWidget-background)) py-1 text-[13px] text-(--vscode-quickInput-foreground,var(--vscode-foreground)) shadow-[0_4px_16px_var(--vscode-widget-shadow)]"
		>
			<div class="px-3 pb-1 text-[11px] text-(--vscode-descriptionForeground)">Switch Tab</div>
			{#each rows as t, i (t.id)}
				<div
					role="option"
					aria-selected={i === s.index}
					class={['flex h-8 items-center gap-2 px-3', i === s.index && 'bg-(--vscode-quickInputList-focusBackground,var(--vscode-list-activeSelectionBackground)) text-(--vscode-quickInputList-focusForeground,var(--vscode-list-activeSelectionForeground))']}
				>
					{#if t.kind === 'file' || t.kind === 'diff'}
						<FileIcon icon={fileIcon(t.label)} />
					{:else}
						<Icon name={t.kind === 'terminal' ? 'terminal' : 'agent'} size={14} />
					{/if}
					<span class="min-w-0 flex-1 truncate">{t.label}</span>
					{#if t.kind === 'file' && editors.isDirty(t.key)}<span class="size-2 shrink-0 rounded-full bg-current" aria-label="ยังไม่บันทึก"></span>{/if}
				</div>
			{/each}
		</div>
	</div>
{/if}
