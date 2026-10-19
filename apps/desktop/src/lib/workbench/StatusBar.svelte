<script lang="ts">
	import { debug } from '#lib/debug/debug.svelte.ts';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import { lsp } from '#lib/lsp/lsp.svelte.ts';
	import TeamStatus from '#lib/team/TeamStatus.svelte';
	import Icon from './Icon.svelte';
	import { editors } from './editors.svelte';
	import { layout } from './layout.svelte';
	import { quick } from './quick.svelte';
	import { status } from './status.svelte';
	import { appMode } from './mode.svelte';
	import { adeLayout } from '#lib/ade/adeLayout.svelte.ts';
	import { scm } from './scm.svelte';
	import { statusEntries } from './statusEntries.svelte';
	import { commands } from './commands.svelte';
	import { syncItem } from './scmRemote';
	import { textFiles } from './textFileService.svelte';
	import { statusItemShown } from '#lib/debug/debugSettings.ts';
	import { problemAt } from '#lib/lsp/problemsSettings.ts';
	import { severityName } from '#lib/lsp/convert.ts';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import StatusResources from './StatusResources.svelte';
	import NotificationsBell from './NotificationsBell.svelte';
	import UsageStatus from './UsageStatus.svelte';
	import LocalAiStatus from '#lib/localAi/LocalAiStatus.svelte';
	import { usage } from './usage.svelte';
	import { PROVIDER_NAME } from './usage';
	import { tick } from 'svelte';
	import PopupMenu, { menuItem, menuSeparator } from './PopupMenu.svelte';
	import { floating } from './floating.svelte';
	import { gitBlame, openCommitChanges } from '#lib/scm/blame.svelte.ts';
	import FloatingToggle from './FloatingToggle.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { gitQueue } from './gitQueue.svelte';
	import { t } from '#lib/i18n/index.ts';

	$effect(() => gitQueue.install());

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

	// VS Code's entries on the left (branch, sync, problems) and the editor's on the right; Orca's
	// usage, resources and ports in between. Branch and changes follow the selected worktree in Agents.
	const worktree = $derived(appMode.isAgents && adeLayout.key ? adeLayout.key : null);
	const branch = $derived(worktree ? adeTasks.branchOf(worktree) : status.branch);
	const repo = $derived(worktree ? null : scm.repo);
	const dirty = $derived(!!repo && repo.entries.length > 0);
	const sync = $derived(repo ? syncItem(repo) : null);
	const editorItems = $derived(!appMode.isAgents && editors.active);
	const languageName = $derived(editors.languages().find((l) => l.id === editors.language)?.name ?? languageNames[editors.language] ?? editors.language);
	const counts = $derived(lsp.counts);
	const problemsTitle = $derived(
		counts.errors + counts.warnings + counts.infos ? `Errors: ${counts.errors}, Warnings: ${counts.warnings}${counts.infos ? `, Infos: ${counts.infos}` : ''}` : 'No Problems'
	);
	/** VS Code's getSelectionLabel. */
	const position = $derived.by(() => {
		const { line, column } = editors.cursor;
		const { chars, count } = editors.selection;
		if (count > 1) return chars ? `${count} selections (${chars} characters selected)` : `${count} selections`;
		return chars ? `Ln ${line}, Col ${column} (${chars} selected)` : `Ln ${line}, Col ${column}`;
	});
	const ITEM = 'flex h-full items-center gap-1 px-2 hover:bg-(--vscode-toolbar-hoverBackground)';

	function toggleProblems() {
		if (appMode.isAgents) appMode.setMode('workbench');
		else if (layout.panelVisible && layout.panelTab === 'problems') return void (layout.panelVisible = false);
		layout.showPanel('problems');
	}

	// Right-click: every entry with a check to hide it (VS Code's status bar context menu); Orca's
	// items keep their settings, VS Code's are remembered like VS Code does, outside settings.
	// Orca's entries: a usage toggle per installed agent, then Resource Manager and Ports.
	const ORCA_TOGGLES = $derived([
		...usage.active.map((p) => ({ id: `kingu.statusBar.${p}Usage.visible`, label: `${PROVIDER_NAME[p]} Usage` })),
		{ id: 'kingu.statusBar.resources.visible', label: 'Resource Manager' },
		{ id: 'kingu.statusBar.ports.visible', label: 'Ports' }
	]);

	// Orca's density ladder: when the bar runs out of room, usage drops its labels and bars, then
	// shows one value per provider.
	let footer: HTMLElement | undefined = $state();
	let density = $state(0);
	$effect(() => {
		if (!footer) return;
		const el = footer;
		let busy = false;
		const fit = async () => {
			if (busy) return;
			busy = true;
			for (let level = 0; level <= 2; level++) {
				density = level;
				await tick();
				if (el.scrollWidth <= el.clientWidth + 1) break;
			}
			busy = false;
		};
		const ro = new ResizeObserver(() => void fit());
		ro.observe(el);
		return () => ro.disconnect();
	});
	const ENTRIES = [
		{ id: 'status.scm', label: 'Source Control' },
		{ id: 'status.problems', label: 'Problems' },
		{ id: 'status.editor.selection', label: 'Editor Selection' },
		{ id: 'status.editor.indentation', label: 'Editor Indentation' },
		{ id: 'status.editor.encoding', label: 'Editor Encoding' },
		{ id: 'status.editor.eol', label: 'Editor End of Line' },
		{ id: 'status.editor.mode', label: 'Editor Language' },
		{ id: 'status.kingu.localAi', label: 'Local AI' },
		{ id: 'status.notifications', label: 'Notifications' }
	];
	const show = (id: string) => !statusEntries.hidden.has(id);
	let menu = $state<{ x: number; y: number } | null>(null);
	const menuItems = $derived([
		...ENTRIES.map((t) => menuItem(t.id, t.label, { checked: show(t.id) })),
		menuSeparator,
		...ORCA_TOGGLES.map((t) => menuItem(t.id, t.label, { checked: settings.get<boolean>(t.id) !== false })),
		menuSeparator,
		menuItem('floating', floating.open ? 'Minimize Floating Workspace' : 'Show Floating Workspace', { keyLabel: '⌥⌘A', enabled: floating.enabled })
	]);
	const MENU_HEIGHT = $derived(22 * (ENTRIES.length + ORCA_TOGGLES.length + 1) + 2 * 9 + 8);
	function toggleItem(id: string) {
		if (id === 'floating') return floating.toggle();
		if (id.startsWith('status.')) return statusEntries.toggle(id);
		const shown = settings.get<boolean>(id) !== false;
		void settings.set(id, shown ? false : undefined, 'user');
	}
