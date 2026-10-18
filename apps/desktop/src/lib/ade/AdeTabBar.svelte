<script lang="ts">
	// Tab row of the Agents layout's center (Orca's worktree tabs): the selected worktree's agent
	// session (or the new-task composer for the folder itself), its terminals, files and task diffs
	// opened from the right side bar (italic while a preview, a dot while unsaved), and "+" for a
	// new terminal in that worktree; "N รอคุณ" at the end. Tasks (the board) shows as its own tab.
	import FileIcon from '#lib/workbench/FileIcon.svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { fileIcon } from '#lib/workbench/fileIcons.ts';
	import { fileOf } from '#lib/workbench/scm.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { adeLayout } from './adeLayout.svelte';
	import { pickSession } from './agentsMode.svelte';
	import { statusLabel } from './model';
	import { adeTasks } from './tasks.svelte';
	import { statusDot } from './ui';
	import { sessionsAttentionLabel } from '#lib/workbench/titlebar.ts';
	import { keyLabel } from '#lib/workbench/keys.ts';

	const key = $derived(adeLayout.key);
	const view = $derived(key ? adeTasks.find(key) : undefined);
	const tabs = $derived(adeLayout.tabs(key));
	const activeTab = $derived(adeLayout.activeTab(key));
	const attention = $derived(sessionsAttentionLabel(adeTasks.counts.needsInput));

	const TAB = 'group flex max-w-60 min-w-0 shrink-0 cursor-default items-center gap-1.5 border-r border-(--vscode-editorGroupHeader-tabsBorder,var(--vscode-widget-border)) pr-1.5 pl-3 text-[13px]';
	const ACTIVE = 'bg-(--vscode-tab-activeBackground) text-(--vscode-tab-activeForeground)';
	const INACTIVE = 'text-(--vscode-tab-inactiveForeground) hover:bg-(--vscode-tab-hoverBackground)';
</script>

<div class="flex h-[35px] shrink-0 items-stretch border-b border-(--vscode-editorGroupHeader-tabsBorder,var(--vscode-widget-border)) bg-(--vscode-editorGroupHeader-tabsBackground)">
	{#if adeLayout.board}
		<div class={[TAB, ACTIVE]}>
			{#if adeLayout.page === 'automations'}<Icon name="clock" size={14} /> Automations{:else}<Icon name="tasks" size={14} /> Tasks{/if}
			<button class="grid size-5 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={adeLayout.page === 'automations' ? 'ปิด Automations' : 'ปิด Tasks'} onclick={() => (adeLayout.board = false)}><Icon name="close" size={13} /></button>
		</div>
	{:else}
		<div class="flex min-w-0 items-stretch overflow-x-auto" role="tablist" aria-label="แท็บของ worktree">
			{#each tabs as t (t.id)}
				{@const active = t.id === activeTab}
				<div
					role="tab"
					tabindex="0"
					aria-selected={active}
					class={[TAB, active ? ACTIVE : INACTIVE]}
					onclick={() => adeLayout.select(key, t.id)}
					onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), adeLayout.select(key, t.id))}
					onauxclick={(e) => e.button === 1 && t.kind !== 'agent' && t.kind !== 'compose' && adeLayout.close(key, t.id)}
					ondblclick={() => (t.kind === 'file' || t.kind === 'diff' ? adeLayout.pin(key, t.key) : t.kind === 'terminal' && adeLayout.rename(key, t.id))}
				>
					{#if t.kind === 'agent' && view}
						<span class={['size-2 shrink-0 rounded-full', statusDot(view)]} title={statusLabel(view)}></span>
						<span class="truncate" title={view.meta.title}>{view.meta.title}</span>
					{:else if t.kind === 'file' || t.kind === 'diff'}
						<FileIcon icon={fileIcon(t.label)} />
						<span class={['truncate', t.preview && 'italic']} title={t.kind === 'diff' ? `${fileOf(t.key)} (diff ของงาน)` : t.key}>{t.label}</span>
						{#if t.kind === 'diff'}<Icon name="git" size={12} />{/if}
					{:else}
						{#if t.kind === 'terminal' && t.color}<span class="size-2 shrink-0 rounded-full" style:background={t.color} aria-hidden="true"></span>{/if}
						<Icon name={t.kind === 'compose' ? 'agent' : 'terminal'} size={14} /><span class="truncate">{t.label}</span>
					{/if}
					{#if t.kind !== 'agent' && t.kind !== 'compose'}
						{@const dirty = t.kind === 'file' && editors.isDirty(t.key)}
						<button
							class={['grid size-5 shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)', !active && !dirty && 'invisible group-hover:visible']}
							aria-label={dirty ? `${t.label} ยังไม่บันทึก: ปิด` : `ปิด ${t.label}`}
							title="ปิด"
							onclick={(e) => (e.stopPropagation(), adeLayout.close(key, t.id))}
						>
							{#if dirty}
								<span class="size-2 rounded-full bg-current group-hover:hidden"></span>
								<span class="hidden group-hover:block"><Icon name="close" size={13} /></span>
							{:else}
								<Icon name="close" size={13} />
							{/if}
						</button>
					{:else}
						<span class="w-1"></span>
					{/if}
				</div>
			{/each}
		</div>
		<div class="flex items-center px-1">
			<button
				class="grid size-6 place-items-center rounded-md enabled:hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-35"
				aria-label="Terminal ใหม่ใน worktree นี้"
				title="Terminal ใหม่ใน worktree นี้ ({keyLabel('cmd+t')})"
				disabled={!workspace.root}
				onclick={() => adeLayout.newTerminal(key)}
			>
				<Icon name="plus" size={16} />
			</button>
		</div>
	{/if}
	<span class="flex-1"></span>
	{#if attention}
		<button
			class="needs-input my-auto mr-2 flex h-[22px] items-center gap-1.5 rounded-md px-2 text-xs text-(--vscode-editorWarning-foreground) hover:bg-(--vscode-toolbar-hoverBackground)"
			title="{attention} — เลือก session"
			onclick={pickSession}
		>
			<span class="size-2 rounded-full bg-(--vscode-editorWarning-foreground)"></span>{attention}
		</button>
	{/if}
</div>

<style>
	/* "N sessions require input": a gentle blink, off when the user asks for less motion. */
	.needs-input {
		animation: kg-attention 2s ease-in-out infinite;
	}
	@keyframes kg-attention {
		50% {
			opacity: 0.55;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.needs-input {
			animation: none;
		}
	}
</style>
