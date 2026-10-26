<script lang="ts">
	// Tab row of the Agents layout's center (Orca's worktree tabs): the selected worktree's agent
	// session (or the new-task composer for the folder itself), its terminals, files and task diffs
	// opened from the right side bar (italic while a preview, a dot while unsaved), and "+" for a
	// new terminal in that worktree; "N รอคุณ" at the end. Tasks (the board) shows as its own tab.
	import AgentIcon from '#lib/agent/AgentIcon.svelte';
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
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { invoke } from '@tauri-apps/api/core';
	import NewTabMenu, { type NewTabItem } from './NewTabMenu.svelte';
	import { CUSTOM_PICK, KNOWN_BINS, pickerItems } from './agentProfiles';
	import { enabledBins } from './agentCli';
	import { isMarkdownEditor } from './adeMarkdown.ts';
	import type { AdeTab } from './adeTabs';
	import { terminalBells } from './terminalBell.svelte';
	import { t as tr } from '#lib/i18n/index.ts';

	// Tab context menu, like the IDE's: close tabs, copy or reveal a file. The agent session and the
	// composer stay (they are the worktree itself).
	let menu = $state<{ tab: AdeTab; x: number; y: number } | null>(null);
	/** Bulk closes skip the agent session, the composer and pinned tabs (Orca's pinned tabs). */
	const closable = (t: AdeTab) => t.kind !== 'agent' && t.kind !== 'compose' && !adeLayout.isPinned(key, t.id);
	const TAB_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#64748b'];
	const menuItems = $derived.by(() => {
		if (!menu) return [];
		const t = menu.tab;
		const i = tabs.findIndex((x) => x.id === t.id);
		const file = t.kind === 'file' || t.kind === 'diff';
		return [
			menuItem('close', 'Close', { enabled: t.kind !== 'agent' && t.kind !== 'compose' }),
			menuItem('others', 'Close Others', { enabled: tabs.some((x) => x.id !== t.id && closable(x)) }),
			menuItem('right', 'Close to the Right', { enabled: tabs.slice(i + 1).some(closable) }),
			menuSeparator,
			menuItem('copyPath', 'Copy Path', { enabled: file }),
			menuItem('reveal', 'Reveal in Finder', { enabled: file }),
			menuItem('keep', 'Keep Open', { enabled: file && 'preview' in t && t.preview }),
			menuItem('preview', 'Toggle Markdown Preview', { enabled: file && 'key' in t && isMarkdownEditor(t.key) }),
			menuSeparator,
			menuItem('pin', adeLayout.isPinned(key, t.id) ? 'Unpin Tab' : 'Pin Tab', { enabled: closable(t) || adeLayout.isPinned(key, t.id) }),
			{
				type: 'submenu' as const,
				id: 'color',
				text: 'Tab Color',
				items: [
					...TAB_COLORS.map((c) => menuItem(`color:${c}`, c, { checked: adeLayout.colorOf(key, t.id) === c })),
					menuSeparator,
					menuItem('color:', 'None', { checked: !adeLayout.colorOf(key, t.id) })
				]
			}
		];
	});
	async function runMenu(id: string, t: AdeTab) {
		const i = tabs.findIndex((x) => x.id === t.id);
		const rel = 'key' in t ? fileOf(t.key) : '';
		switch (id) {
			case 'close':
				return adeLayout.close(key, t.id);
			case 'others':
			case 'right':
				for (const x of (id === 'others' ? tabs.filter((x) => x.id !== t.id) : tabs.slice(i + 1)).filter(closable)) adeLayout.close(key, x.id);
				return;
			case 'copyPath': {
				const text = workspace.root ? `${workspace.root}/${rel}` : rel;
				await navigator.clipboard.writeText(text);
				return status.flash(tr('legacyAde.adeTabBar.copied', { text }), 3000);
			}
			case 'reveal':
				return invoke('fs_reveal', { rel }).catch((e) => status.error(String(e)));
			case 'keep':
				return 'key' in t && adeLayout.pin(key, t.key);
			case 'preview':
				adeLayout.select(key, t.id);
				return adeLayout.toggleMarkdownPreview(key);
			case 'pin':
				return adeLayout.togglePin(key, t.id);
		}
		if (id.startsWith('color:')) return adeLayout.setColor(key, t.id, id.slice(6) || undefined);
	}

	// The "+" is Orca's new-tab menu: a searchable list of a new tab's kinds, then the agent CLIs
	// found on the PATH (each runs in a new terminal of this worktree, so agents can run side by side).
	let create = $state<{ x: number; y: number } | null>(null);
	let found = $state<string[]>([]);
	const createItems = $derived<NewTabItem[]>([
		{ id: 'terminal', label: 'New Terminal', keyLabel: keyLabel('cmd+t') },
		{ id: 'browser', label: 'New Browser Tab', keyLabel: keyLabel('cmd+shift+b') },
		{ id: 'markdown', label: 'New Markdown', keyLabel: keyLabel('cmd+shift+m') },
		{ id: 'openMarkdown', label: 'Open Markdown…', keyLabel: keyLabel('cmd+shift+o') },
		...pickerItems(found, '')
			.filter((r) => r.id !== CUSTOM_PICK)
			.map((r) => ({ id: `agent:${r.id}`, label: r.label, description: r.description, agent: r.agent, group: 'Agents' }))
	]);
	async function openCreate(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		create = { x: r.left, y: r.bottom + 2 };
		found = enabledBins(
			await invoke<string[]>('agent_cli_found', { names: KNOWN_BINS }).catch(() => [] as string[]),
			settings.get<string[]>('kingu.agent.disabled'),
			null
		);
	}
	function runCreate(id: string) {
		if (id === 'browser') adeLayout.newBrowser(key);
		else if (id === 'markdown') adeLayout.newMarkdown(key);
		else if (id === 'openMarkdown') void adeLayout.openMarkdown(key);
		else if (id.startsWith('agent:')) {
			const bin = id.slice(6);
			adeLayout.newTerminal(key, { title: pickerItems(found, '').find((r) => r.id === bin)?.label ?? bin, run: [bin] });
		} else adeLayout.newTerminal(key);
	}

	const key = $derived(adeLayout.key);
	const view = $derived(key ? adeTasks.find(key) : undefined);
	const tabs = $derived(adeLayout.tabs(key));
	const activeTab = $derived(adeLayout.activeTab(key));
	const attention = $derived(sessionsAttentionLabel(adeTasks.counts.needsInput));

	// Orca's drag reorder: drop a tab on another to put it before it, on the strip to move it last.
	let dragId = $state<string | null>(null);
	let dropId = $state<string | null>(null);
	function dragStart(e: DragEvent, id: string) {
		dragId = id;
		e.dataTransfer?.setData('text/plain', id);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}
	function dragOver(e: DragEvent, id: string) {
		if (!dragId || dragId === id) return;
		e.preventDefault();
		dropId = id;
	}
	function drop(e: DragEvent, id: string) {
		e.preventDefault();
		e.stopPropagation();
		if (dragId && dragId !== id) adeLayout.moveTab(key, dragId, id);
		dragId = null;
		dropId = null;
	}
	function dropEnd(e: DragEvent) {
		e.preventDefault();
		if (dragId) adeLayout.moveTab(key, dragId, null);
		dragId = null;
		dropId = null;
	}

	// Same look as the IDE's editor tabs: rounded tops in the strip, an accent line on the active one.
	const TAB = 'group relative flex h-[30px] max-w-60 min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-t-lg pr-1.5 pl-3 text-[13px] transition-colors';
	const ACTIVE = 'bg-(--vscode-tab-activeBackground) text-(--vscode-tab-activeForeground)';
	const ACCENT = 'absolute inset-x-2.5 top-0 h-0.5 rounded-b-full bg-(--vscode-tab-activeBorderTop)';
	const INACTIVE = 'text-(--vscode-tab-inactiveForeground) hover:bg-(--vscode-tab-hoverBackground)';
