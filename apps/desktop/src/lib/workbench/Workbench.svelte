<script lang="ts">
	// The workbench grid (VS Code layout.ts): VERTICAL [ titlebar | body | statusbar ], the body one
	// CSS grid of activity bar, side bar, editor, panel and secondary side bar arranged by
	// workbench.sideBar.location / workbench.panel.defaultLocation / workbench.panel.alignment
	// (workbenchGrid.ts). Agents mode swaps the title bar and shows the Agents layout instead of the
	// body and status bar, which stay mounted (hidden) so editors and terminals keep their state.
	import { onMount, untrack } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { ask, message } from '@tauri-apps/plugin-dialog';
	import AgentPanel from '#lib/agent/AgentPanel.svelte';
	import ActivityBar from './ActivityBar.svelte';
	import EditorPart from './EditorPart.svelte';
	import Panel from './Panel.svelte';
	import QuickInput from './QuickInput.svelte';
	import Sash from './Sash.svelte';
	import SideBar from './SideBar.svelte';
	import StatusBar from './StatusBar.svelte';
	import TitleBar from './TitleBar.svelte';
	import { commands, installKeybindings, keyOf } from './commands.svelte';
	import { editors } from './editors.svelte';
	import { explorer } from './explorer.svelte';
	import { layout, PANEL_MIN, SIDEBAR_MIN } from './layout.svelte';
	import { quick } from './quick.svelte';
	import { installScm } from './scm.svelte';
	import { search } from './search.svelte';
	import { status } from './status.svelte';
	import { workspace } from './workspace.svelte';
	import { installSettings } from '#lib/settings/apply.svelte.ts';
	import { registerSettingsCommands } from '#lib/settings/contributions.ts';
	import { installAde } from '#lib/ade/tasks.svelte.ts';
	import { isMac, keyLabel } from './keys';
	import { installNativeMenu } from './appMenu.svelte';
	import { navigation } from './navigation.svelte';
	import { appMode } from './mode.svelte';
	import { installLayoutCommands } from './layoutControls.svelte';
	import { gridTemplateAreas, gridTemplateColumns, gridTemplateRows, workbenchGrid, type PanelAlignment, type PanelLocation, type SideBarLocation } from './workbenchGrid';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import AgentsLayout from '#lib/ade/AgentsLayout.svelte';
	import SettingsPage from '#lib/settings/SettingsPage.svelte';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { installAgentsMode } from '#lib/ade/agentsMode.svelte.ts';

	// Opening a file or diff (Quick Open, a review file, settings.json) closes the system settings page.
	// `editors.active` also re-runs on focus changes, so only a different editor closes it.
	let lastActive = untrack(() => editors.active);
	$effect(() => {
		const active = editors.active;
		if (active === lastActive) return;
		lastActive = active;
		untrack(() => systemSettings.close());
	});


	let middle: HTMLDivElement | undefined = $state();
	const workspaceName = $derived(workspace.name);

	// VS Code's default macOS keybindings (docs/IDE-DESIGN.md §2). onMount, not $effect:
	// register() reads and writes the registry, which an effect would re-run on forever.
	onMount(() => {
		void workspace.init().then(() => invoke<string | null>('git_branch').then((b) => (status.branch = b)));
		const unregister = [
			commands.register({ id: 'workbench.action.files.openFolder', title: 'Open Folder...', category: 'File', key: 'cmd+o', run: () => workspace.pickFolder() }),
			commands.register({ id: 'workbench.action.openRecent', title: 'Open Recent...', category: 'File', key: 'ctrl+r',
				// The shell's reverse search keeps ctrl+r inside the terminal (the menu still opens the picker).
				keyWhen: () => !document.activeElement?.closest('.xterm'),
				run: () => workspace.showRecent()
			}),
			commands.register({ id: 'workbench.action.clearRecentFiles', title: 'Clear Recently Opened', category: 'File', run: () => workspace.clearRecent() }),
			// Go Back / Go Forward (VS Code: ⌃- / ⌃⇧- on macOS, Alt+←/→ elsewhere).
			commands.register({ id: 'workbench.action.navigateBack', title: 'Go Back', key: 'alt+left', mac: 'ctrl+-', when: () => navigation.canGoBack, run: () => navigation.back() }),
			commands.register({ id: 'workbench.action.navigateForward', title: 'Go Forward', key: 'alt+right', mac: 'ctrl+shift+-', when: () => navigation.canGoForward, run: () => navigation.forward() }),
			commands.register({ id: 'workbench.action.openView', title: 'Open View...', run: openView }),
			commands.register({ id: 'workbench.action.openGlobalKeybindings', title: 'Open Keyboard Shortcuts', category: 'Preferences', run: showKeybindings }),
			commands.register({ id: 'workbench.action.showAboutDialog', title: 'About', category: 'Help', run: showAbout }),
			commands.register({
				id: 'workbench.action.quit',
				title: 'Quit',
				category: 'File',
				// macOS quits through the app menu's Quit item.
				when: () => !isMac,
				run: async () => {
					if (editors.hasDirty() && !(await ask(`มี ${editors.dirtyCount()} ไฟล์ที่ยังไม่บันทึก ออกจาก Kingu และทิ้งการแก้ไข?`, { title: 'ยังไม่ได้บันทึก', kind: 'warning', okLabel: 'ออก', cancelLabel: 'ยกเลิก' }))) return;
					await invoke('app_quit');
				}
			}),
			commands.register({ id: 'workbench.action.closeFolder', title: 'Close Folder', category: 'Workspaces', when: () => workspace.root !== null, run: () => workspace.closeFolder() }),
			commands.register({
				id: 'explorer.newFile',
				title: 'New File...',
				category: 'File',
				when: () => workspace.root !== null,
				run: () => ((layout.sideView = 'explorer'), (layout.sidebarVisible = true), explorer.startCreate('file'))
			}),
			commands.register({
				id: 'explorer.newFolder',
				title: 'New Folder...',
				category: 'File',
				when: () => workspace.root !== null,
				run: () => ((layout.sideView = 'explorer'), (layout.sidebarVisible = true), explorer.startCreate('folder'))
			}),
			commands.register({ id: 'workbench.files.action.refreshFilesExplorer', title: 'Refresh Explorer', category: 'File', when: () => workspace.root !== null, run: () => explorer.refresh(['']) }),
			commands.register({ id: 'workbench.files.action.collapseExplorerFolders', title: 'Collapse Folders in Explorer', category: 'File', when: () => workspace.root !== null, run: () => explorer.collapseAll() }),
			commands.register({ id: 'workbench.action.quickOpen', title: 'Go to File...', key: 'cmd+p', run: () => quick.show('') }),
			commands.register({ id: 'workbench.action.showCommands', title: 'Show All Commands', key: 'cmd+shift+p', palette: false, run: () => quick.show('>') }),
			// In Agents mode ⌘B / ⌘J toggle the sessions side bar and the changes panel instead.
			commands.register({
				id: 'workbench.action.toggleSidebarVisibility',
				title: 'Toggle Primary Side Bar Visibility',
				category: 'View',
				key: 'cmd+b',
				run: () => (appMode.isAgents ? (appMode.sessionsVisible = !appMode.sessionsVisible) : (layout.sidebarVisible = !layout.sidebarVisible))
			}),
			commands.register({
				id: 'workbench.action.toggleAuxiliaryBar',
				title: 'Toggle Secondary Side Bar',
				category: 'View',
				key: 'cmd+alt+b',
				run: () => (appMode.isAgents ? (appMode.panelVisible = !appMode.panelVisible) : (layout.auxVisible = !layout.auxVisible))
			}),
			commands.register({
				id: 'workbench.action.togglePanel',
				title: 'Toggle Panel Visibility',
				category: 'View',
				key: 'cmd+j',
				run: () => (appMode.isAgents ? (appMode.panelVisible = !appMode.panelVisible) : (layout.panelVisible = !layout.panelVisible))
			}),
			commands.register({
				id: 'workbench.action.terminal.toggleTerminal',
				title: 'Toggle Terminal',
				category: 'View',
				key: 'ctrl+`',
				run: () => {
					if (layout.panelVisible && layout.panelTab === 'terminal') layout.panelVisible = false;
					else layout.showPanel('terminal');
				}
			}),
			commands.register({ id: 'workbench.view.explorer', title: 'Show Explorer', category: 'View', key: 'cmd+shift+e', run: () => ((layout.sideView = 'explorer'), (layout.sidebarVisible = true)) }),
			commands.register({ id: 'workbench.action.findInFiles', title: 'Search: Find in Files', key: 'cmd+shift+f', run: () => ((layout.sideView = 'search'), (layout.sidebarVisible = true), search.reveal(editors.selectionText())) }),
			commands.register({ id: 'workbench.view.scm', title: 'Show Source Control', category: 'View', key: 'ctrl+shift+g', run: () => ((layout.sideView = 'scm'), (layout.sidebarVisible = true)) }),
			commands.register({ id: 'workbench.actions.view.problems', title: 'Focus on Problems View', category: 'View', key: 'cmd+shift+m', run: () => layout.showPanel('problems') }),
			commands.register({
				id: 'workbench.action.closeActiveEditor',
				title: 'Close Editor',
				category: 'View',
				key: 'cmd+w',
				// An empty group closes itself when it is not the only one (VS Code closes the group).
				when: () => editors.active !== null || editors.groups.length > 1,
				run: () => {
					if (!editors.active) editors.removeGroup();
					else if (!editors.close(editors.active)) status.flash('มีการแก้ไขที่ยังไม่บันทึก: กด ⌘S ก่อนปิด');
				}
			}),
			// Editor groups (VS Code editorCommands.ts / editorActions.ts, macOS keys).
			commands.register({ id: 'workbench.action.splitEditor', title: 'Split Editor', category: 'View', key: 'cmd+\\', run: () => editors.split('right') }),
			commands.register({ id: 'workbench.action.splitEditorDown', title: 'Split Editor Down', category: 'View', run: () => editors.split('down') }),
			commands.register({ id: 'workbench.action.focusFirstEditorGroup', title: 'Focus First Editor Group', category: 'View', key: 'cmd+1', run: () => editors.focusGroupAt(0) }),
			commands.register({ id: 'workbench.action.focusSecondEditorGroup', title: 'Focus Second Editor Group', category: 'View', key: 'cmd+2', run: () => editors.focusGroupAt(1) }),
			commands.register({ id: 'workbench.action.focusThirdEditorGroup', title: 'Focus Third Editor Group', category: 'View', key: 'cmd+3', run: () => editors.focusGroupAt(2) }),
			commands.register({
				id: 'workbench.action.closeEditorsInGroup',
				title: 'Close All Editors in Group',
				category: 'View',
				when: () => editors.tabs.length > 0 || editors.groups.length > 1,
				run: () => {
					if (editors.closeAllInGroup().length) status.flash('มีการแก้ไขที่ยังไม่บันทึก: บันทึกก่อนปิดแท็บที่เหลือ');
				}
			}),
			commands.register({
				id: 'workbench.action.moveEditorToNextGroup',
				title: 'Move Editor into Next Group',
				category: 'View',
				when: () => editors.active !== null,
				run: () => editors.moveActiveEditorToNextGroup()
			}),
			commands.register({ id: 'workbench.action.keepEditor', title: 'Keep Editor', category: 'View', when: () => editors.active !== null, run: () => editors.active && editors.pin(editors.active) })
		];
		const uninstall = installKeybindings();
		const uninstallMenu = installNativeMenu();
		const uninstallScm = installScm();
		const uninstallWatcher = workspace.install();
		const uninstallSettings = installSettings();
		const unregisterSettings = registerSettingsCommands();
		const uninstallAde = installAde();
		const uninstallAgentsMode = installAgentsMode();
		const uninstallLayout = installLayoutCommands();
		return () => {
			uninstallLayout();
			uninstallAgentsMode();
			uninstallAde();
			uninstallMenu();
			uninstall();
			uninstallScm();
			uninstallWatcher();
			uninstallSettings();
			unregisterSettings();
			unregister.forEach((u) => u());
		};
	});

	/** View: Open View… (VS Code's `view ` quick access): side bar views and panel tabs. */
	function openView() {
		const views: [string, string, () => void][] = [
			['explorer', 'Explorer', () => layout.showView('explorer')],
			['search', 'Search', () => layout.showView('search')],
			['scm', 'Source Control', () => layout.showView('scm')],
			['agents', 'Agents', () => layout.showView('agents')],
			['problems', 'Problems', () => layout.showPanel('problems')],
			['output', 'Output', () => layout.showPanel('output')],
			['terminal', 'Terminal', () => layout.showPanel('terminal')]
		];
		quick.pick({
			placeholder: 'เลือกมุมมองที่จะเปิด (Open View)',
			items: views.map(([id, label], i) => ({ id, label, separator: i === 0 ? 'Side Bar' : i === 4 ? 'Panel' : undefined })),
			onAccept: (item) => {
				const view = views.find(([id]) => id === item.id);
				if (!view) return;
				// showView toggles the side bar off for the visible view; Open View always shows it.
				if (item.id !== layout.sideView || !layout.sidebarVisible) view[2]();
			}
		});
	}

	/** Help: Keyboard Shortcuts — a read-only list of commands and their keys (runs the picked one). */
	function showKeybindings() {
		const withKeys = commands.all.filter((c) => keyOf(c)).sort((a, b) => a.title.localeCompare(b.title));
		quick.pick({
			placeholder: 'คีย์ลัด (Keyboard Shortcuts)',
			items: withKeys.map((c) => ({ id: c.id, label: `${c.category ? `${c.category}: ` : ''}${c.title}`, description: `${keyLabel(keyOf(c)!)}  ·  ${c.id}` })),
			onAccept: (item) => void commands.run(item.id)
		});
	}

	async function showAbout() {
		const info = await invoke<{ name: string; version: string; os: string; arch: string }>('app_info').catch(() => null);
		await message(info ? `${info.name} ${info.version}
${info.os} ${info.arch}` : 'Kingu', { title: 'About Kingu', kind: 'info' });
	}

	const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
	const maxSide = () => (middle?.clientWidth ?? 1200) * 0.45;
	const maxPanel = () => (middle?.clientHeight ?? 800) - 100;

	// Inactive window: the title bar dims (VS Code titleBar.inactive* colors, children at 60%).
	let focused = $state(typeof document === 'undefined' || document.hasFocus());

	const sideBarAt = $derived(settings.get<SideBarLocation>('workbench.sideBar.location'));
	const panelAt = $derived(settings.get<PanelLocation>('workbench.panel.defaultLocation'));
	const grid = $derived(workbenchGrid({ sideBar: sideBarAt, panel: panelAt, alignment: settings.get<PanelAlignment>('workbench.panel.alignment') }));
	const panelBeside = $derived(panelAt === 'left' || panelAt === 'right');
	const activityBar = $derived(settings.get<string>('workbench.activityBar.location') === 'default');
	/** +1 when dragging a sash rightward/downward grows the part. */
	const sideSign = $derived(sideBarAt === 'left' ? 1 : -1);
	const panelSign = $derived(panelAt === 'top' || panelAt === 'left' ? 1 : -1);
