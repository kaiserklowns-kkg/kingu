<script lang="ts">
	// System settings: one page for the IDE and the ADE, over the content area of either mode
	// (the title bar and status bar stay). Left: the table of contents by section (ระบบ / IDE / ADE /
	// Snaps) and group; right: the settings editor narrowed to that group, or the Snap management
	// view. Escape or ✕ closes it.
	import Icon from '#lib/workbench/Icon.svelte';
	import SnapsView from '#lib/snaps/SnapsView.svelte';
	import { snaps } from '#lib/snaps/snaps.svelte.ts';
	import { SNAPS_SECTION_ID } from './registry';
	import { settingSchemas } from './schemas.svelte';
	import SettingsEditor from './SettingsEditor.svelte';
	import AppearancePage from './pages/AppearancePage.svelte';
	import ShortcutsPage from './pages/ShortcutsPage.svelte';
	import AboutPage from './pages/AboutPage.svelte';
	import ArkaiPage from './pages/ArkaiPage.svelte';
	import type { IconName } from '#lib/workbench/Icon.svelte';
	import type { SettingsPageId } from './systemSettings.svelte';

	// Dedicated pages above the settings groups (Orca's General / Shortcuts panes) and About at the bottom.
	const PAGES: { id: SettingsPageId; label: string; icon: IconName }[] = [
		{ id: 'appearance', label: 'Appearance', icon: 'layout' },
		{ id: 'shortcuts', label: 'Keyboard Shortcuts', icon: 'keyboard' },
		{ id: 'arkai', label: 'Arkai', icon: 'agent' }
	];
	const PAGE_LABEL: Record<SettingsPageId, string> = { appearance: 'Appearance', shortcuts: 'Keyboard Shortcuts', arkai: 'Arkai', about: 'About Kingu' };
	import { systemSettings } from './systemSettings.svelte';

	let query = $state('');
	const count = (group: string) => settingSchemas.all.filter((s) => s.group === group).length;
	const sectionOf = (group: string | null) =>
		group && !query ? (settingSchemas.sections.find((s) => s.groups.includes(group))?.label ?? '') : query ? 'ผลการค้นหา' : 'การตั้งค่าทั้งหมด (IDE + ADE)';
	const showSnaps = $derived(systemSettings.snaps && !query);
	const page = $derived(query ? null : systemSettings.page);

	function select(group: string | null) {
		systemSettings.group = group;
		systemSettings.snaps = false;
		systemSettings.page = null;
		query = '';
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (query) query = '';
		else systemSettings.close();
		e.preventDefault();
		e.stopPropagation();
	}

	const ITEM = 'flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] hover:bg-(--vscode-list-hoverBackground)';
	const SELECTED = 'bg-(--vscode-list-inactiveSelectionBackground) text-(--vscode-list-inactiveSelectionForeground,var(--vscode-foreground))';
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape closes the page from anywhere inside it) -->
<section aria-label="การตั้งค่าระบบ" class="flex min-h-0 flex-1 bg-(--vscode-editor-background) text-(--vscode-foreground)" {onkeydown}>
	<nav aria-label="หมวดการตั้งค่า" class="flex w-56 shrink-0 flex-col border-r border-(--vscode-sideBar-border) bg-(--vscode-sideBar-background)">
		<div class="flex h-[35px] shrink-0 items-center gap-2 px-4 text-[13px] font-semibold">
			<Icon name="settings" size={15} /> การตั้งค่า
		</div>
		<div class="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-3">
			<div class="space-y-0.5">
				{#each PAGES as p (p.id)}
					<button class={[ITEM, page === p.id && SELECTED]} aria-current={page === p.id ? 'true' : undefined} onclick={() => ((query = ''), systemSettings.showPage(p.id))}>
						<Icon name={p.icon} size={14} /><span class="flex-1 truncate">{p.label}</span>
					</button>
				{/each}
			</div>
			<button class={[ITEM, systemSettings.group === null && !showSnaps && !page && !query && SELECTED]} onclick={() => select(null)}>ทั้งหมด</button>
			{#each settingSchemas.sections as sec (sec.id)}
				<div>
					<div class="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase">{sec.label}</div>
					{#if sec.id === SNAPS_SECTION_ID}
						<button
							class={[ITEM, showSnaps && SELECTED]}
							aria-current={showSnaps ? 'true' : undefined}
							onclick={() => ((systemSettings.snaps = true), (systemSettings.group = null), (query = ''))}
						>
							<span class="flex-1 truncate">จัดการ Snaps</span>
							<span class="text-[11px] text-(--vscode-descriptionForeground)">{snaps.list.length}</span>
						</button>
					{/if}
					{#each sec.groups as g (g)}
						{@const current = systemSettings.group === g && !showSnaps && !query}
						<button class={[ITEM, current && SELECTED]} aria-current={current ? 'true' : undefined} onclick={() => select(g)}>
							<span class="flex-1 truncate">{g}</span>
							<span class="text-[11px] text-(--vscode-descriptionForeground)">{count(g)}</span>
						</button>
					{/each}
				</div>
			{/each}
		</div>
		<div class="shrink-0 border-t border-(--vscode-sideBar-border) p-2">
			<button class={[ITEM, page === 'about' && SELECTED]} aria-current={page === 'about' ? 'true' : undefined} onclick={() => ((query = ''), systemSettings.showPage('about'))}>
				<Icon name="info" size={14} /><span class="flex-1 truncate">About Kingu</span>
			</button>
		</div>
	</nav>
	<div class="flex min-w-0 flex-1 flex-col">
		<div class="flex h-[35px] shrink-0 items-center gap-2 border-b border-(--vscode-widget-border) pr-2 pl-6 text-[13px]">
			{#if page}
				<span>{PAGE_LABEL[page]}</span>
			{:else if showSnaps}
				<span class="text-(--vscode-descriptionForeground)">Snaps</span><span class="text-(--vscode-descriptionForeground)">›</span><span>จัดการ Snaps</span>
			{:else}
				<span class="text-(--vscode-descriptionForeground)">{sectionOf(systemSettings.group)}</span>
				{#if systemSettings.group && !query}<span class="text-(--vscode-descriptionForeground)">›</span><span>{systemSettings.group}</span>{/if}
			{/if}
			<span class="flex-1"></span>
			<button class="grid size-7 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="ปิดการตั้งค่า" title="ปิด (Escape)" onclick={() => systemSettings.close()}>
				<Icon name="close" size={16} />
			</button>
		</div>
		<div class="min-h-0 flex-1">
			{#if page === 'appearance'}<AppearancePage />
			{:else if page === 'shortcuts'}<ShortcutsPage />
			{:else if page === 'arkai'}<ArkaiPage />
			{:else if page === 'about'}<AboutPage />
			{:else if showSnaps}<SnapsView />{:else}<SettingsEditor group={systemSettings.group} bind:query />{/if}
		</div>
	</div>
</section>
