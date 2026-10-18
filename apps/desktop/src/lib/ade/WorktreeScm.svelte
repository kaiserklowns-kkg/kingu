<script lang="ts">
	// Source Control tab of the ADE's right side bar (Orca's SourceControl) for the selected
	// worktree: the branch with ahead / behind and the remote actions (Sync, Push or Publish, Pull,
	// Fetch, Commit & Push), the IDE's Source Control view (commit box, Staged Changes, Changes)
	// on this worktree's repository, and for a task the files changed since it forked from its base
	// (Orca's "Committed on Branch") with accept / reject, PR and merge from the task review.
	import Icon from '#lib/workbench/Icon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import ScmView from '#lib/workbench/ScmView.svelte';
	import { scm } from '#lib/workbench/scm.svelte.ts';
	import { taskDiffKey, type ScmSource } from '#lib/workbench/scm.ts';
	import { worktreeDir } from './keys.ts';
	import { rightSidebar } from './rightSidebar.svelte.ts';
	import { adeTasks } from './tasks.svelte.ts';
	import TaskPage from './TaskPage.svelte';
	import DiffNotesList from './DiffNotesList.svelte';

	let { slug }: { slug: string } = $props();

	const repo = $derived(slug ? rightSidebar.repo(slug) : null);
	const source: ScmSource = $derived(repo ?? scm);
	const st = $derived(source.repo);
	const busy = $derived(source.busy || (!slug && scm.op !== null));
	const unpublished = $derived(!!st?.branch && (!st.upstream || st.upstream_gone));
	let menu = $state<{ x: number; y: number } | null>(null);

	type Op = 'push' | 'pull' | 'fetch' | 'sync';
	function remote(op: Op) {
		if (repo) return repo.remote(op);
		return op === 'push' ? scm.push() : op === 'pull' ? scm.pull() : op === 'fetch' ? scm.fetch() : scm.sync();
	}

	async function commitAndPush() {
		const before = source.groups.staged.length;
		await source.commit();
		if (before && !source.groups.staged.length) await remote('push');
	}

	function openMenu(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		menu = { x: r.left, y: r.bottom + 2 };
	}

	const items = $derived([
		menuItem('commitPush', 'Commit & Push', { enabled: !!source.groups.staged.length && !!source.message.trim() }),
		menuSeparator,
		menuItem('push', unpublished ? 'Publish Branch' : `Push${st?.ahead ? ` (${st.ahead})` : ''}`, { enabled: !!st?.branch }),
		menuItem('pull', `Pull${st?.behind ? ` (${st.behind})` : ''}`, { enabled: !unpublished }),
		menuItem('sync', 'Sync', { enabled: !unpublished }),
		menuItem('fetch', 'Fetch', { enabled: !!st?.remotes.length })
	]);

	const ACTION = 'grid size-6 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex h-8 shrink-0 items-center gap-1 pr-1 pl-3 text-[13px]">
		<Icon name="branch" size={14} />
		<span class="min-w-0 flex-1 truncate font-medium" title={st?.upstream ? `${st.branch} → ${st.upstream}` : (st?.branch ?? '')}>
			{st?.branch ?? st?.head ?? (slug ? adeTasks.branchOf(slug) : '')}
			{#if st && (st.ahead || st.behind)}<span class="ml-1 font-mono text-xs text-(--vscode-descriptionForeground)">↑{st.ahead} ↓{st.behind}</span>{/if}
		</span>
		<button class={ACTION} disabled={busy || !st?.branch} aria-label={unpublished ? 'Publish Branch' : 'Sync'} title={unpublished ? 'Publish Branch' : 'Sync (pull แล้ว push)'} onclick={() => remote(unpublished ? 'push' : 'sync')}>
			<Icon name={unpublished ? 'openExternal' : 'refresh'} size={15} />
		</button>
		<button class={ACTION} disabled={busy} aria-label="More source control actions" title="More source control actions" onclick={openMenu}><Icon name="menu" size={15} /></button>
	</div>
	<div class="min-h-0 flex-1 overflow-y-auto">
		<div class="flex min-h-[40%] flex-col">
			<ScmView source={repo ?? undefined} diffKey={slug ? (rel) => taskDiffKey(slug, rel) : undefined} fileKey={slug ? (rel) => `${worktreeDir(slug)}/${rel}` : undefined} />
		</div>
		{#if !slug}<DiffNotesList worktree="" />{/if}
		{#if slug}
			<div class="border-t border-(--vscode-widget-border)">
				<TaskPage {slug} sections="review" embedded />
			</div>
		{/if}
	</div>
</div>

{#if menu}
	{@const m = menu}
	<PopupMenu
		{items}
		label="Source Control"
		x={m.x}
		y={m.y}
		onRun={(node) => {
			if (node.type !== 'item') return;
			if (node.id === 'commitPush') void commitAndPush();
			else void remote(node.id as Op);
		}}
		onClose={() => (menu = null)}
	/>
{/if}