</script>

<svelte:window onfocus={() => (focused = true)} onblur={() => (focused = false)} />

<div class="flex h-screen flex-col overflow-hidden">
	<!-- One title bar and one status bar for the IDE and the Agents layout. -->
	<TitleBar workspaceName={workspaceName || 'Kingu'} {focused} />

	<div bind:this={middle} class={['workbench-body grid min-h-0 flex-1', (appMode.isAgents || systemSettings.visible) && 'hidden']}
		style:grid-template-areas={gridTemplateAreas(grid)}
		style:grid-template-columns={gridTemplateColumns(grid)}
		style:grid-template-rows={gridTemplateRows(grid)}
	>
		<div style:grid-area="act" class={['flex min-h-0', !activityBar && 'hidden']}><ActivityBar /></div>

		<div
			style:grid-area="side"
			style:width="{layout.sidebarWidth}px"
			class={['min-h-0 border-(--vscode-sideBar-border)', sideBarAt === 'left' ? 'border-r' : 'border-l', !layout.sidebarVisible && 'hidden']}
		>
			<SideBar {workspaceName} />
		</div>
		<div style:grid-area="sashS" class={['flex', !layout.sidebarVisible && 'hidden']}>
			<Sash
				orientation="vertical"
				onDrag={(d) => (layout.sidebarWidth = clamp(layout.sidebarWidth + sideSign * d, SIDEBAR_MIN, maxSide()))}
				onReset={() => (layout.sidebarWidth = 300)}
			/>
		</div>

		<div style:grid-area="edit" class="min-h-0 min-w-0"><EditorPart /></div>

		<div style:grid-area="sashP" class={['flex', panelBeside ? 'flex-row' : 'flex-col', !layout.panelVisible && 'hidden']}>
			<Sash
				orientation={panelBeside ? 'vertical' : 'horizontal'}
				onDrag={(d) =>
					panelBeside
						? (layout.panelWidth = clamp(layout.panelWidth + panelSign * d, SIDEBAR_MIN, maxSide()))
						: (layout.panelHeight = clamp(layout.panelHeight + panelSign * d, PANEL_MIN, maxPanel()))}
				onReset={() => (panelBeside ? (layout.panelWidth = 400) : (layout.panelHeight = 260))}
			/>
		</div>
		<div
			style:grid-area="panel"
			style:height={panelBeside ? undefined : `${layout.panelHeight}px`}
			style:width={panelBeside ? `${layout.panelWidth}px` : undefined}
			class={['min-h-0 min-w-0 overflow-hidden', !layout.panelVisible && 'hidden']}
		>
			<Panel />
		</div>

		<div style:grid-area="sashX" class={['flex', !layout.auxVisible && 'hidden']}>
			<Sash
				orientation="vertical"
				onDrag={(d) => (layout.auxWidth = clamp(layout.auxWidth - sideSign * d, SIDEBAR_MIN, maxSide()))}
				onReset={() => (layout.auxWidth = 360)}
			/>
		</div>
		<aside
			aria-label="Agent"
			style:grid-area="aux"
			style:width="{layout.auxWidth}px"
			class={[
				'flex min-h-0 flex-col border-(--vscode-sideBar-border) bg-(--vscode-sideBar-background)',
				sideBarAt === 'left' ? 'border-l' : 'border-r',
				!layout.auxVisible && 'hidden'
			]}
		>
			<div class="flex h-(--kg-part-title-height) shrink-0 items-center pl-3 text-[11px] text-(--vscode-sideBarTitle-foreground) uppercase">Agent</div>
			<!-- Tasks are worktrees of the open folder: a new folder gets a fresh panel. -->
			<div class="min-h-0 flex-1">
				{#key workspace.root}<AgentPanel />{/key}
			</div>
		</aside>
	</div>

	<!-- Kept mounted (hidden in the IDE) so the ADE's worktree terminals keep running. -->
	<div class={['contents', (!appMode.isAgents || systemSettings.visible) && '[&>*]:hidden']}><AgentsLayout /></div>
	<!-- System settings (IDE + ADE) over the content of either mode. -->
	{#if systemSettings.visible}<SettingsPage />{/if}

	<StatusBar />
	<QuickInput />
</div>
