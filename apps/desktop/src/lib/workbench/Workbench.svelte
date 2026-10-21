<script lang="ts">
	// The workbench grid (VS Code layout.ts): VERTICAL [ titlebar | body | statusbar ], the body one
	// CSS grid of activity bar, side bar, editor, panel and secondary side bar arranged by
	// workbench.sideBar.location / workbench.panel.defaultLocation / workbench.panel.alignment
	// (workbenchGrid.ts). Agents mode swaps the title bar and shows the Agents layout instead of the
	// body and status bar, which stay mounted (hidden) so editors and terminals keep their state.
	import { onMount, untrack } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { message } from '#lib/workbench/messageBox.ts';
	import AgentPanel from '#lib/agent/AgentPanel.svelte';
	import { installChatExtras } from '#lib/agent/chatExtras.svelte.ts';
	import ActivityBar from './ActivityBar.svelte';
	import Icon from './Icon.svelte';
	import CleanupDialog from '#lib/ade/CleanupDialog.svelte';
	import { cleanup } from '#lib/ade/cleanup.svelte.ts';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import Tooltips from './Tooltips.svelte';
	import FloatingTerminal from './FloatingTerminal.svelte';
	import Welcome from './Welcome.svelte';
	import { welcome } from './welcomeTour.svelte';
	import { floating } from './floating.svelte';
	import { installSignals } from './signals.svelte';
	import { installAccessibilitySignals } from './accessibilitySignals.svelte';
	import { platform } from './platform.svelte';
	import { PROFILES, type Platform } from './platform';
	import { registerMarkdownPreviewCommands } from '#lib/markdown/previewCommands.svelte.ts';
	import EditorPart from './EditorPart.svelte';
	import Panel from './Panel.svelte';
	import QuickInput from './QuickInput.svelte';
	import RepoDialog from './RepoDialog.svelte';
	import { repoDialog } from './repoDialog.svelte.ts';
	import Sash from './Sash.svelte';
	import SideBar from './SideBar.svelte';
	import StatusBar from './StatusBar.svelte';
	import TitleBar from './TitleBar.svelte';
	import { commands, installKeybindings } from './commands.svelte';
	import { editors } from './editors.svelte';
	import { explorer } from './explorer.svelte';
	import { layout, PANEL_MIN, SIDEBAR_MIN } from './layout.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { quick } from './quick.svelte';
	import { installScm } from './scm.svelte';
	import { installScmEditor } from '#lib/scm/scmEditor.svelte.ts';
	import { installTimeline } from '#lib/scm/timeline.svelte.ts';
	import { search } from './search.svelte';
	import { status } from './status.svelte';
	import { workspace } from './workspace.svelte';
	import { installSettings } from '#lib/settings/apply.svelte.ts';
	import { installWorkbenchAppearance } from './workbenchAppearance.svelte';
	import { registerSettingsCommands } from '#lib/settings/contributions.ts';
	import { registerCompareCommands } from './compare.svelte';
	import { installLocalAi } from '#lib/localAi/localAi.svelte.ts';
	import { installAde } from '#lib/ade/tasks.svelte.ts';
	import { isMac } from './keys';
	import { installNativeMenu } from './appMenu.svelte';
	import { navigation } from './navigation.svelte';
	import { appMode } from './mode.svelte';
	import { installLayoutCommands } from './layoutControls.svelte';
	import { gridTemplateAreas, gridTemplateColumns, gridTemplateRows, workbenchGrid, type PanelAlignment, type PanelLocation, type SideBarLocation } from './workbenchGrid';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import AgentsLayout from '#lib/ade/AgentsLayout.svelte';
	import AdeDialogs from '#lib/ade/AdeDialogs.svelte';
	import { adeLayout } from '#lib/ade/adeLayout.svelte.ts';
	import { quickOpenWorktree } from '#lib/ade/quickOpen.svelte.ts';
	import { installTerminalSessions } from './terminalSessions.svelte';
	import { installCodexSharedServerWarning } from '#lib/ade/codexSharedServer.ts';
	import { installTerminalCommands, panelTerminalFocus } from '#lib/terminal/terminalCommands.svelte.ts';
	import { installTaskCommands } from '#lib/tasks/taskCommands.svelte.ts';
	import { adeInFront, installAdeCommands } from '#lib/ade/adeCommands.svelte.ts';
	import { installHunkCommands } from '#lib/ade/hunkReview.svelte.ts';
	import { installChatEditorCommands } from '#lib/agent/chatEditDecorations.svelte.ts';
	import { accounts } from '#lib/accounts/accounts.svelte.ts';
	import SettingsPage from '#lib/settings/SettingsPage.svelte';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { installAgentsMode } from '#lib/ade/agentsMode.svelte.ts';
	import { installWorktreeCommands } from '#lib/ade/worktreeMenu.svelte.ts';
	import { installAttempts } from '#lib/ade/attempts.svelte.ts';
	import { installAgentNotifications } from '#lib/ade/agentNotify.svelte.ts';
	import { installAdeAttention } from '#lib/ade/adeAttention.svelte.ts';
	import { installAutomations } from '#lib/ade/automations.svelte.ts';
	import { installIssues } from '#lib/ade/issues.svelte.ts';
	import { installLinear } from '#lib/ade/linear.svelte.ts';
	import { installCliBridge } from '#lib/ade/cliBridge.svelte.ts';
	import WorkspaceTrustBanner from './WorkspaceTrustBanner.svelte';
	import { workspaceTrust } from './workspaceTrust.svelte';
	import { trustedDomains } from './trustedDomains.svelte';
	import { installVoice } from '#lib/voice/dictation.svelte.ts';
	import DictationIndicator from '#lib/voice/DictationIndicator.svelte';
	import LinearConnect from '#lib/ade/LinearConnect.svelte';
	import { installTaskSources } from '#lib/ade/taskSources.svelte.ts';
	import TrackerConnect from '#lib/ade/TrackerConnect.svelte';
	import { installSnaps } from '#lib/snaps/snaps.svelte.ts';
	import { installMcp } from '#lib/mcp/mcp.svelte.ts';
	import { installSkills } from '#lib/skills/skills.svelte.ts';
	import { installVault } from '#lib/vault/vault.svelte.ts';
	import { installArtifacts } from '#lib/artifacts/artifacts.svelte.ts';
	import { installDebug } from '#lib/debug/debug.svelte.ts';
	import { installTesting } from '#lib/testing/testing.svelte.ts';
	import DebugToolbar from '#lib/debug/DebugToolbar.svelte';
	import { installBreadcrumbs } from './breadcrumbsCommands.svelte';
	import { installLanguageCommands } from './languageCommands.svelte';
	import { installTypeScriptCommands } from '#lib/lsp/typescriptCommands.svelte.ts';
	import { installImageZoomCommands } from './imageZoom.svelte';
	import { installProblemsSettings } from '#lib/lsp/problemsCommands.svelte.ts';
	import { installRefactorPreviewCommands } from '#lib/lsp/refactorPreview.svelte.ts';
	import { installCloseGuard, quit } from './closeGuard.svelte';
	import { installEditorRestore } from './editorRestore.svelte';
	import { installWorkspaceStorage } from './workspaceStorage.svelte';
	import { textFiles } from './textFileService.svelte';
	import { registerEditorStatusCommands } from './editorStatusActions.svelte';
	import { installEditorCommands } from './editorCommands.svelte';
	import { installEditorFeatures } from '#lib/editor/editorFeatures.svelte.ts';
	import { installNotificationCommands } from './notificationCommands.svelte';
	import { installSearchEditorCommands } from './searchEditorCommands.svelte.ts';
	import NotificationToasts from './NotificationToasts.svelte';
	import { recentFiles } from './recentFiles.svelte';
	import { profiles } from '#lib/settings/profiles.svelte.ts';

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
	// The folder's name, or the workspace's (`name (Workspace)`, Untitled (Workspace)) for several folders.
	const workspaceName = $derived(workspace.title || workspace.name);

	// VS Code's default macOS keybindings (docs/IDE-DESIGN.md §2). onMount, not $effect:
	// register() reads and writes the registry, which an effect would re-run on forever.
	onMount(() => {
		void workspace.init().then(() => invoke<string | null>('git_branch').then((b) => (status.branch = b)));
		welcome.maybeShow();
		const unregister = [
			installSignals(),
			installAccessibilitySignals(),
			installChatExtras(),
			// Shows another OS's chrome (window controls, fonts) on this machine; real users keep macOS's.
			commands.register({
				id: 'kingu.dev.previewPlatform',
				title: 'Preview Platform UI (Windows → Oceans → actual)',
				category: 'Developer',
				key: 'ctrl+alt+cmd+p',
				run: () => {
					const order: (Platform | null)[] = ['windows', 'oceans', null];
					const next = order[(order.indexOf(platform.preview) + 1) % order.length];
					platform.setPreview(next);
					status.flash(next ? `Preview UI: ${PROFILES[next].label}` : `Preview UI: ปิด (ใช้ ${PROFILES[platform.current].label})`, 4000);
				}
			}),
			commands.register({ id: 'kingu.agents.cleanup', title: 'Clean Up Tasks…', category: 'Agents', when: () => adeTasks.views.length > 0, run: () => (cleanup.open = true) }),
			commands.register({ id: 'kingu.welcome.show', title: 'Welcome: Show Getting Started', category: 'Help', run: () => (welcome.open = true) }),
			commands.register({ id: 'workbench.action.files.openFolder', title: 'Open Folder...', category: 'File', key: 'cmd+o', run: () => workspace.pickFolder() }),
			// Files anywhere on disk (an external editor outside the folder) and `.code-workspace` files.
			commands.register({ id: 'workbench.action.files.openFile', title: 'Open File...', category: 'File', run: () => workspace.openFile() }),
			commands.register({ id: 'workbench.action.openWorkspace', title: 'Open Workspace from File...', category: 'File', run: () => workspace.pickWorkspaceFile() }),
			commands.register({ id: 'workbench.action.saveWorkspaceAs', title: 'Save Workspace As...', category: 'Workspaces', when: () => workspace.root !== null, run: () => workspace.saveWorkspaceAs() }),
			commands.register({ id: 'workbench.action.addRootFolder', title: 'Add Folder to Workspace...', category: 'Workspaces', run: () => workspace.addFolderToWorkspace() }),
			commands.register({
				id: 'workbench.action.removeRootFolder',
				title: 'Remove Folder from Workspace...',
				category: 'Workspaces',
				when: () => workspace.folders.length > 1,
				run: () =>
					quick.pick({
						placeholder: t('workspaces.removeFolderPick'),
						items: workspace.folders.map((f) => ({ id: f.path, label: f.name, description: f.path })),
						onAccept: (item) => void workspace.removeFolder(item.id)
					})
			}),
			// Windows (VS Code: each window has its own workspace).
			commands.register({ id: 'workbench.action.newWindow', title: 'New Window', category: 'File', key: 'cmd+shift+n', run: () => workspace.newWindow() }),
			commands.register({ id: 'workbench.action.closeWindow', title: 'Close Window', category: 'View', key: 'cmd+shift+w', run: () => workspace.closeWindow() }),
			commands.register({ id: 'workbench.action.duplicateWorkspaceInNewWindow', title: 'Duplicate As Workspace in New Window', category: 'Workspaces', when: () => workspace.root !== null, run: () => workspace.duplicateInNewWindow() }),
			commands.register({ id: 'workbench.action.openRecent', title: 'Open Recent...', category: 'File', key: 'ctrl+r',
				// The shell's reverse search keeps ctrl+r inside the terminal (the menu still opens the picker).
				keyWhen: () => !document.activeElement?.closest('.xterm'),
				run: () => workspace.showRecent()
			}),
			commands.register({ id: 'kingu.newProject', title: 'New Project...', category: 'File', run: () => repoDialog.show('create') }),
			commands.register({ id: 'workbench.action.clearRecentFiles', title: 'Clear Recently Opened', category: 'File', run: () => (recentFiles.clear(), workspace.clearRecent()) }),
			commands.register({ id: 'workbench.action.clearEditorHistory', title: 'Clear Editor History', category: 'View', run: () => recentFiles.clear() }),
			// Quick access prefixes (VS Code: ⇧⌘O `@`, ⌘T `#`).
			commands.register({ id: 'workbench.action.gotoSymbol', title: 'Go to Symbol in Editor...', key: 'cmd+shift+o', when: () => !appMode.isAgents && editors.active !== null, run: () => quick.show('@') }),
			commands.register({ id: 'workbench.action.showAllSymbols', title: 'Go to Symbol in Workspace...', key: 'cmd+t', run: () => quick.show('#') }),
			commands.register({ id: 'workbench.action.quickOpenView', title: 'Quick Open View', key: 'ctrl+q', palette: false, run: () => quick.show('view ') }),
			// Go Back / Go Forward (VS Code: ⌃- / ⌃⇧- on macOS, Alt+←/→ elsewhere).
			// Off macOS Alt+←/→ move between split terminals while a panel terminal has focus (VS Code).
			commands.register({ id: 'workbench.action.navigateBack', title: 'Go Back', key: 'alt+left', mac: 'ctrl+-', when: () => navigation.canGoBack, keyWhen: () => isMac || !panelTerminalFocus(), run: () => navigation.back() }),
			commands.register({ id: 'workbench.action.navigateForward', title: 'Go Forward', key: 'alt+right', mac: 'ctrl+shift+-', when: () => navigation.canGoForward, keyWhen: () => isMac || !panelTerminalFocus(), run: () => navigation.forward() }),
			commands.register({ id: 'workbench.action.openView', title: 'Open View...', run: openView }),
			commands.register({ id: 'workbench.action.openGlobalKeybindings', title: 'Open Keyboard Shortcuts', category: 'Preferences', run: showKeybindings }),
			commands.register({ id: 'workbench.action.showAboutDialog', title: 'About', category: 'Help', run: showAbout }),
			commands.register({
				id: 'workbench.action.quit',
				title: 'Quit',
				category: 'File',
				// macOS quits through the app menu's Quit item.
				when: () => !isMac,
				run: quit
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
			// In the Agents layout ⌘P lists the selected worktree's files and opens them in its tabs (Orca).
			commands.register({ id: 'workbench.action.quickOpen', title: 'Go to File...', key: 'cmd+p', run: () => (appMode.isAgents && workspace.root ? quickOpenWorktree(adeLayout.key) : quick.show('')) }),
			// VS Code's Developer: Reload Window; terminals and agent CLIs re-attach (they live in Rust).
			commands.register({ id: 'workbench.action.reloadWindow', title: 'Reload Window', category: 'Developer', run: async () => (await textFiles.beforeShutdown('reload')) && location.reload() }),
			// VS Code's Developer: Open Logs Folder: the folder holding Kingu.log (and its rotated copies).
			commands.register({
				id: 'workbench.action.openLogsFolder',
				title: 'Open Logs Folder',
				category: 'Developer',
				run: () => invoke<string>('open_logs_folder').catch((e) => status.flash(`เปิดโฟลเดอร์ log ไม่ได้: ${e}`, 5000))
			}),
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
				id: 'workbench.action.toggleZenMode',
				title: 'Toggle Zen Mode',
				category: 'View',
				key: 'cmd+k z',
				when: () => !appMode.isAgents,
				run: () => layout.toggleZen()
			}),
			commands.register({
				id: 'kingu.floatingTerminal.toggle',
				title: 'Toggle Floating Terminal',
				category: 'Terminal',
				key: 'cmd+alt+a',
				when: () => floating.enabled,
				run: () => floating.toggle()
			}),
			commands.register({
				id: 'kingu.floatingWorkspace.maximize',
				title: 'Maximize Floating Workspace Panel',
				category: 'Terminal',
				key: 'cmd+alt+shift+a',
				when: () => floating.enabled,
				run: () => (floating.open ? floating.toggleMaximized() : floating.openMaximized())
			}),
			commands.register({ id: 'kingu.floatingWorkspace.minimize', title: 'Minimize Floating Workspace Panel', category: 'Terminal', when: () => floating.open, run: () => floating.hide() }),
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
			commands.register({ id: 'workbench.view.explorer', title: 'Show Explorer', category: 'View', key: 'cmd+shift+e', scope: 'ide', run: () => ((layout.sideView = 'explorer'), (layout.sidebarVisible = true)) }),
			commands.register({ id: 'workbench.action.findInFiles', title: 'Search: Find in Files', key: 'cmd+shift+f', scope: 'ide', run: () => ((layout.sideView = 'search'), (layout.sidebarVisible = true), search.reveal(editors.selectionText(settings.get<boolean>('search.seedWithNearestWord')))) }),
			commands.register({ id: 'workbench.view.scm', title: 'Show Source Control', category: 'View', key: 'ctrl+shift+g', run: () => ((layout.sideView = 'scm'), (layout.sidebarVisible = true)) }),
			commands.register({ id: 'workbench.actions.view.problems', title: 'Focus on Problems View', category: 'View', key: 'cmd+shift+m', run: () => layout.showPanel('problems') }),
			commands.register({
				id: 'workbench.action.closeActiveEditor',
				title: 'Close Editor',
				category: 'View',
				key: 'cmd+w',
				// An empty group closes itself when it is not the only one (VS Code closes the group).
				// In the Agents layout ⌘W closes the active tab, or the focused pane of a split terminal (Orca).
				when: () => adeInFront() || editors.active !== null || editors.groups.length > 1,
				run: () => {
					if (adeInFront()) adeLayout.closeActive();
					else if (!editors.active) editors.removeGroup();
					else if (!editors.keepPinnedOnKeyboardClose()) void textFiles.closeEditors([editors.active]);
				}
			}),
			// Editor groups (VS Code editorCommands.ts / editorActions.ts, macOS keys).
			commands.register({ id: 'workbench.action.splitEditor', title: 'Split Editor', category: 'View', key: 'cmd+\\', keyWhen: () => !panelTerminalFocus(), run: () => editors.split('right') }),
			commands.register({ id: 'workbench.action.splitEditorDown', title: 'Split Editor Down', category: 'View', run: () => editors.split('down') }),
			commands.register({ id: 'workbench.action.focusFirstEditorGroup', title: 'Focus First Editor Group', category: 'View', key: 'cmd+1', run: () => editors.focusGroupAt(0) }),
			commands.register({ id: 'workbench.action.focusSecondEditorGroup', title: 'Focus Second Editor Group', category: 'View', key: 'cmd+2', run: () => editors.focusGroupAt(1) }),
			commands.register({ id: 'workbench.action.focusThirdEditorGroup', title: 'Focus Third Editor Group', category: 'View', key: 'cmd+3', run: () => editors.focusGroupAt(2) }),
			commands.register({
				id: 'workbench.action.closeEditorsInGroup',
				title: 'Close All Editors in Group',
				category: 'View',
				key: 'cmd+k w',
				when: () => editors.tabs.length > 0 || editors.groups.length > 1,
				// One Save / Don't Save / Cancel for every dirty tab, then the rest close (VS Code's Close All).
				run: async () => {
					const group = editors.activeGroupId;
					await textFiles.closeEditors(editors.tabs.map((t) => t.path), group);
					if (!editors.group(group)?.tabs.length) editors.closeAllInGroup(group);
				}
			}),
			commands.register({
				id: 'workbench.action.moveEditorToNextGroup',
				title: 'Move Editor into Next Group',
				category: 'View',
				when: () => editors.active !== null,
				run: () => editors.moveActiveEditorToNextGroup()
			}),
			commands.register({ id: 'workbench.action.keepEditor', title: 'Keep Editor', category: 'View', key: 'cmd+k enter', when: () => editors.active !== null, run: () => editors.active && editors.pin(editors.active) })
		];
		const uninstall = installKeybindings();
		const uninstallMenu = installNativeMenu();
		const uninstallScm = installScm();
		const uninstallScmEditor = installScmEditor();
		const uninstallTimeline = installTimeline();
		const uninstallWatcher = workspace.install();
		// Before the editors and terminals: the layout follows the window's workspace (an empty window has its own).
		const uninstallWorkspaceStorage = installWorkspaceStorage(() => (workspace.ready ? (workspace.stateKey ?? 'empty') : undefined));
		const uninstallSettings = installSettings();
		const uninstallAppearance = installWorkbenchAppearance();
		const unregisterSettings = registerSettingsCommands();
		const unregisterCompare = registerCompareCommands();
		const unregisterMarkdownPreview = registerMarkdownPreviewCommands();
		const uninstallAde = installAde();
		const uninstallAgentsMode = installAgentsMode();
		const uninstallWorktreeCommands = installWorktreeCommands();
		const uninstallAttempts = installAttempts();
		const uninstallAgentNotifications = installAgentNotifications();
		const uninstallAdeAttention = installAdeAttention();
		const uninstallAutomations = installAutomations();
		const uninstallIssues = installIssues();
		const uninstallLinear = installLinear();
		const uninstallTaskSources = installTaskSources();
		const uninstallCliBridge = installCliBridge();
		const uninstallWorkspaceTrust = workspaceTrust.install();
		const uninstallTrustedDomains = trustedDomains.install();
		const uninstallVoice = installVoice();
		const uninstallLayout = installLayoutCommands();
		const uninstallSnaps = installSnaps();
		const uninstallMcp = installMcp();
		const uninstallSkills = installSkills();
		const uninstallVault = installVault();
		const uninstallArtifacts = installArtifacts();
		const uninstallLocalAi = installLocalAi();
		const uninstallTerminalSessions = installTerminalSessions();
		const uninstallCodexWarning = installCodexSharedServerWarning();
		const uninstallTerminalCommands = installTerminalCommands();
		const uninstallTaskCommands = installTaskCommands();
		const uninstallAdeCommands = installAdeCommands();
		const uninstallHunkCommands = installHunkCommands();
		const uninstallChatEditorCommands = installChatEditorCommands();
		const uninstallDebug = installDebug();
		const uninstallTesting = installTesting();
		const uninstallBreadcrumbs = installBreadcrumbs();
		const uninstallLanguageCommands = installLanguageCommands();
		const uninstallTypeScriptCommands = installTypeScriptCommands();
		const uninstallImageZoomCommands = installImageZoomCommands();
		const uninstallProblemsSettings = installProblemsSettings();
		const uninstallRefactorPreview = installRefactorPreviewCommands();
		const uninstallAccounts = accounts.install();
		const uninstallTextFiles = textFiles.install();
		const unregisterEditorStatus = registerEditorStatusCommands();
		const uninstallCloseGuard = installCloseGuard();
		const uninstallEditorRestore = installEditorRestore();
		const uninstallEditorCommands = installEditorCommands();
		const uninstallEditorFeatures = installEditorFeatures();
		const uninstallRecentFiles = recentFiles.install();
		const uninstallNotificationCommands = installNotificationCommands();
		const uninstallProfiles = profiles.install();
		const uninstallSearchEditorCommands = installSearchEditorCommands();
		return () => {
			uninstallProfiles();
			uninstallNotificationCommands();
			uninstallSearchEditorCommands();
			uninstallRecentFiles();
			uninstallEditorCommands();
			uninstallEditorFeatures();
			uninstallEditorRestore();
			uninstallCloseGuard();
			unregisterEditorStatus();
			uninstallTextFiles();
			uninstallAccounts();
			uninstallProblemsSettings();
			uninstallRefactorPreview();
			uninstallBreadcrumbs();
			uninstallLanguageCommands();
			uninstallTypeScriptCommands();
			uninstallImageZoomCommands();
			uninstallDebug();
			uninstallTesting();
			uninstallAdeCommands();
			uninstallHunkCommands();
			uninstallChatEditorCommands();
			uninstallTaskCommands();
			uninstallTerminalCommands();
			uninstallTerminalSessions();
			uninstallCodexWarning();
			uninstallMcp();
			uninstallSkills();
			uninstallSnaps();
			uninstallVault();
			uninstallArtifacts();
			uninstallLocalAi();
			uninstallLayout();
			uninstallAgentsMode();
			uninstallWorktreeCommands();
			uninstallAttempts();
			uninstallIssues();
			uninstallLinear();
			uninstallTaskSources();
			uninstallCliBridge();
			uninstallWorkspaceTrust();
			uninstallTrustedDomains();
			uninstallVoice();
			uninstallAutomations();
			uninstallAgentNotifications();
			uninstallAdeAttention();
			uninstallAde();
			uninstallMenu();
			uninstall();
			uninstallScm();
			uninstallScmEditor();
			uninstallTimeline();
			uninstallWatcher();
			uninstallWorkspaceStorage();
			uninstallAppearance();
			uninstallSettings();
			unregisterSettings();
			unregisterCompare();
			unregisterMarkdownPreview();
			unregister.forEach((u) => u());
		};
	});

	/** View: Open View… (VS Code's `view ` quick access): side bar views and panel tabs. */
	function openView() {
		const views: [string, string, () => void][] = [
			['explorer', 'Explorer', () => layout.showView('explorer')],
			['search', 'Search', () => layout.showView('search')],
			['scm', 'Source Control', () => layout.showView('scm')],
			['debug', 'Run and Debug', () => layout.showView('debug')],
			['agents', 'Agents', () => layout.showView('agents')],
			['problems', 'Problems', () => layout.showPanel('problems')],
			['output', 'Output', () => layout.showPanel('output')],
			['debugConsole', 'Debug Console', () => layout.showPanel('debugConsole')],
			['terminal', 'Terminal', () => layout.showPanel('terminal')]
		];
		quick.pick({
			placeholder: 'เลือกมุมมองที่จะเปิด (Open View)',
			items: views.map(([id, label], i) => ({ id, label, separator: i === 0 ? 'Side Bar' : i === 5 ? 'Panel' : undefined })),
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
		systemSettings.showPage('shortcuts');
	}

	function showAbout() {
		systemSettings.showPage('about');
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
	// Zen Mode hides the activity bar and the status bar unless zenMode.hideActivityBar / hideStatusBar are off.
	const activityBar = $derived(settings.get<string>('workbench.activityBar.location') === 'default' && (!layout.zen || layout.zenParts?.activityBar === true));
	/** +1 when dragging a sash rightward/downward grows the part. */
	const sideSign = $derived(sideBarAt === 'left' ? 1 : -1);
	const panelSign = $derived(panelAt === 'top' || panelAt === 'left' ? 1 : -1);
	// VS Code's modern layout: each part is a softly rounded pane on the title bar's color, 4px apart.
	const FRAME = 'min-h-0 overflow-hidden rounded-[8px] border border-(--vscode-widget-border)';
</script>

<svelte:window onfocus={() => (focused = true)} onblur={() => (focused = false)} />

<div class="flex h-screen flex-col overflow-hidden">
	<!-- One title bar and one status bar for the IDE and the Agents layout. -->
	<TitleBar workspaceName={workspaceName || 'Kingu'} {focused} />
	<DebugToolbar placement="floating" />
	<WorkspaceTrustBanner />

	<div bind:this={middle} class={['workbench-body grid min-h-0 flex-1 bg-(--vscode-titleBar-activeBackground) px-[4px] pb-[4px]', (appMode.isAgents || systemSettings.visible) && 'hidden']}
		style:grid-template-areas={gridTemplateAreas(grid)}
		style:grid-template-columns={gridTemplateColumns(grid)}
		style:grid-template-rows={gridTemplateRows(grid)}
	>
		<div style:grid-area="act" class={['flex min-h-0', !activityBar && 'hidden']}><ActivityBar /></div>

		<div
			style:grid-area="side"
			style:width="{layout.sidebarWidth}px"
			class={[FRAME, !layout.sidebarVisible && 'hidden']}
		>
			<SideBar {workspaceName} />
		</div>
		<div style:grid-area="sashS" class={['flex', !layout.sidebarVisible && 'hidden']}>
			<Sash
				gap
				orientation="vertical"
				onDrag={(d) => (layout.sidebarWidth = clamp(layout.sidebarWidth + sideSign * d, SIDEBAR_MIN, maxSide()))}
				onReset={() => (layout.sidebarWidth = 300)}
			/>
		</div>

		<div style:grid-area="edit" class={[FRAME, 'min-w-0']}><EditorPart /></div>

		<div style:grid-area="sashP" class={['flex', panelBeside ? 'flex-row' : 'flex-col', !layout.panelVisible && 'hidden']}>
			<Sash
				gap
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
			class={[FRAME, 'min-w-0', !layout.panelVisible && 'hidden']}
		>
			<Panel />
		</div>

		<div style:grid-area="sashX" class={['flex', !layout.auxVisible && 'hidden']}>
			<Sash
				gap
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
				FRAME,
				'flex flex-col bg-(--vscode-sideBar-background)',
				!layout.auxVisible && 'hidden'
			]}
		>
			<div class="flex h-(--kg-part-title-height) shrink-0 items-center gap-2 pl-3 text-[11px] font-medium text-(--vscode-sideBarTitle-foreground) uppercase"><Icon name="agent" size={15} />Arkai</div>
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

	<!-- workbench.statusBar.visible (kept mounted so its items keep their state); Zen Mode hides it (zenMode.hideStatusBar). -->
	<div class={['contents', ((layout.zen && layout.zenParts?.statusBar !== true) || !settings.get<boolean>('workbench.statusBar.visible')) && '[&>*]:hidden']}><StatusBar /></div>
	<DictationIndicator />
	<FloatingTerminal />
	{#if welcome.open}<Welcome />{/if}
	{#if cleanup.open}<CleanupDialog />{/if}
	<Tooltips />
	<QuickInput />
	<LinearConnect />
	<TrackerConnect />
	<AdeDialogs />
	<RepoDialog />
	<NotificationToasts />
</div>