</script>

<div class="flex h-[35px] shrink-0 items-end gap-0.5 border-b border-(--vscode-editorGroupHeader-tabsBorder,var(--vscode-widget-border)) bg-(--vscode-editorGroupHeader-tabsBackground) px-1">
	{#if adeLayout.board}
		<div class={[TAB, ACTIVE]}>
			<span class={ACCENT}></span>
			{#if adeLayout.page === 'now'}<Icon name="agent" size={14} /> Now{:else if adeLayout.page === 'automations'}<Icon name="clock" size={14} /> Automations{:else if adeLayout.page === 'issues'}<Icon name="bug" size={14} /> Issues{:else}<Icon name="tasks" size={14} /> Tasks{/if}
			<button class="grid size-5 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={tr('legacyAde.adeTabBar.closePage', { page: adeLayout.page === 'now' ? 'Now' : adeLayout.page === 'automations' ? 'Automations' : adeLayout.page === 'issues' ? 'Issues' : 'Tasks' })} onclick={() => (adeLayout.board = false)}><Icon name="close" size={13} /></button>
		</div>
	{:else}
		<div
			class="flex min-w-0 items-end gap-0.5 overflow-x-auto [scrollbar-width:none]"
			role="tablist"
			tabindex="-1"
			aria-label={tr('legacyAde.adeTabBar.worktreeTabs')}
			ondragover={(e) => dragId && e.preventDefault()}
			ondrop={dropEnd}
		>
			{#each tabs as t (t.id)}
				{@const active = t.id === activeTab}
				<div
					role="tab"
					tabindex="0"
					aria-selected={active}
					class={[TAB, active ? ACTIVE : INACTIVE, dropId === t.id && 'border-l-2 border-(--vscode-focusBorder)']}
					draggable="true"
					ondragstart={(e) => dragStart(e, t.id)}
					ondragover={(e) => dragOver(e, t.id)}
					ondrop={(e) => drop(e, t.id)}
					ondragend={() => (dragId = null, dropId = null)}
					onclick={() => adeLayout.select(key, t.id)}
					onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), adeLayout.select(key, t.id))}
					onauxclick={(e) => e.button === 1 && t.kind !== 'agent' && t.kind !== 'compose' && !adeLayout.isPinned(key, t.id) && adeLayout.close(key, t.id)}
					ondblclick={() => (t.kind === 'file' || t.kind === 'diff' ? adeLayout.pin(key, t.key) : t.kind === 'terminal' && adeLayout.rename(key, t.id))}
					oncontextmenu={(e) => (e.preventDefault(), (menu = { tab: t, x: e.clientX, y: e.clientY }))}
				>
					{#if active}<span class={ACCENT}></span>{/if}
					{#if adeLayout.colorOf(key, t.id) ?? (t.kind === 'terminal' ? t.color : undefined)}
						{@const dot = adeLayout.colorOf(key, t.id) ?? (t.kind === 'terminal' ? t.color : undefined)}
						<span class="size-2 shrink-0 rounded-full" style:background={dot} aria-hidden="true"></span>
					{/if}
					{#if t.kind === 'agent' && view}
						<span class={['size-2 shrink-0 rounded-full', statusDot(view)]} title={statusLabel(view)}></span>
						<AgentIcon agent={view.meta.agent || 'claude'} size={14} />
						<span class="truncate" title={view.meta.title}>{view.meta.title}</span>
					{:else if t.kind === 'browser'}
						<Icon name="globe" size={14} /><span class="truncate" title={t.label}>{t.label}</span>
					{:else if t.kind === 'file' || t.kind === 'diff'}
						<FileIcon icon={fileIcon(t.label)} />
						<span class={['truncate', t.preview && 'italic']} title={t.kind === 'diff' ? tr('legacyAde.adeTabBar.diffOfTask', { file: fileOf(t.key) }) : t.key}>{t.label}</span>
						{#if t.kind === 'diff'}<Icon name="git" size={12} />{/if}
					{:else}
						<Icon name={t.kind === 'compose' ? 'agent' : 'terminal'} size={14} /><span class="truncate">{t.label}</span>
					{/if}
					{#if !active && terminalBells.has(key, t.id)}
						<!-- kingu.agent.notifications.terminalBell: this terminal rang while hidden. -->
						<span class="size-1.5 shrink-0 rounded-full bg-(--vscode-activityBarBadge-background)" role="status" aria-label={tr('ade.bell.dot')} title={tr('ade.bell.dot')}></span>
					{/if}
					{#if t.kind !== 'agent' && t.kind !== 'compose' && !adeLayout.isPinned(key, t.id)}
						{@const dirty = t.kind === 'file' && editors.isDirty(t.key)}
						<button
							class={['grid size-5 shrink-0 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)', !active && !dirty && 'invisible group-hover:visible']}
							aria-label={dirty ? tr('legacyAde.adeTabBar.unsavedClose', { label: t.label }) : tr('legacyAde.adeTabBar.closeTab', { label: t.label })}
							title={tr('legacyAde.adeTabBar.close')}
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
	{/if}
	<!-- Also on a page (Now, Tasks…): a new tab leaves the page for the worktree. -->
	<div class="flex items-center self-center px-1">
		<button
			class="grid size-6 place-items-center rounded-md enabled:hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-35"
			aria-label="New Tab"
			title="New Tab"
			disabled={!workspace.root}
			onclick={openCreate}
		>
			<Icon name="plus" size={16} />
		</button>
	</div>
	<span class="flex-1"></span>
	{#if attention}
		<button
			class="needs-input my-auto mr-2 flex h-[22px] items-center gap-1.5 rounded-md px-2 text-xs text-(--vscode-editorWarning-foreground) hover:bg-(--vscode-toolbar-hoverBackground)"
			title={tr('legacyAde.adeTabBar.chooseSession', { attention })}
			onclick={pickSession}
		>
			<span class="size-2 rounded-full bg-(--vscode-editorWarning-foreground)"></span>{attention}
		</button>
	{/if}
</div>

{#if create}
	{@const at = create}
	<NewTabMenu items={createItems} x={at.x} y={at.y} onRun={runCreate} onClose={() => (create = null)} />
{/if}
{#if menu}
	{@const target = menu.tab}
	<PopupMenu items={menuItems} label="Tab" x={menu.x} y={menu.y} onRun={(node) => node.type === 'item' && runMenu(node.id, target)} onClose={() => (menu = null)} />
{/if}

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
