<script lang="ts">
	// Orca's merge row (HostedReviewActions): the default method's button with the others in its
	// menu, gated by the PR's merge state; once merged, deleting the task's workspace.
	import Icon from '#lib/workbench/Icon.svelte';
	import PopupMenu, { menuItem } from '#lib/workbench/PopupMenu.svelte';
	import { methodLabel, mergeMethods, mergePresentation, type MergeMethod, type MergeTone, type PrStatus } from './prChecks.ts';
	import { prStatuses } from './prStatus.svelte.ts';
	import { adeTasks } from './tasks.svelte.ts';
	import { BUTTON, BUTTON_SECONDARY } from './ui.ts';
	import { forgeFor, ft } from './forge.ts';
	import { t } from '#lib/i18n/index.ts';

	let { slug, pr }: { slug: string; pr: PrStatus } = $props();

	let deleteBranch = $state(false);
	let menu = $state<{ x: number; y: number; keyboard: boolean } | null>(null);

	const forge = $derived(forgeFor(pr.url, adeTasks.gh));
	const view = $derived(mergePresentation(pr, forge));
	const methods = $derived(mergeMethods(prStatuses.settingsFor(pr.url)));
	const busy = $derived(!!adeTasks.busy[slug]);
	const isTask = $derived(!!slug && adeTasks.list.some((t) => t.slug === slug));
	const TONE: Record<MergeTone, string> = {
		ok: 'text-[#73C991]',
		warn: 'text-(--vscode-editorWarning-foreground)',
		error: 'text-(--vscode-errorForeground)',
		neutral: 'text-(--vscode-descriptionForeground)'
	};

	function openMenu(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		menu = { x: r.left, y: r.bottom + 2, keyboard: e.detail === 0 };
	}
	const merge = (m: MergeMethod) => adeTasks.mergePr(slug, m, deleteBranch);
</script>

{#if pr.state === 'OPEN'}
	<div class="space-y-1">
		<div class="flex items-center gap-1.5">
			<span class="inline-flex">
				<button class={[BUTTON, 'rounded-r-none']} disabled={busy || !view.canMerge} title={view.canMerge ? methodLabel(methods.defaultMethod) : view.tooltip} onclick={() => merge(methods.defaultMethod)}>
					<Icon name="merge" size={12} />
					{busy ? t('forge.merge.working') : methodLabel(methods.defaultMethod)}
				</button>
				<button class={[BUTTON, 'rounded-l-none border-l border-black/20 px-1']} aria-label={t('forge.merge.otherMethods')} title={t('forge.merge.otherMethods')} disabled={busy || !view.canMerge} onclick={openMenu}>
					<Icon name="chevronDown" size={12} />
				</button>
			</span>
			<span class={['truncate', TONE[view.tone]]} title={view.tooltip}>{view.label}</span>
		</div>
		{#if view.canMerge}
			<label class="flex items-center gap-1.5 text-(--vscode-descriptionForeground)">
				<input type="checkbox" bind:checked={deleteBranch} disabled={busy} />
				{ft('forge.merge.deleteBranch', forge, { branch: pr.head_ref || '' })}
			</label>
		{/if}
	</div>
	{#if menu}
		<PopupMenu
			items={methods.methods.map((m) => menuItem(m, methodLabel(m)))}
			label={t('ade.prChecks.mergeLabel')}
			x={menu.x}
			y={menu.y}
			focusFirst={menu.keyboard}
			onRun={(node) => node.type === 'item' && merge(node.id as MergeMethod)}
			onClose={() => (menu = null)}
		/>
	{/if}
{:else if pr.state === 'MERGED' && isTask}
	<!-- Orca's MergedReviewActions: the work landed, so the workspace can go. -->
	<button class={[BUTTON_SECONDARY, 'text-(--vscode-errorForeground)']} disabled={busy} onclick={() => adeTasks.remove(slug)}>
		<Icon name="trash" size={12} /> {t('forge.merge.removeWorkspace')}
	</button>
{/if}
