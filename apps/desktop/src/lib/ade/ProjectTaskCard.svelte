<script lang="ts">
	// A task of another added project on the agent board (Orca's Agent Dashboard covers every
	// repo): title, state, agent, project and age. Its folder is not open here, so a click opens
	// that project, then the task (projects.svelte.ts `open`).
	import AgentIcon from '#lib/agent/AgentIcon.svelte';
	import { statusLabel, timeAgo, type TaskView } from './model';
	import { projects } from './projects.svelte';
	import { projectName } from './projects';
	import { statusDot } from './ui';
	import { t } from '#lib/i18n/index.ts';

	let { view, root }: { view: TaskView; root: string } = $props();
	const meta = $derived(view.meta);
	const when = $derived(Math.max(meta.updated_at, view.runtime?.updatedAt ?? 0));
	const summary = $derived(view.runtime?.lastEvent ?? meta.last_run?.summary ?? (meta.prompt.split('\n', 1)[0] || ''));
	const open = () => void projects.open(root, meta.slug);
</script>

<div
	role="button"
	tabindex="0"
	aria-label="{meta.title} — {statusLabel(view)} — {projectName(root)}"
	title={t('adeWorkflow.board.otherProject', { project: projectName(root) })}
	class="group relative cursor-pointer rounded-lg border border-(--vscode-widget-border) bg-(--vscode-editor-background) p-2.5 text-xs outline-none transition-[border-color,box-shadow] hover:border-(--vscode-focusBorder)/60 hover:shadow-md hover:shadow-black/25 focus-visible:border-(--vscode-focusBorder)"
	onclick={open}
	onkeydown={(e) => e.target === e.currentTarget && e.key === 'Enter' && (e.preventDefault(), open())}
>
	<div class="flex items-center gap-1.5">
		<span class={['size-2 shrink-0 rounded-full', statusDot(view)]} title={statusLabel(view)}></span>
		<span class="min-w-0 flex-1 truncate font-medium text-(--vscode-foreground)" title={meta.title}>{meta.title}</span>
		<span class="shrink-0 text-(--vscode-descriptionForeground)">{timeAgo(when, projects.now)}</span>
	</div>
	{#if summary}<p class="mt-1 line-clamp-2 text-(--vscode-descriptionForeground)">{summary}</p>{/if}
	<div class="mt-1.5 flex items-center gap-1.5 text-[11px] text-(--vscode-descriptionForeground)">
		{#if meta.agent}<AgentIcon agent={meta.agent} size={12} /><span class="truncate">{meta.agent}</span><span aria-hidden="true">·</span>{/if}
		<span class="truncate rounded-sm bg-(--vscode-badge-background)/60 px-1 text-(--vscode-badge-foreground)">{projectName(root)}</span>
		<span class="truncate font-mono">{meta.slug}</span>
	</div>
</div>
