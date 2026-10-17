<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import Icon, { type IconName } from './Icon.svelte';
	import MenuBar from './MenuBar.svelte';
	import { commands, keyOf } from './commands.svelte';
	import { editorLabel } from './editorLabel';
	import { layout } from './layout.svelte';
	import { navigation } from './navigation.svelte';
	import { editors } from './editors.svelte';
	import { isMac, keyLabel } from './keys';
	import { windowTitle } from './title';
	import { agents } from '#lib/agent/agents.svelte.ts';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import { team } from '#lib/team/team.svelte.ts';

	let { workspaceName }: { workspaceName: string } = $props();

	const toggles: { label: string; icon: IconName; command: string; on: () => boolean }[] = [
		{ label: 'Toggle Primary Side Bar', icon: 'sidebarLeft', command: 'workbench.action.toggleSidebarVisibility', on: () => layout.sidebarVisible },
		{ label: 'Toggle Panel', icon: 'panelBottom', command: 'workbench.action.togglePanel', on: () => layout.panelVisible },
		{ label: 'Toggle Agent (Secondary Side Bar)', icon: 'sidebarRight', command: 'workbench.action.toggleAuxiliaryBar', on: () => layout.auxVisible }
	];

	/** ` (⌘B)` for a tooltip, from the command's live keybinding. */
	const keyHint = (command: string) => {
		const cmd = commands.get(command);
		const key = cmd && keyOf(cmd);
		return key ? ` (${keyLabel(key)})` : '';
	};

	const active = $derived(editors.active);
	const dirty = $derived(active !== null && editors.tabs.some((t) => t.path === active && t.dirty));
	// VS Code's `window.title`: `● file.ts — folder — Kingu`.
	const title = $derived(windowTitle({ editor: active ? editorLabel(active) : null, folder: workspaceName, dirty }));

	$effect(() => {
		document.title = title;
	});

	const account = $derived.by(() => {
		const s = team.status;
		if (!s) return { label: 'บัญชี: ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์ทีม (kingu.team.serverUrl)', signedIn: false };
		if (!s.signed_in) return { label: `บัญชี: ยังไม่ได้ลงชื่อเข้าใช้ทีม (${s.server})`, signedIn: false };
		return { label: `บัญชี: ลงชื่อเข้าใช้ทีมแล้ว (${s.server})${s.online ? '' : ' — ออฟไลน์'}`, signedIn: true };
	});

	/** Clicks on the bar itself (not on its buttons or menus) drag the window and double-click zooms it. */
	const onBarItself = (e: MouseEvent) => !(e.target as Element).closest('button, a, input, [role="menubar"], [role="menu"]');

	// macOS: Tauri's drag region toggles maximize on double-click; the system setting
	// (Zoom / Minimize / Do Nothing) is honoured instead, so the event stops here.
	function onMouseUp(e: MouseEvent) {
		if (!isMac || e.button !== 0 || e.detail !== 2 || !onBarItself(e)) return;
		e.stopPropagation();
		void invoke('window_titlebar_double_click').catch(() => {});
	}
</script>

<!-- Custom title bar, 35px with the command center (VS Code's default `window.titleBarStyle: custom`).
     The left inset clears the macOS traffic lights of the overlay title bar; Windows and Linux get
     the in-window menu bar there instead. `deep`: any non-interactive part of the bar drags. -->
<!-- svelte-ignore a11y_no_static_element_interactions (double-click zoom is a pointer convenience, like the native title bar) -->
<header
	data-tauri-drag-region="deep"
	onmouseup={onMouseUp}
	class={[
		'relative flex h-(--kg-titlebar-height) shrink-0 items-center gap-1 border-b border-(--vscode-titleBar-border) bg-(--vscode-titleBar-activeBackground) pr-2 text-(--vscode-titleBar-activeForeground) select-none',
		isMac ? 'pl-[78px]' : 'pl-1'
	]}
>
	<div class="flex shrink-0 items-center gap-0.5">
		{#if !isMac}<MenuBar />{/if}
		<button
			aria-label="Go Back"
			title="Go Back{keyHint('workbench.action.navigateBack')}"
			disabled={!navigation.canGoBack}
			class="grid size-6 place-items-center rounded enabled:hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-35"
			onclick={() => navigation.back()}
		>
			<Icon name="arrowLeft" size={16} />
		</button>
		<button
			aria-label="Go Forward"
			title="Go Forward{keyHint('workbench.action.navigateForward')}"
			disabled={!navigation.canGoForward}
			class="grid size-6 place-items-center rounded enabled:hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-35"
			onclick={() => navigation.forward()}
		>
			<Icon name="arrowRight" size={16} />
		</button>
	</div>
	<div class="flex min-w-0 flex-1 justify-center">
		<button
			class="flex h-[22px] w-[min(600px,38vw)] min-w-0 items-center justify-center gap-1.5 rounded-md border border-(--vscode-commandCenter-border) bg-(--vscode-commandCenter-background) px-2 text-xs hover:bg-(--vscode-toolbar-hoverBackground)"
			onclick={() => commands.run('workbench.action.quickOpen')}
			title="{title}&#10;ค้นหาไฟล์{keyHint('workbench.action.quickOpen')} · คำสั่ง{keyHint('workbench.action.showCommands')}"
		>
			<Icon name="search" size={14} />
			<span class="truncate">{title}</span>
		</button>
	</div>
	<div class="flex shrink-0 items-center gap-0.5">
		{#if adeTasks.badgeCount}
			<button
				class="mr-1 flex h-[22px] items-center gap-1 rounded-full bg-(--vscode-activityBarBadge-background) px-2 text-xs text-(--vscode-activityBarBadge-foreground) hover:opacity-90"
				title="เปิดงานถัดไปที่รอคุณ: รออนุญาต {agents.pendingCount} · รอรีวิว {adeTasks.reviewCount}"
				onclick={() => adeTasks.openNext()}
			>
				รอคุณ {adeTasks.badgeCount}
			</button>
		{/if}
		{#each toggles as t (t.command)}
			<button
				aria-label={t.label}
				aria-pressed={t.on()}
				title="{t.label}{keyHint(t.command)}"
				class={['grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)', t.on() ? 'opacity-100' : 'opacity-50']}
				onclick={() => commands.run(t.command)}
			>
				<Icon name={t.icon} size={16} />
			</button>
		{/each}
		<!-- Accounts (VS Code's title bar account menu); for now the team server sign-in. -->
		<button
			aria-label={account.label}
			title={account.label}
			class="relative ml-1 grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)"
			onclick={() => team.showMenu()}
		>
			<Icon name="account" size={16} />
			{#if account.signedIn}
				<span class="absolute right-0.5 bottom-0.5 size-1.5 rounded-full bg-(--vscode-activityBarBadge-background)"></span>
			{/if}
		</button>
	</div>
</header>
