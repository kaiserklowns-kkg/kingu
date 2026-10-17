<script lang="ts">
	// The workbench grid (VS Code layout.ts, panel at the bottom, alignment "center"):
	// VERTICAL [ titlebar | HORIZONTAL [ activitybar | sidebar | VERTICAL [ editor | panel ] | auxiliarybar ] | statusbar ]
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import AgentPanel from '#lib/agent/AgentPanel.svelte';
	import ActivityBar from './ActivityBar.svelte';
	import EditorPart from './EditorPart.svelte';
	import Panel from './Panel.svelte';
	import QuickInput from './QuickInput.svelte';
	import Sash from './Sash.svelte';
	import SideBar from './SideBar.svelte';
	import StatusBar from './StatusBar.svelte';
	import TitleBar from './TitleBar.svelte';
	import { commands, installKeybindings } from './commands.svelte';
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

	let middle: HTMLDivElement | undefined = $state();
	const workspaceName = $derived(workspace.name);

	$effect(() => {
		document.title = workspace.name ? `${workspace.name} — Kingu` : 'Kingu';
	});

	// VS Code's default macOS keybindings (docs/IDE-DESIGN.md §2). onMount, not $effect:
	// register() reads and writes the registry, which an effect would re-run on forever.
	onMount(() => {
		void workspace.init().then(() => invoke<string | null>('git_branch').then((b) => (status.branch = b)));
		const unregister = [
			commands.register({ id: 'workbench.action.files.openFolder', title: 'Open Folder...', category: 'File', key: 'cmd+o', run: () => workspace.pickFolder() }),
			commands.register({ id: 'workbench.action.openRecent', title: 'Open Recent...', category: 'File', key: 'ctrl+r',
				// The shell's reverse search keeps ctrl+r inside the terminal.
				when: () => !document.activeElement?.closest('.xterm'),
				run: () => workspace.showRecent()
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
			commands.register({ id: 'workbench.action.toggleSidebarVisibility', title: 'Toggle Primary Side Bar Visibility', category: 'View', key: 'cmd+b', run: () => (layout.sidebarVisible = !layout.sidebarVisible) }),
			commands.register({ id: 'workbench.action.toggleAuxiliaryBar', title: 'Toggle Agent (Secondary Side Bar)', category: 'View', key: 'cmd+alt+b', run: () => (layout.auxVisible = !layout.auxVisible) }),
			commands.register({ id: 'workbench.action.togglePanel', title: 'Toggle Panel Visibility', category: 'View', key: 'cmd+j', run: () => (layout.panelVisible = !layout.panelVisible) }),
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
		const uninstallScm = installScm();
		const uninstallWatcher = workspace.install();
		const uninstallSettings = installSettings();
		const unregisterSettings = registerSettingsCommands();
		const uninstallAde = installAde();
		return () => {
			uninstallAde();
			uninstall();
			uninstallScm();
			uninstallWatcher();
			uninstallSettings();
			unregisterSettings();
			unregister.forEach((u) => u());
		};
	});

	const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
	const maxSide = () => (middle?.clientWidth ?? 1200) * 0.45;
	const maxPanel = () => (middle?.clientHeight ?? 800) - 100;
</script>

<div class="flex h-screen flex-col overflow-hidden">
	<TitleBar workspaceName={workspaceName || 'Kingu'} />

	<div bind:this={middle} class="flex min-h-0 flex-1">
		<ActivityBar />

		{#if layout.sidebarVisible}
			<div class="shrink-0 border-r border-(--vscode-sideBar-border)" style:width="{layout.sidebarWidth}px">
				<SideBar {workspaceName} />
			</div>
			<Sash
				orientation="vertical"
				onDrag={(d) => (layout.sidebarWidth = clamp(layout.sidebarWidth + d, SIDEBAR_MIN, maxSide()))}
				onReset={() => (layout.sidebarWidth = 300)}
			/>
		{/if}

		<div class="flex min-w-0 flex-1 flex-col">
			<div class="min-h-0 flex-1">
				<EditorPart />
			</div>
			<div class={['flex shrink-0 flex-col', !layout.panelVisible && 'hidden']} style:height="{layout.panelHeight}px">
				<Sash orientation="horizontal" onDrag={(d) => (layout.panelHeight = clamp(layout.panelHeight - d, PANEL_MIN, maxPanel()))} onReset={() => (layout.panelHeight = 260)} />
				<div class="min-h-0 flex-1"><Panel /></div>
			</div>
		</div>

		{#if layout.auxVisible}
			<Sash
				orientation="vertical"
				onDrag={(d) => (layout.auxWidth = clamp(layout.auxWidth - d, SIDEBAR_MIN, maxSide()))}
				onReset={() => (layout.auxWidth = 360)}
			/>
			<aside aria-label="Agent" class="flex shrink-0 flex-col border-l border-(--vscode-sideBar-border) bg-(--vscode-sideBar-background)" style:width="{layout.auxWidth}px">
				<div class="flex h-(--kg-part-title-height) shrink-0 items-center pl-3 text-[11px] text-(--vscode-sideBarTitle-foreground) uppercase">Agent</div>
				<!-- Tasks are worktrees of the open folder: a new folder gets a fresh panel. -->
				<div class="min-h-0 flex-1">
					{#key workspace.root}<AgentPanel />{/key}
				</div>
			</aside>
		{/if}
	</div>

	<StatusBar />
	<QuickInput />
</div>
