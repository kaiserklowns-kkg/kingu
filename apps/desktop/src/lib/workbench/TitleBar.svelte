<script lang="ts">
	// Workbench (IDE) title bar, VS Code's `window.titleBarStyle: custom` (titlebarPart.ts) as kingu-old
	// draws it: 35px (30px without the command center), left 20% / center (fit-content, max 60%,
	// 10px margins) / right 20%, the sides growing alike and never below their content.
	// Left: the macOS traffic-light inset, or the Kingu mark and the in-window menu bar; then the
	// project (Open Recent) and branch (Git: Checkout to...) controls (kingu-old had them inside the
	// search pill; Kingu shows them on their own, and the branch is no longer in the status bar).
	// Center: Back / Forward, the search ("Search ⌘P") with the agents status, the Arkai chat button.
	// Right: Open in Agents / Open in Editor next to the center (VS Code's center-adjacent toolbar;
	// the same title bar serves the IDE and the Agents layout), then the layout controls (Customize
	// Layout..., the side bar, panel and secondary side bar toggles), Accounts and Manage.
	// When the bar narrows the search gives way first (narrower, then an icon), then the toolbar's
	// items next to the center, then the project and branch labels (titleBarFit). Any
	// non-interactive part drags the window.
	import { onMount, tick } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import CommandCenter from './CommandCenter.svelte';
	import Codicon from './Codicon.svelte';
	import Icon from './Icon.svelte';
	import sessionsIconUrl from '#lib/assets/icons/sessions-icon.svg';
	import MenuBar from './MenuBar.svelte';
	import PopupMenu, { menuItem, menuSeparator } from './PopupMenu.svelte';
	import { currentMenubar, runMenuItem, runRole } from './appMenu.svelte';
	import { commands, keyOf } from './commands.svelte';
	import { editorLabel } from './editorLabel';
	import { externalPath, isExternalKey } from './externalFiles';
	import { profiles } from '#lib/settings/profiles.svelte.ts';
	import { editors } from './editors.svelte';
	import { isMac, keyLabel } from './keys';
	import WindowControls from './WindowControls.svelte';
	import { platform } from './platform.svelte';
	import { layout } from './layout.svelte';
	import { titleBarToggleChecked } from './layoutControls.svelte';
	import { status } from './status.svelte';
	import { isCustomTitle, renderWindowTitle } from './title';
	import {
		CENTER_MARGIN,
		layoutControlItems,
		layoutToggleIcon,
		overflowHidden,
		rightSideWidth,
		SEARCH_ICON_WIDTH,
		searchBoxLabel,
		TITLE_BAR_TOGGLES,
		titleBarFit,
		titleBarHeight,
		titleBranch,
		titleToolbar,
		type LayoutControlType,
		type LayoutToggle
	} from './titlebar';
	import { workspace } from './workspace.svelte';
	import { scm } from './scm.svelte';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import { adeLayout } from '#lib/ade/adeLayout.svelte.ts';
	import { bellPlacement, customTitleBarShown, menuBarShown, type MenuBarVisibility } from './workbenchOptions';
	import { notifications } from './notifications.svelte';
	import type { MenuNode } from './menus';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { team } from '#lib/team/team.svelte.ts';
	import { showAccountsMenu } from '#lib/accounts/accounts.svelte.ts';
	import { toggleAgentsMode } from '#lib/ade/agentsMode.svelte.ts';
	import { appMode } from './mode.svelte';
	import { chatProgress } from '#lib/agent/chatSettings.svelte.ts';
	import { t as translate } from '#lib/i18n/index.ts';

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
		// A file outside the folder is shown by its own path (VS Code's medium/long labels of an outside file).
		const outside = active !== null && isExternalKey(active) ? externalPath(active) : null;
		const editor = active
			? outside
				? { short: editorLabel(active), medium: outside, long: outside }
				: { short: editorLabel(active), medium: isFile ? active : editorLabel(active), long: isFile && active.startsWith('/') ? active : isFile && workspace.root ? `${workspace.root}/${active}` : editorLabel(active) }
			: null;
		return renderWindowTitle(template, {
			editor,
			rootName: workspace.root ? workspaceName : null,
			rootPath: workspace.root,
			dirty,
			branch: status.branch,
			languageId: editors.language,
			separator: settings.get<string>('window.titleSeparator'),
			profileName: profiles.name
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
	// window.customTitleBarVisibility `windowed` / `never`: no title bar in full screen.
	const visible = $derived(customTitleBarShown(settings.get<string>('window.customTitleBarVisibility'), layout.fullscreen));
	const height = $derived(visible ? titleBarHeight('workbench', { commandCenter, compactAgents: false }) : 0);
	// Quick input and other overlays sit just below the title bar.
	$effect(() => document.documentElement.style.setProperty('--kg-titlebar-height', `${height}px`));
	// window.menuBarVisibility (Windows and Linux): `classic` hides the menu in full screen, `toggle`
	// shows it while Alt alone toggles it (until focus leaves it), `compact` is one menu button.
	let fullscreen = $state(false);
	let menuToggledOn = $state(false);
	const menuBar = $derived(menuBarShown(settings.get<MenuBarVisibility>('window.menuBarVisibility'), { fullscreen, toggledOn: menuToggledOn }));
	onMount(() => {
		if (isMac) return;
		let off: (() => void) | undefined;
		let gone = false;
		void import('@tauri-apps/api/window')
			.then(async ({ getCurrentWindow }) => {
				const win = getCurrentWindow();
				fullscreen = await win.isFullscreen();
				const un = await win.onResized(async () => (fullscreen = await win.isFullscreen()));
				if (gone) un();
				else off = un;
			})
			.catch(() => {});
		let altAlone = false;
		const down = (e: KeyboardEvent) => (altAlone = e.key === 'Alt' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.shiftKey);
		const up = (e: KeyboardEvent) => {
			if (e.key !== 'Alt' || !altAlone) return;
			altAlone = false;
			if (settings.get('window.menuBarVisibility') !== 'toggle' || menuToggledOn) return;
			menuToggledOn = true;
			// Show it and put focus on the first menu, like VS Code.
			queueMicrotask(() => document.querySelector<HTMLButtonElement>('header.titlebar [role="menubar"] button')?.focus());
		};
		window.addEventListener('keydown', down, true);
		window.addEventListener('keyup', up, true);
		return () => {
			gone = true;
			off?.();
			window.removeEventListener('keydown', down, true);
			window.removeEventListener('keyup', up, true);
		};
	});
	const searchLabel = $derived(searchBoxLabel({ title, customTitle: isCustomTitle(template, isMac) }));
	const layoutItems = $derived(layoutControlItems(settings.get<boolean>('workbench.layoutControl.enabled'), settings.get<LayoutControlType>('workbench.layoutControl.type')));
	// Open in Agents sits right after the center (VS Code's TitleBarAdjacentCenter), before the toolbar.
	const openInAgents = $derived(settings.get<boolean>('kingu.titleBar.openInAgents.enabled'));
	// workbench.notifications.position top-right with showInTitleBar: the bell is a title bar action.
	const bellInTitle = $derived(bellPlacement(settings.get<string>('workbench.notifications.position'), settings.get<boolean>('workbench.notifications.showInTitleBar')) === 'titleBar');
	// The Agents layout has no bottom panel.
	const rightLayoutItems = $derived(appMode.isAgents ? layoutItems.filter((id) => id !== 'togglePanel' && id !== 'layoutMenu' && id !== 'customizeLayout') : layoutItems);
	const toolbar = $derived(titleToolbar({ openInAgents, layout: rightLayoutItems, notifications: bellInTitle, globalActions: true }));
	// window.doubleClickIconToClose: the icon (Windows/Linux) closes the window on a double click instead of dragging it.
	const iconCloses = $derived(settings.get<boolean>('window.doubleClickIconToClose'));
	// Through the close guard, like Close Window.
	const closeWindow = () => void invoke('window_close').catch(() => {});

	// --- Project and branch ------------------------------------------------------------------------
	const projectName = $derived(workspace.root ? workspaceName : null);
	// The Agents layout's selected worktree, else the workbench's active repository (as the status bar's
	// branch item, which this replaces, did).
	const worktree = $derived(appMode.isAgents && adeLayout.key ? adeLayout.key : null);
	const branch = $derived.by(() => {
		if (worktree) return titleBranch({ worktreeBranch: adeTasks.branchOf(worktree) });
		const r = scm.active?.repo;
		if (!projectName) return null;
		if (!r) return titleBranch({ folderBranch: status.branch });
		return titleBranch({
			repo: { branch: r.branch, head: r.head, detached: r.detached, dirty: r.entries.length > 0, name: scm.active?.label.name, multiple: scm.repositories.length > 1 }
		});
	});
	const checkout = () => (scm.active ? void scm.active.checkout() : void commands.run('git.checkout'));

	// --- Fitting (titleBarFit) -------------------------------------------------------------------------
	let container: HTMLDivElement | undefined = $state();
	let leftContent: HTMLDivElement | undefined = $state();
	let context: HTMLDivElement | undefined = $state();
	let barWidth = $state(1140);
	let leftNatural = $state(0);
	let contextNatural = $state(0);
	let centerFixed = $state(0);
	/** A label's own width, up to its 180px cap, even while it is truncated. */
	const LABEL_MAX = 180;
	function measure() {
		if (!container || !leftContent) return;
		barWidth = container.clientWidth;
		let extra = 0;
		for (const l of context?.querySelectorAll<HTMLElement>('[data-label]') ?? []) extra += Math.max(0, Math.min(l.scrollWidth, LABEL_MAX) - l.clientWidth);
		contextNatural = context ? context.offsetWidth + extra : 0;
		leftNatural = leftContent.offsetWidth + extra;
	}
	onMount(() => {
		const ro = new ResizeObserver(() => measure());
		for (const el of [container, leftContent]) if (el) ro.observe(el);
		measure();
		return () => ro.disconnect();
	});
	$effect(() => {
		if (!context) return;
		const ro = new ResizeObserver(() => measure());
		ro.observe(context);
		for (const l of context.querySelectorAll('[data-label]')) ro.observe(l);
		return () => ro.disconnect();
	});
	// A label can change while truncated (no resize): measure again.
	$effect(() => {
		void projectName;
		void branch?.label;
		void tick().then(measure);
	});
	// macOS chrome (also the platform preview's): VS Code moves the toolbar 8px in from the edge.
	const macChrome = $derived(platform.profile.windowControls === 'traffic-lights');
	// Toolbar items hide (from the center outward, VS Code `.overflowing`) only once the search is an icon.
	const hidden = $derived(
		overflowHidden(toolbar, barWidth - Math.max(barWidth * 0.2, leftNatural) - CENTER_MARGIN * 2 - (commandCenter ? centerFixed + SEARCH_ICON_WIDTH : 0) - 4 - (macChrome ? 8 : 0))
	);
	const shownItems = $derived(toolbar.filter((i) => !hidden.has(i.id)));
	const rightNatural = $derived(rightSideWidth(shownItems, macChrome));
	const fit = $derived(titleBarFit({ width: barWidth, leftWidth: leftNatural, rightWidth: rightNatural, contextWidth: contextNatural, centerFixed: commandCenter ? centerFixed : 0 }));
	const leftMin = $derived(fit.contextMaxWidth !== undefined ? leftNatural - (contextNatural - fit.contextMaxWidth) : leftNatural);
	const shown = (id: string) => toolbar.some((t) => t.id === id) && !hidden.has(id);

	const TOGGLES: Record<LayoutToggle, { label: string; command: string; on: () => boolean }> = {
		toggleSidebar: { label: 'Toggle Primary Side Bar', command: 'workbench.action.toggleSidebarVisibility', on: () => (appMode.isAgents ? appMode.sessionsVisible : layout.sidebarVisible) },
		togglePanel: { label: 'Toggle Panel', command: 'workbench.action.togglePanel', on: () => layout.panelVisible },
		toggleAuxiliaryBar: { label: 'Toggle Secondary Side Bar', command: 'workbench.action.toggleAuxiliaryBar', on: () => (appMode.isAgents ? appMode.panelVisible : layout.auxVisible) }
	};
	// With the side bar on the right, VS Code swaps the side bar icons.
	const sidebarRight = $derived(settings.get<string>('workbench.sideBar.location') === 'right');

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
		// VS Code's Manage (gear) menu, in its order, with the commands Kingu has; settings are one
		// system page for the IDE and the ADE.
		if (popup.kind === 'manage')
			return [
				menuItem('workbench.action.showCommands', 'Command Palette...', { keyLabel: key('workbench.action.showCommands') }),
				menuSeparator,
				...manageItem('workbench.profiles.actions.switchProfile', 'Profiles...'),
				menuItem('workbench.action.openSettings', 'Settings', { keyLabel: key('workbench.action.openSettings') }),
				menuItem('workbench.action.openSettingsJson', 'Settings (JSON)'),
				...manageItem('workbench.action.openGlobalKeybindings', 'Keyboard Shortcuts'),
				...manageItem('workbench.action.openSnippets', 'Snippets'),
				...manageItem('workbench.action.tasks.runTask', 'Tasks'),
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

	/** A Manage menu row for a command that is registered (nothing when it is not). */
	const manageItem = (command: string, label: string): MenuNode[] => (commands.get(command) ? [menuItem(command, label, { keyLabel: key(command) })] : []);

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

	// VS Code's title bar action (kingu-old's): 22px, a 16px icon in 3px padding, 6px corners; the
	// toolbar's hover fill, and its active fill while the action's menu is open.
	const ACTION = 'grid size-[22px] shrink-0 place-items-center rounded-[6px] hover:bg-(--vscode-toolbar-hoverBackground) focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)';
	const ACTIVE = 'bg-(--vscode-toolbar-activeBackground) hover:bg-(--vscode-toolbar-activeBackground)';
	// The project and branch controls (kingu-old's `.kingu-title-segment`, out of the pill): a 14px
	// icon, the label (the project's semibold, at most 180px), a 12px chevron at 60%.
	const SEGMENT =
		'flex h-[22px] min-w-0 items-center gap-1 rounded-[6px] px-[5px] text-xs whitespace-nowrap text-(--vscode-commandCenter-foreground) focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)';
	const SEGMENT_HOVER = 'hover:bg-(--vscode-commandCenter-activeBackground) hover:text-(--vscode-commandCenter-activeForeground)';
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (double-click zoom is a pointer convenience, like the native title bar) -->
<header
	data-tauri-drag-region="deep"
	onmouseup={onMouseUp}
	oncontextmenu={onContextMenu}
	style:height="{height}px"
	class={[
		// No bottom border: the framed parts below start right under it (VS Code's modern layout).
		'titlebar relative flex shrink-0 items-center text-[13px] select-none',
		!visible && 'hidden',
		focused
			? 'bg-(--vscode-titleBar-activeBackground) text-(--vscode-titleBar-activeForeground)'
			: 'inactive bg-(--vscode-titleBar-inactiveBackground) text-(--vscode-titleBar-inactiveForeground) [&>*]:opacity-60'
	]}
>
	<div bind:this={container} class="titlebar-container flex h-full min-w-0 flex-1 items-center justify-between overflow-hidden">
		<!-- The sides' 2px top padding puts their 22px items at y=8, as in kingu-old. -->
		<div class="titlebar-left flex h-full w-[20%] grow-[2] items-center overflow-hidden pt-[2px]" style:min-width="{leftMin}px">
			<div bind:this={leftContent} class="flex h-full min-w-0 items-center">
				{#if platform.profile.windowControls === 'traffic-lights'}
					<!-- The overlay title bar's traffic lights (macOS draws them; we leave room). -->
					<div class="h-full shrink-0" style:width="{platform.profile.leftInset}px"></div>
				{:else}
					<!-- svelte-ignore a11y_no_static_element_interactions (a pointer convenience, like a native title bar icon) -->
					<div
						class="grid h-full w-[35px] shrink-0 place-items-center text-(--vscode-titleBar-activeForeground)"
						aria-hidden="true"
						data-tauri-drag-region={iconCloses ? 'false' : undefined}
						ondblclick={() => iconCloses && closeWindow()}
					>
						<Icon name="kingu" size={16} />
					</div>
					{#if menuBar === 'bar'}
						<MenuBar onLeave={() => (menuToggledOn = false)} />
					{:else if menuBar === 'button'}
						<button class={[ACTION, popup?.kind === 'hamburger' && ACTIVE]} aria-label="Application Menu" title="Application Menu" aria-haspopup="menu" onclick={(e) => openBelow('hamburger', e)}>
							<Codicon id="menu" size={16} />
						</button>
					{/if}
				{/if}
				{#if projectName}
					<!-- Where the work is: the project (Open Recent) and its branch (Git: Checkout to...). -->
					<div bind:this={context} class="titlebar-context flex min-w-0 items-center gap-0.5 pl-1" style:max-width={fit.contextMaxWidth !== undefined ? `${fit.contextMaxWidth}px` : undefined}>
						<button class={[SEGMENT, SEGMENT_HOVER]} title="{translate('titleBar.switchProject')}{hint('workbench.action.openRecent')}" aria-label="{translate('titleBar.switchProject')}: {projectName}" onclick={() => commands.run('workbench.action.openRecent')}>
							<Codicon id="folder" size={14} />
							<span data-label class="max-w-[180px] min-w-0 truncate font-semibold">{projectName}</span>
							<Codicon id="chevron-down" size={12} class="opacity-60" />
						</button>
						{#if branch}
							{#if branch.interactive}
								<button class={[SEGMENT, SEGMENT_HOVER]} title={branch.tooltip} aria-label="{translate('titleBar.switchBranch')}: {branch.label}" onclick={checkout}>
									<Codicon id="git-branch" size={14} />
									<span data-label class="max-w-[180px] min-w-0 truncate">{branch.label}</span>
									<Codicon id="chevron-down" size={12} class="opacity-60" />
								</button>
							{:else}
								<span class={SEGMENT} title={branch.tooltip}>
									<Codicon id="git-branch" size={14} />
									<span data-label class="max-w-[180px] min-w-0 truncate">{branch.label}</span>
								</span>
							{/if}
						{/if}
					</div>
				{/if}
			</div>
		</div>

		<div class="titlebar-center mx-2.5 flex h-full w-[60%] max-w-fit min-w-0 items-center justify-center pt-[2px]">
			{#if commandCenter}
				<CommandCenter label={searchLabel} hasFolder={projectName !== null} search={fit.search} searchWidth={fit.searchWidth} bind:fixedWidth={centerFixed} />
			{:else}
				<!-- Without the command center, VS Code shows the window title here. -->
				<div class="window-title truncate text-xs">{title}</div>
			{/if}
		</div>

		<div class="titlebar-right flex h-full w-[20%] grow-[2] items-center justify-end overflow-hidden pt-[2px]" style:min-width="{rightNatural}px">
			{#if shown('openInAgents')}
				<!-- VS Code's center-adjacent toolbar (kingu-old's Open in Agents widget): the Kingu tile in
				     grey, in colour on hover, its label sliding out on hover. Open in Editor in the Agents
				     layout (same place, same key). The tile's url() is quoted: Vite inlines the small SVG as a
				     data: URL with ' in it, which an unquoted url() drops (the tile went blank). -->
				{@const toAgents = !appMode.isAgents}
				<button
					class="group mr-auto flex h-[22px] shrink-0 items-center rounded-[5px] px-1 whitespace-nowrap text-(--vscode-titleBar-activeForeground) hover:bg-(--vscode-toolbar-hoverBackground) focus-visible:bg-(--vscode-toolbar-hoverBackground) focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)"
					title="{toAgents ? 'Open in Agents' : 'Open in Editor'}{hint('workbench.action.toggleAgentsMode')}"
					aria-label={toAgents ? 'Open in Agents' : 'Open in Editor'}
					onclick={() => toggleAgentsMode()}
				>
					{#if toAgents}
						<span
							class="size-4 shrink-0 bg-contain bg-center bg-no-repeat grayscale transition-[filter] duration-[160ms] group-hover:grayscale-0 group-focus-visible:grayscale-0 motion-reduce:transition-none"
							style:background-image={`url("${sessionsIconUrl}")`}
							aria-hidden="true"
						></span>
					{:else}
						<Codicon id="vscode" size={16} />
					{/if}
					<span
						class="ml-0 inline-block max-w-0 overflow-hidden text-(--vscode-foreground) opacity-0 transition-[max-width,opacity,margin] delay-200 duration-[160ms] group-hover:ml-1.5 group-hover:max-w-[200px] group-hover:opacity-100 group-hover:delay-0 group-focus-visible:ml-1.5 group-focus-visible:max-w-[200px] group-focus-visible:opacity-100 group-focus-visible:delay-0 motion-reduce:transition-none"
					>
						{toAgents ? 'Open in Agents' : 'Open in Editor'}
					</span>
				</button>
			{/if}
			<div class={['action-toolbar-container ml-auto flex h-full shrink-0 items-center gap-1 pr-1', macChrome && 'mr-2']} role="toolbar" aria-label="Title actions">
				{#each rightLayoutItems as id (id)}
					{#if shown(id)}
						{#if id === 'customizeLayout'}
							<!-- workbench.layoutControl.type both: Customize Layout... first, opening the layout picker. -->
							<button class={ACTION} aria-label="Customize Layout..." title="Customize Layout...{hint('workbench.action.customizeLayout')}" onclick={() => commands.run('workbench.action.customizeLayout')}>
								<Codicon id="configure-layout-icon" size={16} />
							</button>
						{:else if id === 'layoutMenu'}
							<button class={[ACTION, popup?.kind === 'layout' && ACTIVE]} aria-label="Configure Layout" title="Configure Layout" aria-haspopup="menu" onclick={(e) => openBelow('layout', e, true)}>
								<Codicon id="configure-layout-icon" size={16} />
							</button>
						{:else}
							{@const tg = TOGGLES[id]}
							{@const on = tg.on()}
							<!-- chat.viewProgressBadge.enabled: the chat panel's toggle shows a dot while a chat works. -->
							{@const chatBusy = id === 'toggleAuxiliaryBar' && !appMode.isAgents && chatProgress.badge}
							<!-- VS Code's toggled actions: the `-off` icon while hidden, the plain one while shown; no fill. -->
							<button
								aria-label={chatBusy ? `${tg.label} · ${translate('chatRender.badge')}` : tg.label}
								aria-pressed={on}
								title="{tg.label}{hint(tg.command)}{chatBusy ? `\n${translate('chatRender.badge')}` : ''}"
								class={[ACTION, 'relative', on && 'checked']}
								onclick={() => commands.run(tg.command)}
							>
								<Codicon id={layoutToggleIcon(id, on, sidebarRight)} size={16} />
								{#if chatBusy}<span class="absolute right-0.5 bottom-0.5 size-1.5 animate-pulse rounded-full bg-(--vscode-activityBarBadge-background)"></span>{/if}
							</button>
						{/if}
					{/if}
				{/each}
				{#if shown('notifications')}
					<button
						class={ACTION}
						aria-expanded={notifications.centerVisible}
						aria-label={notifications.doNotDisturb ? 'Notifications (Do Not Disturb)' : notifications.unread ? `Notifications: ${notifications.unread} new` : 'Notifications'}
						title="Toggle Notifications"
						onclick={() => notifications.toggleCenter()}
					>
						<Codicon id={notifications.doNotDisturb ? 'bell-slash' : notifications.unread ? 'bell-dot' : 'bell'} size={16} />
					</button>
				{/if}
				{#if shown('accounts')}
					<button aria-label={`${account.label} · บัญชี AI`} title={`${account.label}\nคลิก: บัญชี AI (Claude, Codex) และทีม`} class={[ACTION, 'relative']} onclick={() => showAccountsMenu()}>
						<Codicon id="accounts-view-bar-icon" size={16} />
						{#if account.signedIn}
							<span class="absolute right-0.5 bottom-0.5 size-1.5 rounded-full bg-(--vscode-activityBarBadge-background)"></span>
						{/if}
					</button>
				{/if}
				{#if shown('manage')}
					<button aria-label="Manage" title="Manage" aria-haspopup="menu" class={[ACTION, popup?.kind === 'manage' && ACTIVE]} onclick={(e) => openBelow('manage', e, true)}>
						<Codicon id="settings-view-bar-icon" size={16} />
					</button>
				{/if}
			</div>
		</div>
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
