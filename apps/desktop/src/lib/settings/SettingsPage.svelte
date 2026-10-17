<script lang="ts">
	// System settings: one page for the IDE and the ADE, over the content area of either mode
	// (the title bar and status bar stay). Left: the table of contents by section (ระบบ / IDE / ADE)
	// and group; right: the settings editor narrowed to that group. Escape or ✕ closes it.
	import Icon from '#lib/workbench/Icon.svelte';
	import { SETTINGS, SETTINGS_SECTIONS } from './registry';
	import SettingsEditor from './SettingsEditor.svelte';
	import { systemSettings } from './systemSettings.svelte';

	let query = $state('');
	const count = (group: string) => SETTINGS.filter((s) => s.group === group).length;
	const sectionOf = (group: string | null) => (group && !query ? (SETTINGS_SECTIONS.find((s) => s.groups.includes(group))?.label ?? '') : query ? 'ผลการค้นหา' : 'การตั้งค่าทั้งหมด (IDE + ADE)');

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
			<button class={[ITEM, systemSettings.group === null && !query && SELECTED]} onclick={() => ((systemSettings.group = null), (query = ''))}>ทั้งหมด</button>
			{#each SETTINGS_SECTIONS as sec (sec.id)}
				<div>
					<div class="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase">{sec.label}</div>
					{#each sec.groups as g (g)}
						<button
							class={[ITEM, systemSettings.group === g && !query && SELECTED]}
							aria-current={systemSettings.group === g && !query ? 'true' : undefined}
							onclick={() => ((systemSettings.group = g), (query = ''))}
						>
							<span class="flex-1 truncate">{g}</span>
							<span class="text-[11px] text-(--vscode-descriptionForeground)">{count(g)}</span>
						</button>
					{/each}
				</div>
			{/each}
		</div>
	</nav>
	<div class="flex min-w-0 flex-1 flex-col">
		<div class="flex h-[35px] shrink-0 items-center gap-2 border-b border-(--vscode-widget-border) pr-2 pl-6 text-[13px]">
			<span class="text-(--vscode-descriptionForeground)">{sectionOf(systemSettings.group)}</span>
			{#if systemSettings.group && !query}<span class="text-(--vscode-descriptionForeground)">›</span><span>{systemSettings.group}</span>{/if}
			<span class="flex-1"></span>
			<button class="grid size-7 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="ปิดการตั้งค่า" title="ปิด (Escape)" onclick={() => systemSettings.close()}>
				<Icon name="close" size={16} />
			</button>
		</div>
		<div class="min-h-0 flex-1"><SettingsEditor group={systemSettings.group} bind:query /></div>
	</div>
</section>
