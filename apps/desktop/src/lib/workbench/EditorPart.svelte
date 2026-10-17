<script lang="ts">
	import EditorHost from './EditorHost.svelte';
	import Icon from './Icon.svelte';
	import { editors } from './editors.svelte';
	import { status } from './status.svelte';
	import { keyLabel } from './keys';

	const base = (p: string) => p.split('/').pop() ?? p;
	const crumbs = $derived(editors.active ? editors.active.split('/') : []);

	function close(path: string, force: boolean) {
		if (!editors.close(path, { force })) status.flash('มีการแก้ไขที่ยังไม่บันทึก: กด ⌘S ก่อน หรือกด ⌥ ค้างแล้วคลิก × เพื่อทิ้งการแก้ไข');
	}

	const watermark = [
		['Show All Commands', 'cmd+shift+p'],
		['Go to File', 'cmd+p'],
		['Toggle Terminal', 'ctrl+`'],
		['Toggle Agent', 'cmd+alt+b']
	];
</script>

<div class="flex h-full min-w-0 flex-col bg-(--vscode-editor-background)">
	{#if editors.tabs.length}
		<div
			role="tablist"
			aria-label="Editor tabs"
			class="flex h-(--kg-tab-height) shrink-0 overflow-x-auto bg-(--vscode-editorGroupHeader-tabsBackground) [scrollbar-width:none]"
		>
			{#each editors.tabs as tab (tab.path)}
				{@const active = tab.path === editors.active}
				<div
					class={[
						'group relative flex h-full shrink-0 items-center border-r border-(--vscode-tab-border) pl-3',
						active ? 'bg-(--vscode-tab-activeBackground) text-(--vscode-tab-activeForeground)' : 'bg-(--vscode-tab-inactiveBackground) text-(--vscode-tab-inactiveForeground) hover:bg-(--vscode-tab-hoverBackground)'
					]}
				>
					{#if active}<span class="absolute inset-x-0 top-0 h-px bg-(--vscode-tab-activeBorderTop)"></span>{/if}
					<button
						role="tab"
						aria-selected={active}
						title={tab.path}
						class={['h-full pr-1 whitespace-nowrap', tab.preview && 'italic']}
						onclick={() => (editors.active = tab.path)}
						ondblclick={() => editors.pin(tab.path)}
						onauxclick={(e) => e.button === 1 && close(tab.path, false)}
					>
						{base(tab.path)}
					</button>
					<button
						aria-label={tab.dirty ? `${base(tab.path)} ยังไม่บันทึก: ปิด` : `ปิด ${base(tab.path)}`}
						class={[
							'mr-1 grid size-5 place-items-center rounded hover:bg-white/10',
							!active && !tab.dirty && 'invisible group-hover:visible'
						]}
						onclick={(e) => close(tab.path, e.altKey)}
					>
						{#if tab.dirty}
							<span class="size-2 rounded-full bg-current group-hover:hidden"></span>
							<span class="hidden group-hover:block"><Icon name="close" size={14} /></span>
						{:else}
							<Icon name="close" size={14} />
						{/if}
					</button>
				</div>
			{/each}
		</div>
		<nav
			aria-label="Breadcrumbs"
			class="flex h-(--kg-breadcrumbs-height) shrink-0 items-center gap-0.5 overflow-hidden px-3 text-(--vscode-breadcrumb-foreground)"
		>
			{#each crumbs as c, i (i)}
				{#if i > 0}<Icon name="chevronRight" size={14} />{/if}
				<span class="whitespace-nowrap">{c}</span>
			{/each}
		</nav>
	{/if}

	<div class="relative min-h-0 flex-1">
		<div class={['absolute inset-0', !editors.active && 'invisible']}>
			<EditorHost />
		</div>
		{#if !editors.active}
			<div class="absolute inset-0 grid place-items-center">
				<dl class="grid grid-cols-[auto_auto] gap-x-4 gap-y-2 text-(--vscode-descriptionForeground)">
					{#each watermark as [label, key] (label)}
						<dt class="text-right">{label}</dt>
						<dd class="font-mono tracking-widest">{keyLabel(key)}</dd>
					{/each}
				</dl>
			</div>
		{/if}
	</div>
</div>
