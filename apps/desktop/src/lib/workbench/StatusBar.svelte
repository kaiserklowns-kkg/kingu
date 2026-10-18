<script lang="ts">
	import { lsp } from '#lib/lsp/lsp.svelte.ts';
	import TeamStatus from '#lib/team/TeamStatus.svelte';
	import Icon from './Icon.svelte';
	import { editors } from './editors.svelte';
	import { layout } from './layout.svelte';
	import { quick } from './quick.svelte';
	import { status } from './status.svelte';
	import { appMode } from './mode.svelte';
	import { adeLayout } from '#lib/ade/adeLayout.svelte.ts';
	import { openAgents, pickSession } from '#lib/ade/agentsMode.svelte.ts';
	import { runtime } from '#lib/ade/runtime.svelte.ts';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import StatusResources from './StatusResources.svelte';
	import PopupMenu, { menuItem } from './PopupMenu.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';

	const languageNames: Record<string, string> = {
		typescript: 'TypeScript',
		javascript: 'JavaScript',
		rust: 'Rust',
		go: 'Go',
		json: 'JSON',
		markdown: 'Markdown',
		css: 'CSS',
		html: 'HTML',
		ini: 'TOML',
		plaintext: 'Plain Text'
	};

	const languageStatus = $derived(lsp.statusFor(editors.language));

	// One status bar for the IDE and the Agents layout: the branch of what you are looking at (the
	// selected worktree in Agents), problems, agent activity and cost in both; editor items in the IDE.
	const branch = $derived(appMode.isAgents && adeLayout.key ? `kingu/${adeLayout.key}` : status.branch);
	const counts = $derived(adeTasks.counts);
	const cost = $derived(adeTasks.views.reduce((sum, v) => sum + (runtime.run(v.meta.slug)?.result?.total_cost_usd ?? v.meta.last_run?.cost_usd ?? 0), 0));
	const editorItems = $derived(!appMode.isAgents && editors.active);
	const ITEM = 'flex h-full items-center gap-1 px-2 hover:bg-(--vscode-toolbar-hoverBackground)';

	// Right-click: which resource items show (Orca's status bar context menu).
	const TOGGLES = [
		{ id: 'kingu.statusBar.keepAwake.visible', label: 'Keep Awake' },
		{ id: 'kingu.statusBar.resources.visible', label: 'Resource Manager' },
		{ id: 'kingu.statusBar.ports.visible', label: 'Ports' }
	];
	let menu = $state<{ x: number; y: number } | null>(null);
	const menuItems = $derived(TOGGLES.map((t) => menuItem(t.id, t.label, { checked: settings.get<boolean>(t.id) !== false })));
	function toggleItem(id: string) {
		const shown = settings.get<boolean>(id) !== false;
		void settings.set(id, shown ? false : undefined, 'user');
	}
</script>

<!-- 22px, items 22px line-height (VS Code statusbarPart). -->
<footer
	oncontextmenu={(e) => (e.preventDefault(), (menu = { x: e.clientX, y: e.clientY - 4 - 22 * TOGGLES.length - 12 }))}
	class="flex h-(--kg-statusbar-height) shrink-0 items-center border-t border-(--vscode-statusBar-border) bg-(--vscode-statusBar-background) text-xs leading-(--kg-statusbar-height) text-(--vscode-statusBar-foreground)"
>
	{#if branch}
		<span class="flex h-full items-center gap-1 px-2" title={appMode.isAgents && adeLayout.key ? 'branch ของ worktree ที่เลือก' : 'branch ปัจจุบัน'}><Icon name="branch" size={14} />{branch}</span>
	{/if}
	<button class={ITEM} onclick={() => (appMode.setMode('workbench'), layout.showPanel('problems'))}>
		<Icon name="error" size={14} />{lsp.counts.errors} <Icon name="warning" size={14} />{lsp.counts.warnings}
	</button>
	{#if lsp.progress && lsp.progress !== languageStatus?.text}
		<button class="flex h-full min-w-0 items-center gap-1 truncate px-2 hover:bg-(--vscode-toolbar-hoverBackground)" title={lsp.progress} onclick={() => layout.showPanel('output')}>
			<span class="inline-block size-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent"></span>
			<span class="truncate">{lsp.progress}</span>
		</button>
	{/if}
	<!-- Agents: in progress / waiting for you; opens the Agents layout (or the waiting session). -->
	<button
		class={ITEM}
		title={counts.needsInput ? 'เลือก session ที่รอคุณ' : 'Agents (⇧⌘A)'}
		onclick={() => (counts.needsInput ? pickSession() : openAgents())}
	>
		<Icon name="agent" size={14} />{counts.inProgress} กำลังทำ
		{#if counts.needsInput}<span class="text-(--vscode-editorWarning-foreground)">· {counts.needsInput} รอคุณ</span>{/if}
	</button>
	{#if cost > 0}<span class="px-2 tabular-nums" title="ค่าใช้จ่าย agent ในโฟลเดอร์นี้">${cost.toFixed(2)}</span>{/if}
	{#if status.message}<span class="truncate px-2">{status.message}</span>{/if}
	<div class="flex-1"></div>
	<TeamStatus />
	<StatusResources />
	{#if editorItems && languageStatus}
		<button
			class={['h-full max-w-80 truncate px-2 hover:bg-(--vscode-toolbar-hoverBackground)', languageStatus.state === 'not-installed' || languageStatus.state === 'error' ? 'text-(--vscode-editorWarning-foreground)' : '']}
			title={languageStatus.tooltip}
			onclick={() => layout.showPanel('output')}>{languageStatus.text}</button
		>
	{/if}
	{#if editorItems}
		<button class="h-full px-2 hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => quick.show(':')}>Ln {editors.cursor.line}, Col {editors.cursor.column}</button>
		<span class="px-2">{editors.indent}</span>
		<span class="px-2">UTF-8</span>
		<span class="px-2">{editors.eol}</span>
		<span class="px-2">{languageNames[editors.language] ?? editors.language}</span>
	{/if}
</footer>

{#if menu}
	<PopupMenu items={menuItems} label="Status Bar" x={menu.x} y={menu.y} onRun={(node) => node.type === 'item' && toggleItem(node.id)} onClose={() => (menu = null)} />
{/if}
