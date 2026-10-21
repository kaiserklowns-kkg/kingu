<script lang="ts">
	// The agent's todo list pinned above the chat input (VS Code's ChatTodoListWidget): the list of
	// the main agent's last TodoWrite call. Collapsed, it shows the item being worked on with its
	// number, "Fixing the bug (2/5)"; expanded, "Todos (2/5)" and every item as completed, in
	// progress or not started. Hidden when there is no list, or every item is done and the turn ended,
	// and with chat.tools.todos.showWidget off.
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { latestTodos, todoProgress, type Todo, type Turn } from './chatParts';

	let { turns, running = false }: { turns: readonly Turn[]; running?: boolean } = $props();

	let open = $state(false);
	const todos = $derived(latestTodos(turns) ?? []);
	const p = $derived(todoProgress(todos));
	const shown = $derived(settings.get<boolean>('chat.tools.todos.showWidget') !== false && todos.length > 0 && (running || p.done < p.total));

	const STATUS: Record<Todo['status'], () => string> = {
		completed: () => t('chatParts.todos.completed'),
		in_progress: () => t('chatParts.todos.inProgress'),
		pending: () => t('chatParts.todos.notStarted')
	};
</script>

{#if shown}
	<div class="mb-1.5 overflow-hidden rounded border border-(--vscode-widget-border,var(--vscode-input-border)) bg-(--vscode-sideBar-background) text-xs" role="region" aria-label={t('chatParts.todos.label')}>
		<button
			type="button"
			class="flex h-7 w-full min-w-0 items-center gap-1 px-1 text-left hover:bg-(--vscode-list-hoverBackground)"
			aria-expanded={open}
			title={open ? t('chatParts.todos.collapse') : t('chatParts.todos.expand')}
			onclick={() => (open = !open)}
		>
			<Codicon id={open ? 'chevron-down' : 'chevron-right'} size={14} />
			{#if open || !p.current}
				<span class="truncate font-semibold">{t('chatParts.todos.titleCount', { n: p.current ? p.n : p.total, total: p.total })}</span>
			{:else}
				{#if p.inProgress}
					<span class="size-2.5 shrink-0 rounded-full bg-(--vscode-charts-blue,#3794ff)" aria-hidden="true"></span>
				{:else}
					<span class="size-2.5 shrink-0 rounded-full border border-current" aria-hidden="true"></span>
				{/if}
				<span class="min-w-0 truncate">{t('chatParts.todos.current', { title: p.inProgress ? p.current.activeForm : p.current.content, n: p.n, total: p.total })}</span>
			{/if}
		</button>
		{#if open}
			<ul class="max-h-48 overflow-y-auto border-t border-(--vscode-widget-border,transparent) py-0.5">
				{#each todos as todo, i (i)}
					<li class="flex min-h-[22px] items-start gap-1.5 py-0.5 pr-2 pl-2" aria-label={t('chatParts.todos.item', { title: todo.content, status: STATUS[todo.status]() })}>
						<span class="mt-px grid size-3.5 shrink-0 place-items-center">
							{#if todo.status === 'completed'}
								<span class="text-(--vscode-charts-green,#73C991)"><Codicon id="pass" size={14} /></span>
							{:else if todo.status === 'in_progress'}
								<span class="size-2.5 rounded-full bg-(--vscode-charts-blue,#3794ff)"></span>
							{:else}
								<span class="size-2.5 rounded-full border border-(--vscode-descriptionForeground)"></span>
							{/if}
						</span>
						<span class={['min-w-0 flex-1 break-words', todo.status === 'completed' && 'text-(--vscode-descriptionForeground) line-through', todo.status === 'in_progress' && 'font-medium']}>
							{todo.status === 'in_progress' ? todo.activeForm : todo.content}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}
