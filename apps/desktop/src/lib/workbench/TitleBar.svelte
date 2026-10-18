<script lang="ts">
	// Workbench (IDE) title bar, VS Code's `window.titleBarStyle: custom` (titlebarPart.ts):
	// 35px (30px without the command center), left 20% / center (fit-content, max 60%) / right 20%.
	// Left: the macOS traffic-light inset, or the Kingu mark and the in-window menu bar.
	// Center: the command center and Open in Agents / Open in Editor next to it (the same
	// title bar serves the IDE and the Agents layout). Right: layout controls, then Accounts and
	// Manage (always here, in both modes). Any non-interactive part drags the window.
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import CommandCenter from './CommandCenter.svelte';
	import Icon, { type IconName } from './Icon.svelte';
	import MenuBar from './MenuBar.svelte';
	import PopupMenu, { menuItem, menuSeparator } from './PopupMenu.svelte';
	import { currentMenubar, runMenuItem, runRole } from './appMenu.svelte';
	import { commands, keyOf } from './commands.svelte';
	import { editorLabel } from './editorLabel';
	import { editors } from './editors.svelte';
	import { isMac, keyLabel } from './keys';
	import WindowControls from './WindowControls.svelte';
	import { platform } from './platform.svelte';
	import { layout } from './layout.svelte';
	import { titleBarToggleChecked } from './layoutControls.svelte';
	import { status } from './status.svelte';
	import { isCustomTitle, renderWindowTitle } from './title';
	import {
		commandCenterLabel,
		layoutControlItems,
		overflowHidden,
		TITLE_BAR_TOGGLES,
		titleBarHeight,
		titleToolbar,
		type LayoutControlItem,
		type LayoutControlType
	} from './titlebar';
	import { workspace } from './workspace.svelte';
	import type { MenuNode } from './menus';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { team } from '#lib/team/team.svelte.ts';
	import { toggleAgentsMode } from '#lib/ade/agentsMode.svelte.ts';
	import { appMode } from './mode.svelte';

	let { workspaceName, focused }: { workspaceName: string; focused: boolean } = $props();

	const key = (command: string) => {
		const cmd = commands.get(command);
		const k = cmd && keyOf(cmd);
		return k ? keyLabel(k) : undefined;
	};
	const hint = (command: string) => (key(command) ? ` (${key(command)})` : '');

	// --- Window title (`window.title`) --------------------------------------------------------
	const active = $derived(editors.active);
	const dirty = $derived(active !== null && editors.tabs.some((t) => t.path === active && t.dirty));
	const template = $derived(settings.get<string>('window.title'));
	const title = $derived.by(() => {
		const isFile = active !== null && !active.includes('://');
		const editor = active ? { short: editorLabel(active), medium: isFile ? active : editorLabel(active), long: isFile && workspace.root ? `${workspace.root}/${active}` : editorLabel(active) } : null;
		return renderWindowTitle(template, {
			editor,
			rootName: workspace.root ? workspaceName : null,
			rootPath: workspace.root,
			dirty,
			branch: status.branch,
			separator: settings.get<string>('window.titleSeparator')
		});
	});

	$effect(() => {
		const t = title;
		document.title = t;
		// The native title (Mission Control, the Dock and the taskbar show it).
		void import('@tauri-apps/api/window')
			.then(({ getCurrentWindow }) => getCurrentWindow().setTitle(t))
			.catch(() => {});
	});

	// --- Parts ---------------------------------------------------------------------------------
	const commandCenter = $derived(settings.get<boolean>('window.commandCenter'));
	const height = $derived(titleBarHeight('workbench', { commandCenter, compactAgents: false }));
	// Quick input and other overlays sit just below the title bar.
	$effect(() => document.documentElement.style.setProperty('--kg-titlebar-height', `${height}px`));
	const menuBarVisibility = $derived(settings.get<'classic' | 'compact' | 'hidden'>('window.menuBarVisibility'));
	const label = $derived(commandCenterLabel({ folderName: workspace.root ? workspaceName : null, title, customTitle: isCustomTitle(template, isMac) }));
	const layoutItems = $derived(layoutControlItems(settings.get<boolean>('workbench.layoutControl.enabled'), settings.get<LayoutControlType>('workbench.layoutControl.type')));
	// Open in Agents sits next to the command center (VS Code's TitleBarAdjacentCenter), not in the right toolbar.
	const openInAgents = $derived(settings.get<boolean>('kingu.titleBar.openInAgents.enabled'));
	const toolbar = $derived(titleToolbar({ openInAgents: false, layout: layoutItems, globalActions: true }));

	// Overflow: items next to the center hide first (VS Code `.overflowing`).
	let right: HTMLDivElement | undefined = $state();
	let rightWidth = $state(400);
	onMount(() => {
		if (!right) return;
		const ro = new ResizeObserver(([e]) => (rightWidth = e.contentRect.width));
		ro.observe(right);
		return () => ro.disconnect();
	});
	const hidden = $derived(overflowHidden(toolbar, rightWidth - 8));
	const shown = (id: string) => toolbar.some((t) => t.id === id) && !hidden.has(id);

	const TOGGLES: Record<Exclude<LayoutControlItem, 'layoutMenu'>, { label: string; icon: IconName; command: string; on: () => boolean }> = {
		toggleSidebar: { label: 'Toggle Primary Side Bar', icon: 'sidebarLeft', command: 'workbench.action.toggleSidebarVisibility', on: () => (appMode.isAgents ? appMode.sessionsVisible : layout.sidebarVisible) },
		togglePanel: { label: 'Toggle Panel', icon: 'panelBottom', command: 'workbench.action.togglePanel', on: () => layout.panelVisible },
		toggleAuxiliaryBar: { label: 'Toggle Secondary Side Bar', icon: 'sidebarRight', command: 'workbench.action.toggleAuxiliaryBar', on: () => (appMode.isAgents ? appMode.panelVisible : layout.auxVisible) }
	};
	// With the side bar on the right, VS Code swaps the side bar icons.
	const sidebarRight = $derived(settings.get<string>('workbench.sideBar.location') === 'right');
	const toggleIcon = (id: Exclude<LayoutControlItem, 'layoutMenu'>): IconName =>
		sidebarRight && id === 'toggleSidebar' ? 'sidebarRight' : sidebarRight && id === 'toggleAuxiliaryBar' ? 'sidebarLeft' : TOGGLES[id].icon;

	const account = $derived.by(() => {
		const s = team.status;
		if (!s) return { label: 'บัญชี: ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์ทีม (kingu.team.serverUrl)', signedIn: false };
		if (!s.signed_in) return { label: `บัญชี: ยังไม่ได้ลงชื่อเข้าใช้ทีม (${s.server})`, signedIn: false };
		return { label: `บัญชี: ลงชื่อเข้าใช้ทีมแล้ว (${s.server})${s.online ? '' : ' — ออฟไลน์'}`, signedIn: true };
	});

	// --- Menus ---------------------------------------------------------------------------------
	type Popup = { kind: 'context' | 'layout' | 'hamburger' | 'manage'; x: number; y: number; keyboard: boolean };
	let popup = $state<Popup | null>(null);

	const popupItems = $derived.by((): MenuNode[] => {
		if (!popup) return [];
		if (popup.kind === 'hamburger') return currentMenubar(false);
		// VS Code's Manage (gear) menu; settings are one system page for the IDE and the ADE.
		if (popup.kind === 'manage')
			return [
				menuItem('workbench.action.showCommands', 'Command Palette...', { keyLabel: key('workbench.action.showCommands') }),
				menuSeparator,
				menuItem('workbench.action.openSettings', 'Settings', { keyLabel: key('workbench.action.openSettings') }),
				menuItem('workbench.action.openSettingsJson', 'Settings (JSON)'),
				menuSeparator,
				menuItem('workbench.action.selectTheme', 'Themes: Color Theme', { keyLabel: key('workbench.action.selectTheme') })
			];
		if (popup.kind === 'layout')
			return [
				menuItem('workbench.action.toggleSidebarVisibility', 'Primary Side Bar', { checked: layout.sidebarVisible, keyLabel: key('workbench.action.toggleSidebarVisibility') }),
				menuItem('workbench.action.toggleAuxiliaryBar', 'Secondary Side Bar', { checked: layout.auxVisible, keyLabel: key('workbench.action.toggleAuxiliaryBar') }),
				menuItem('workbench.action.togglePanel', 'Panel', { checked: layout.panelVisible, keyLabel: key('workbench.action.togglePanel') }),
				menuSeparator,
				menuItem('workbench.action.customizeLayout', 'Customize Layout...')
			];
		return [
			...TITLE_BAR_TOGGLES.map((t) =>
				menuItem(t.command, t.label, { checked: titleBarToggleChecked(t.command), enabled: t.setting !== 'workbench.navigationControl.enabled' || commandCenter })
			),
			menuSeparator,
			menuItem('workbench.action.customizeLayout', 'Customize Layout...')
		];
	});

	function runPopup(node: MenuNode) {
		if (node.type === 'item') {
			if (popup?.kind === 'hamburger' || node.id.startsWith('recent:')) runMenuItem(node.id);
			else void commands.run(node.id);
		} else if (node.type === 'role') void runRole(node.role);
	}

	function openBelow(kind: Popup['kind'], e: MouseEvent, alignRight = false) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		popup = { kind, x: alignRight ? r.right - 248 : r.left, y: r.bottom + 2, keyboard: e.detail === 0 };
	}

	function onContextMenu(e: MouseEvent) {
		if ((e.target as Element).closest('[role="menubar"], [role="menu"], input')) return;
		e.preventDefault();
		popup = { kind: 'context', x: e.clientX, y: e.clientY, keyboard: false };
	}

	/** Clicks on the bar itself (not on its buttons or menus) drag the window and double-click zooms it. */
	const onBarItself = (e: MouseEvent) => !(e.target as Element).closest('button, a, input, [role="menubar"], [role="menu"]');

	// macOS: Tauri's drag region toggles maximize on double-click; the system setting
	// (Zoom / Minimize / Do Nothing) is honoured instead, so the event stops here.
	function onMouseUp(e: MouseEvent) {
		if (!isMac || e.button !== 0 || e.detail !== 2 || !onBarItself(e)) return;
		e.stopPropagation();
		void invoke('window_titlebar_double_click').catch(() => {});
	}

	const ACTION = 'grid size-6 shrink-0 place-items-center rounded-[5px] hover:bg-(--vscode-toolbar-hoverBackground)';
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (double-click zoom is a pointer convenience, like the native title bar) -->
<header
	data-tauri-drag-region="deep"
	onmouseup={onMouseUp}
	oncontextmenu={onContextMenu}
	style:height="{height}px"
	class={[
		// No bottom border: the framed parts below start right under it (VS Code's modern layout).
		'titlebar relative flex shrink-0 items-center select-none',
		focused
			? 'bg-(--vscode-titleBar-activeBackground) text-(--vscode-titleBar-activeForeground)'
			: 'inactive bg-(--vscode-titleBar-inactiveBackground) text-(--vscode-titleBar-inactiveForeground) [&>*]:opacity-60'
	]}
