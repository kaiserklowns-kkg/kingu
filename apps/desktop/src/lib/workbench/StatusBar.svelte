<script lang="ts">
	import { debug } from '#lib/debug/debug.svelte.ts';
	import { lsp } from '#lib/lsp/lsp.svelte.ts';
	import TeamStatus from '#lib/team/TeamStatus.svelte';
	import UsageStatus from '#lib/accounts/UsageStatus.svelte';
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
	import { commands } from '#lib/workbench/commands.svelte.ts';
	import { scm } from '#lib/workbench/scm.svelte.ts';
	import { syncItem } from '#lib/workbench/scmRemote.ts';
	import { languageName } from '#lib/editor/languages.ts';
	import { textFiles } from './textFileService.svelte';
	import { notifications } from './notifications.svelte';
	import { statusItemShown } from '#lib/debug/debugSettings.ts';
	import { problemAt } from '#lib/lsp/problemsSettings.ts';
	import { severityName } from '#lib/lsp/convert.ts';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';

	const languageStatus = $derived(lsp.statusFor(editors.language));
	// debug.showInStatusBar / debug.enableStatusBarColor
	const debugItem = $derived(debug.active || statusItemShown(settings.get<string>('debug.showInStatusBar'), debug.sessionsStarted));
	const debugColored = $derived(debug.active && settings.get<boolean>('debug.enableStatusBarColor'));
	// problems.visibility (off: a warning item opens the setting) / problems.showCurrentInStatus
	const problemsHidden = $derived(settings.get<boolean>('problems.visibility') === false);
	const currentProblem = $derived.by(() => {
		if (!settings.get<boolean>('problems.showCurrentInStatus') || problemsHidden || !editors.active) return null;
		const file = lsp.problems.find((f) => f.rel === editors.active);
		return file ? problemAt(file.items, { line: editors.cursor.line - 1, character: editors.cursor.column - 1 }) : null;
	});

	// One status bar for the IDE and the Agents layout: the branch of what you are looking at (the
	// selected worktree in Agents), problems, agent activity and cost in both; editor items in the IDE.
	const branch = $derived(appMode.isAgents && adeLayout.key ? adeTasks.branchOf(adeLayout.key) : status.branch);
	const sync = $derived(syncItem(scm.repo));
	const counts = $derived(adeTasks.counts);
	const cost = $derived(adeTasks.views.reduce((sum, v) => sum + (runtime.run(v.meta.slug)?.result?.total_cost_usd ?? v.meta.last_run?.cost_usd ?? 0), 0));
	const editorItems = $derived(!appMode.isAgents && editors.active);
	const ITEM = 'flex h-full items-center gap-1 px-2 hover:bg-(--vscode-toolbar-hoverBackground)';

	// Right-click: which resource items show (Orca's status bar context menu).
	const TOGGLES = [
		{ id: 'kingu.statusBar.usage.visible', label: 'Usage' },
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
	class={[
		'flex h-(--kg-statusbar-height) shrink-0 items-center border-t border-(--vscode-statusBar-border) text-xs leading-(--kg-statusbar-height)',
		debugColored
			? 'bg-(--vscode-statusBar-debuggingBackground,#cc6633) text-(--vscode-statusBar-debuggingForeground,#ffffff)'
			: 'bg-(--vscode-statusBar-background) text-(--vscode-statusBar-foreground)'
	]}
>
	{#if appMode.isAgents && adeLayout.key}
		<span class="flex h-full items-center gap-1 px-2" title="branch ของ worktree ที่เลือก"><Icon name="branch" size={14} />{branch}</span>
	{:else if branch}
		<!-- VS Code's branch item (Checkout to…) and sync item next to it. -->
		<button class={ITEM} title={`branch ปัจจุบัน${scm.repo?.detached ? ' (detached HEAD)' : ''}: คลิกเพื่อ Checkout to...`} onclick={() => commands.run('git.checkout')}>
			<Icon name="branch" size={14} />{branch}
		</button>
		<!-- git.showProgress: the running operation (cancellable); git.enableStatusBarSync: the sync item. -->
		{#if scm.op && settings.get<boolean>('git.showProgress')}
			<button class={ITEM} title="คลิกเพื่อยกเลิก" onclick={() => scm.cancel()}>
				<span class="inline-block size-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent"></span>{scm.op}
			</button>
		{:else if sync && !scm.op && settings.get<boolean>('git.enableStatusBarSync')}
			<button class={ITEM} title={sync.title} onclick={() => commands.run(sync.command)}>
				<Icon name={sync.command === 'git.publish' ? 'send' : 'refresh'} size={14} />{sync.label}
			</button>
		{/if}
	{/if}
	<button class={ITEM} onclick={() => (appMode.setMode('workbench'), layout.showPanel('problems'))}>
		<Icon name="error" size={14} />{lsp.counts.errors} <Icon name="warning" size={14} />{lsp.counts.warnings}
	</button>
	{#if problemsHidden}
		<button class={ITEM} title="Problems are turned off. Click to open settings." aria-label="Problems are turned off" onclick={() => systemSettings.show('Problems')}>
			<Icon name="ignored" size={14} />
		</button>
	{/if}
	{#if currentProblem}
		{@const sev = severityName(currentProblem.severity)}
		<button class={[ITEM, 'max-w-96 min-w-0']} title={currentProblem.message} onclick={() => (appMode.setMode('workbench'), layout.showPanel('problems'))}>
			<Icon name={sev === 'error' ? 'error' : sev === 'warning' ? 'warning' : 'info'} size={14} /><span class="truncate">{currentProblem.message.split('\n')[0]}</span>
		</button>
	{/if}
	{#if lsp.progress && lsp.progress !== languageStatus?.text}
		<button class="flex h-full min-w-0 items-center gap-1 truncate px-2 hover:bg-(--vscode-toolbar-hoverBackground)" title={lsp.progress} onclick={() => layout.showPanel('output')}>
			<span class="inline-block size-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent"></span>
			<span class="truncate">{lsp.progress}</span>
		</button>
	{/if}
	{#if debugItem}
		<!-- VS Code's debug status item: the running (or last) configuration; opens Run and Debug, or starts debugging when idle. -->
		<button
			class={ITEM}
			title={debug.active ? 'Run and Debug' : 'Start Debugging'}
			onclick={() => (debug.active ? (appMode.setMode('workbench'), (layout.sideView = 'debug'), (layout.sidebarVisible = true)) : void commands.run('workbench.action.debug.start'))}
		>
			<Icon name="bug" size={14} />{debug.active ? `${debug.configName}: ${debug.label}` : debug.configName || 'Run and Debug'}
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
	<UsageStatus />
	{#if cost > 0}<span class="px-2 tabular-nums" title="ค่าใช้จ่าย agent ในโฟลเดอร์นี้">${cost.toFixed(2)}</span>{/if}
	{#if status.message}<span class="truncate px-2">{status.message}</span>{/if}
	<div class="flex-1"></div>
	<TeamStatus />
	<StatusResources />
	{#if editorItems && languageStatus}
		<button
			class={['h-full max-w-80 truncate px-2 hover:bg-(--vscode-toolbar-hoverBackground)', languageStatus.state === 'not-installed' || languageStatus.state === 'error' ? 'text-(--vscode-editorWarning-foreground)' : '']}
			title={languageStatus.tooltip}
			onclick={() => (languageStatus.state === 'not-installed' ? lsp.install(editors.language) : layout.showPanel('output'))}>{languageStatus.text}</button
		>
	{/if}
	{#if editorItems}
		<button class="h-full px-2 hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => quick.show(':')}>Ln {editors.cursor.line}, Col {editors.cursor.column}</button>
		<!-- VS Code's editor status items: each opens its picker (editorStatus.ts). -->
		<button class={ITEM} title="Select Indentation" onclick={() => commands.run('changeEditorIndentation')}>{editors.indent}</button>
		{#if textFiles.encodings.has(editors.focusedFile ?? '')}
			<button class={ITEM} title="Select Encoding" onclick={() => commands.run('workbench.action.editor.changeEncoding')}>{textFiles.encodingOf(editors.focusedFile)}</button>
		{/if}
		<button class={ITEM} title="Select End of Line Sequence" onclick={() => commands.run('workbench.action.editor.changeEOL')}>{editors.eol}</button>
		<button class={ITEM} title="Select Language Mode" onclick={() => commands.run('workbench.action.editor.changeLanguageMode')}>{languageName(editors.language)}</button>
	{/if}
	<!-- VS Code's notifications bell, always the right-most item. -->
	<button
		class={ITEM}
		aria-label={notifications.doNotDisturb ? 'Notifications (Do Not Disturb)' : notifications.unread ? `Notifications: ${notifications.unread} new` : 'Notifications'}
		title={notifications.doNotDisturb ? 'Do Not Disturb' : notifications.unread ? `${notifications.unread} New Notifications` : 'No Notifications'}
		onclick={() => notifications.toggleCenter()}
	>
		<Icon name={notifications.doNotDisturb ? 'bellSlash' : notifications.unread ? 'bellDot' : 'bell'} size={14} />
	</button>
</footer>

{#if menu}
	<PopupMenu items={menuItems} label="Status Bar" x={menu.x} y={menu.y} onRun={(node) => node.type === 'item' && toggleItem(node.id)} onClose={() => (menu = null)} />
{/if}
