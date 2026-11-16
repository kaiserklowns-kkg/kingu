<script lang="ts">
	// Orca's "Review N Branches" (docs model/worktrees.mdx › Preserved branches): after a bulk
	// delete, the branches git kept because they may hold unmerged commits. The checked ones are
	// force-deleted; the others stay in the repository. Worktree folders are not restored.
	import { invoke } from '@tauri-apps/api/core';
	import { untrack } from 'svelte';
	import AdeDialog from './AdeDialog.svelte';
	import { BUTTON, BUTTON_SECONDARY } from './ui.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { t } from '#lib/i18n/index.ts';

	let { branches, onClose }: { branches: string[]; onClose: () => void } = $props();

	let picked = $state<string[]>([]);
	let busy = $state(false);
	let errors = $state<Record<string, string>>({});
	let left = $state(untrack(() => [...branches]));

	async function deletePicked() {
		busy = true;
		const next: Record<string, string> = {};
		let deleted = 0;
		for (const b of picked) {
			try {
				await invoke('git_delete_branch', { name: b, force: true, repo: null });
				deleted++;
			} catch (e) {
				next[b] = String(e);
			}
		}
		errors = next;
		left = left.filter((b) => !picked.includes(b) || next[b]);
		picked = [];
		busy = false;
		if (deleted) status.flash(t('ade.branches.deleted', { count: deleted }));
		if (!left.length) onClose();
	}
</script>

<AdeDialog title={t('ade.branches.review', { count: left.length })} {busy} {onClose}>
	<div class="space-y-2 text-xs">
		<p class="text-(--vscode-descriptionForeground)">{t('ade.branches.explain')}</p>
		<ul class="max-h-64 space-y-1 overflow-auto rounded border border-(--vscode-widget-border) px-2 py-1.5">
			{#each left as b (b)}
				<li>
					<label class="flex items-center gap-2 font-mono">
						<input type="checkbox" value={b} bind:group={picked} disabled={busy} />
						<span class="truncate" title={b}>{b}</span>
					</label>
					{#if errors[b]}<p class="pl-5 text-(--vscode-errorForeground)">{errors[b]}</p>{/if}
				</li>
			{/each}
		</ul>
	</div>
	{#snippet footer()}
		<button class={BUTTON_SECONDARY} disabled={busy} onclick={onClose}>{t('ade.branches.keepAll')}</button>
		<button class={BUTTON} disabled={busy || !picked.length} onclick={deletePicked}>{t('ade.branches.delete', { count: picked.length })}</button>
	{/snippet}
</AdeDialog>
