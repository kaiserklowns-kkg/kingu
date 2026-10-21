<script lang="ts">
	// A task card's small badges (side bar and board): the best-of-N attempt letter (opens Compare
	// Attempts), the stacked-on-another-task mark, the dispatched-by-an-agent mark (orchestration)
	// and a hibernated agent's resume button.
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { adeTasks } from './tasks.svelte';
	import { attemptLabel, attempts } from './attempts.svelte';
	import { attemptLetter } from './attempts';
	import { cliSessions } from './cliSessions.svelte';
	import { timeAgo, type TaskMeta } from './model';

	let { meta, parentTitle }: { meta: TaskMeta; parentTitle?: string } = $props();

	const letter = $derived(attemptLetter(meta));
	const dispatcher = $derived(meta.dispatched_by ? (adeTasks.find(meta.dispatched_by)?.meta.title ?? meta.dispatched_by) : null);
	const sleeping = $derived(!!meta.hibernated_at && !cliSessions.has(meta.slug));
	const CHIP = 'grid h-4 min-w-4 shrink-0 place-items-center rounded px-1 text-[10px] leading-none font-semibold';
</script>

{#if letter}
	<button
		class="{CHIP} bg-(--vscode-badge-background) text-(--vscode-badge-foreground) hover:opacity-80"
		title="{attemptLabel(meta)} · {t('adeAttempts.action.compare')}"
		aria-label={t('adeAttempts.action.compare')}
		onclick={(e) => (e.stopPropagation(), attempts.compare(meta.slug))}
		ondblclick={(e) => e.stopPropagation()}>{letter}</button
	>
{/if}
{#if meta.parent}
	<span class="shrink-0 text-(--vscode-descriptionForeground)" title={t('adeAttempts.badge.stacked', { parent: parentTitle ?? meta.base })}><Icon name="branch" size={11} /></span>
{/if}
{#if dispatcher}
	<span class="shrink-0 text-(--vscode-descriptionForeground)" title={t('adeAttempts.badge.dispatched', { task: dispatcher })}><Icon name="robot" size={11} /></span>
{/if}
{#if sleeping}
	<button
		class="grid size-4 shrink-0 place-items-center rounded text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)"
		title="{t('adeAttempts.badge.hibernated', { ago: timeAgo(meta.hibernated_at ?? 0, adeTasks.now) })} · {t('adeAttempts.badge.resume')}"
		aria-label={t('adeAttempts.badge.resume')}
		onclick={(e) => (e.stopPropagation(), adeTasks.openTask(meta.slug), void adeTasks.resumeCli(meta.slug))}
		ondblclick={(e) => e.stopPropagation()}><Icon name="sleep" size={11} /></button
	>
{/if}