</script>

<!-- 22px, items 22px line-height (VS Code statusbarPart). -->
<footer
	bind:this={footer}
	oncontextmenu={(e) => (e.preventDefault(), (menu = { x: e.clientX, y: Math.max(4, e.clientY - 4 - MENU_HEIGHT) }))}
	class={[
		'flex h-(--kg-statusbar-height) shrink-0 items-center overflow-hidden whitespace-nowrap text-xs leading-(--kg-statusbar-height)',
		// debug.enableStatusBarColor: the bar turns orange while debugging, like VS Code.
		debugColored
			? 'bg-(--vscode-statusBar-debuggingBackground,#cc6633) text-(--vscode-statusBar-debuggingForeground,#ffffff)'
			: 'bg-(--vscode-statusBar-background) text-(--vscode-statusBar-foreground)'
	]}
>
	{#if branch && show('status.scm')}
		{#if repo}
			<!-- VS Code's branch item (Checkout to…) and its sync item; a running git operation can be cancelled. -->
			<button class={ITEM} title="{branch}{dirty ? '*' : ''}{repo.detached ? ' (detached HEAD)' : ''}, Checkout Branch/Tag..." onclick={() => commands.run('git.checkout')}>
				<Icon name="branch" size={14} />{branch}{dirty ? '*' : ''}
			</button>
			<!-- git.showProgress: the running operation; git.enableStatusBarSync: the sync item. -->
			{#if scm.op && settings.get<boolean>('git.showProgress')}
				<button class={ITEM} title="คลิกเพื่อยกเลิก (Cancel)" onclick={() => scm.cancel()}>
					<span class="inline-block size-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent"></span>{scm.op}
				</button>
			{:else if sync && !scm.op && settings.get<boolean>('git.enableStatusBarSync')}
				<button class={ITEM} title={sync.title} onclick={() => commands.run(sync.command)}>
					<Icon name={sync.command === 'git.publish' ? 'publish' : 'sync'} size={14} />{#if sync.label}<span class="tabular-nums">{sync.label}</span>{/if}
				</button>
			{/if}
		{:else}
			<span class="flex h-full items-center gap-1 px-2" title="branch ของ worktree ที่เลือก"><Icon name="branch" size={14} />{branch}</span>
		{/if}
	{/if}
	{#if gitQueue.first}
		<!-- A git operation (IDE or ADE) waits for another one in the same repository (Rust's git_queue). -->
		<span class="flex h-full items-center gap-1 px-2" title={t('workbench.scm.queueWaitingTitle', { running: gitQueue.first.running, count: gitQueue.first.count })}>
			<span class="inline-block size-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent"></span>{t('workbench.scm.queueWaiting', { op: gitQueue.first.op, running: gitQueue.first.running })}
		</span>
	{/if}
	{#if show('status.problems')}
		<button class={ITEM} title={problemsTitle} onclick={toggleProblems}>
			<Icon name="error" size={14} />{counts.errors} <Icon name="warning" size={14} />{counts.warnings}
			{#if counts.infos}<Icon name="info" size={14} />{counts.infos}{/if}
		</button>
	{/if}
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
	<UsageStatus compact={density >= 1} tightest={density >= 2} />
	{#if status.message}<span class="truncate px-2">{status.message}</span>{/if}
	<div class="flex-1"></div>
	<TeamStatus />
	<StatusResources />
	{#if gitBlame.statusEnabled && gitBlame.statusText && editorItems}
		<!-- git.blame.statusBarItem.enabled: the cursor line's commit (VS Code's git.blame item). -->
		<button class={[ITEM, 'max-w-80 min-w-0']} title={gitBlame.statusTitle} onclick={() => gitBlame.statusCommit && openCommitChanges(gitBlame.statusCommit.hash, gitBlame.statusCommit.path)}>
			<Icon name="commit" size={14} /><span class="truncate">{gitBlame.statusText}</span>
		</button>
	{/if}
	{#if editorItems && languageStatus}
		<button
			class={['h-full max-w-80 truncate px-2 hover:bg-(--vscode-toolbar-hoverBackground)', languageStatus.state === 'not-installed' || languageStatus.state === 'error' ? 'text-(--vscode-editorWarning-foreground)' : '']}
			title={languageStatus.tooltip}
			onclick={() => layout.showPanel('output')}>{languageStatus.text}</button
		>
	{/if}
	{#if editorItems}
		{#if show('status.editor.selection')}<button class={ITEM} title="Go to Line/Column" onclick={() => quick.show(':')}>{position}</button>{/if}
		<!-- VS Code's editor status items: each opens its picker command (editorStatus.ts). -->
		{#if show('status.editor.indentation')}<button class={ITEM} title="Select Indentation" onclick={() => commands.run('changeEditorIndentation')}>{editors.indent}</button>{/if}
		{#if show('status.editor.encoding')}<button class={ITEM} title="Select Encoding" onclick={() => commands.run('workbench.action.editor.changeEncoding')}>{textFiles.encodingOf(editors.focusedFile)}</button>{/if}
		{#if show('status.editor.eol')}<button class={ITEM} title="Select End of Line Sequence" onclick={() => commands.run('workbench.action.editor.changeEOL')}>{editors.eol}</button>{/if}
		{#if show('status.editor.mode')}<button class={ITEM} title="Select Language Mode" onclick={() => commands.run('workbench.action.editor.changeLanguageMode')}>{languageName}</button>{/if}
	{/if}
	{#if show('status.kingu.localAi')}<LocalAiStatus />{/if}
	<!-- VS Code keeps the notification bell at the far right. -->
	{#if floating.enabled && floating.location === 'status-bar'}<FloatingToggle variant="status-bar" />{/if}
	{#if show('status.notifications')}<NotificationsBell />{/if}
</footer>

{#if menu}
	<PopupMenu items={menuItems} label="Status Bar" x={menu.x} y={menu.y} onRun={(node) => node.type === 'item' && toggleItem(node.id)} onClose={() => (menu = null)} />
{/if}