>
	<div class="titlebar-left flex h-full min-w-0 flex-[1_1_20%] items-center overflow-hidden">
		{#if platform.profile.windowControls === 'traffic-lights'}
			<!-- The overlay title bar's traffic lights (macOS draws them; we leave room). -->
			<div class="h-full shrink-0" style:width="{platform.profile.leftInset}px"></div>
		{:else}
			<div class="grid h-full w-[35px] shrink-0 place-items-center text-(--vscode-titleBar-activeForeground)" aria-hidden="true">
				<Icon name="kingu" size={16} />
			</div>
			{#if menuBarVisibility === 'classic'}
				<MenuBar />
			{:else if menuBarVisibility === 'compact'}
				<button class={ACTION} aria-label="Application Menu" title="Application Menu" aria-haspopup="menu" onclick={(e) => openBelow('hamburger', e)}>
					<Icon name="menu" size={16} />
				</button>
			{/if}
		{/if}
	</div>

	{#if commandCenter || openInAgents}
		<div class="titlebar-center mx-2.5 flex h-full max-w-[60%] min-w-0 flex-[0_1_auto] items-center justify-center gap-1.5">
			{#if commandCenter}<CommandCenter {label} folderName={workspace.root ? workspaceName : null} />{/if}
			{#if openInAgents}
				<!-- VS Code's TitleBarAdjacentCenter, right after the command center: Open in Agents in the
				     IDE, Open in Editor in the Agents layout (same place, ⇧⌘A). The label slides out after a 0.2s hover. -->
				{@const toAgents = !appMode.isAgents}
				<button
					class="group flex h-[22px] max-w-[22px] shrink-0 items-center gap-1 overflow-hidden rounded-[5px] px-[3px] text-xs whitespace-nowrap transition-[max-width] delay-0 duration-200 hover:max-w-[200px] hover:bg-(--vscode-toolbar-hoverBackground) hover:delay-200"
					title="{toAgents ? 'Open in Agents' : 'Open in Editor'}{hint('workbench.action.toggleAgentsMode')}"
					aria-label={toAgents ? 'Open in Agents' : 'Open in Editor'}
					onclick={() => toggleAgentsMode()}
				>
					<span class="shrink-0 grayscale group-hover:grayscale-0 group-hover:text-(--vscode-textLink-foreground)"><Icon name={toAgents ? 'agentsLayout' : 'code'} size={16} /></span>
					<span class="pr-1">{toAgents ? 'Open in Agents' : 'Open in Editor'}</span>
				</button>
			{/if}
		</div>
	{/if}

	<div bind:this={right} class="titlebar-right flex h-full min-w-0 flex-[1_1_20%] items-center justify-end gap-1 overflow-hidden pr-1.5" role="toolbar" aria-label="Title actions">
		{#each layoutItems as id (id)}
			<!-- The Agents layout has no bottom panel. -->
			{#if shown(id) && !(appMode.isAgents && (id === 'togglePanel' || id === 'layoutMenu'))}
				{#if id === 'layoutMenu'}
					<button class={ACTION} aria-label="Configure Layout" title="Configure Layout" aria-haspopup="menu" onclick={(e) => openBelow('layout', e, true)}>
						<Icon name="layout" size={16} />
					</button>
				{:else}
					{@const t = TOGGLES[id]}
					<button
						aria-label={t.label}
						aria-pressed={t.on()}
						title="{t.label}{hint(t.command)}"
						class={[ACTION, t.on() ? 'opacity-100' : 'opacity-50']}
						onclick={() => commands.run(t.command)}
					>
						<Icon name={toggleIcon(id)} size={16} filled={t.on()} />
					</button>
				{/if}
			{/if}
		{/each}
		{#if shown('accounts')}
			<button aria-label={account.label} title={account.label} class={[ACTION, 'relative']} onclick={() => team.showMenu()}>
				<Icon name="account" size={16} />
				{#if account.signedIn}
					<span class="absolute right-0.5 bottom-0.5 size-1.5 rounded-full bg-(--vscode-activityBarBadge-background)"></span>
				{/if}
			</button>
		{/if}
		{#if shown('manage')}
			<button aria-label="Manage" title="Manage" aria-haspopup="menu" class={ACTION} onclick={(e) => openBelow('manage', e, true)}>
				<Icon name="settings" size={16} />
			</button>
		{/if}
	</div>
	<WindowControls />
</header>

{#if popup}
	<PopupMenu
		items={popupItems}
		label={popup.kind === 'context' ? 'Title Bar' : popup.kind === 'layout' ? 'Layout' : popup.kind === 'manage' ? 'Manage' : 'Application Menu'}
		x={popup.x}
		y={popup.y}
		focusFirst={popup.keyboard}
		onRun={runPopup}
		onClose={() => (popup = null)}
	/>
{/if}
