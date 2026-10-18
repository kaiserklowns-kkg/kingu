<script lang="ts">
	// Settings › Appearance (Orca's General/Appearance pane): themes as preview cards, text sizes.
	import { onMount } from 'svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { THEMES, type ThemeInfo } from '#lib/theme/themes.ts';
	import { themeSwatch } from '#lib/theme/theme.svelte.ts';
	import { settings } from '../settings.svelte';
	import { SETTINGS } from '../registry';
	import Switch from './Switch.svelte';

	let swatches = $state<Record<string, Awaited<ReturnType<typeof themeSwatch>>>>({});
	onMount(() => {
		for (const t of THEMES) void themeSwatch(t).then((s) => (swatches[t.id] = s)).catch(() => {});
	});

	const current = $derived(settings.get<string>('workbench.colorTheme'));
	const defaultOf = (id: string) => SETTINGS.find((s) => s.id === id)?.default;
	const set = (id: string, value: unknown) => void settings.set(id, value === defaultOf(id) ? undefined : value, 'user');
	const pick = (t: ThemeInfo) => set('workbench.colorTheme', t.id);

	const groups: { label: string; types: ThemeInfo['type'][] }[] = [
		{ label: 'มืด', types: ['dark'] },
		{ label: 'สว่าง', types: ['light'] },
		{ label: 'High Contrast', types: ['hcDark', 'hcLight'] }
	];

	const fontSize = $derived(settings.get<number>('editor.fontSize'));
	const zoom = $derived(settings.get<number>('window.zoomLevel') ?? 0);
	const BTN = 'grid size-8 place-items-center rounded-md border border-(--vscode-widget-border) hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
</script>

<div class="h-full overflow-y-auto">
	<div class="mx-auto max-w-[880px] px-8 py-6">
		<h1 class="text-lg font-semibold">Appearance</h1>
		<p class="mt-1 text-[13px] text-(--vscode-descriptionForeground)">ธีมสีและขนาดตัวอักษรของ Kingu ใช้ทั้งโหมด IDE และ Agents</p>

		{#each groups as g (g.label)}
			<h2 class="mt-6 mb-2.5 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase">{g.label}</h2>
			<div class="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
				{#each THEMES.filter((t) => g.types.includes(t.type)) as t (t.id)}
					{@const s = swatches[t.id]}
					{@const on = current === t.id}
					<button
						class={['group overflow-hidden rounded-xl border text-left transition-colors', on ? 'border-(--vscode-focusBorder) ring-1 ring-(--vscode-focusBorder)' : 'border-(--vscode-widget-border) hover:border-(--vscode-descriptionForeground)']}
						aria-pressed={on}
						onclick={() => pick(t)}
					>
						<!-- A miniature workbench in the theme's own colors. -->
						<div class="flex h-24 gap-1 p-1.5" style:background={s?.chrome ?? 'transparent'}>
							<div class="w-1/4 rounded-[4px] border p-1.5" style:background={s?.side} style:border-color={s?.border}>
								<div class="mb-1 h-1.5 w-3/4 rounded-full" style:background={s?.muted}></div>
								<div class="mb-1 h-1.5 rounded-full" style:background={s?.selection}></div>
								<div class="h-1.5 w-2/3 rounded-full" style:background={s?.muted}></div>
							</div>
							<div class="flex-1 rounded-[4px] border p-2" style:background={s?.editor} style:border-color={s?.border}>
								<div class="mb-1.5 h-1.5 w-1/2 rounded-full" style:background={s?.fg}></div>
								<div class="mb-1.5 h-1.5 w-3/4 rounded-full opacity-60" style:background={s?.fg}></div>
								<div class="mb-2.5 h-1.5 w-2/5 rounded-full opacity-60" style:background={s?.fg}></div>
								<div class="h-3 w-10 rounded-[3px]" style:background={s?.accent}></div>
							</div>
						</div>
						<div class="flex items-center gap-2 px-3 py-2 text-[13px]">
							<span class="flex-1 truncate">{t.label}</span>
							{#if on}<span class="text-(--vscode-focusBorder)"><Icon name="check" size={14} /></span>{/if}
						</div>
					</button>
				{/each}
			</div>
		{/each}

		<h2 class="mt-8 mb-2.5 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase">ขนาด</h2>
		<div class="divide-y divide-(--vscode-widget-border) rounded-xl border border-(--vscode-widget-border)">
			<div class="flex items-center gap-3 px-4 py-3">
				<div class="flex-1">
					<div class="text-[13px]">ขนาดตัวอักษรใน editor</div>
					<div class="text-xs text-(--vscode-descriptionForeground)">editor.fontSize</div>
				</div>
				<button class={BTN} aria-label="ลดขนาด" disabled={fontSize <= 8} onclick={() => set('editor.fontSize', fontSize - 1)}><Icon name="minus" size={14} /></button>
				<span class="w-10 text-center font-mono text-[13px] tabular-nums">{fontSize}</span>
				<button class={BTN} aria-label="เพิ่มขนาด" disabled={fontSize >= 32} onclick={() => set('editor.fontSize', fontSize + 1)}><Icon name="plus" size={14} /></button>
			</div>
			<div class="flex items-center gap-3 px-4 py-3">
				<div class="flex-1">
					<div class="text-[13px]">ซูมทั้งหน้าต่าง</div>
					<div class="text-xs text-(--vscode-descriptionForeground)">window.zoomLevel · ⌘= / ⌘- / ⌘0</div>
				</div>
				<button class={BTN} aria-label="ซูมออก" disabled={zoom <= -5} onclick={() => set('window.zoomLevel', zoom - 1)}><Icon name="minus" size={14} /></button>
				<span class="w-10 text-center font-mono text-[13px] tabular-nums">{zoom > 0 ? `+${zoom}` : zoom}</span>
				<button class={BTN} aria-label="ซูมเข้า" disabled={zoom >= 5} onclick={() => set('window.zoomLevel', zoom + 1)}><Icon name="plus" size={14} /></button>
			</div>
		</div>

		<h2 class="mt-8 mb-2.5 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase">Status bar</h2>
		<div class="divide-y divide-(--vscode-widget-border) rounded-xl border border-(--vscode-widget-border)">
			<Switch id="kingu.statusBar.keepAwake.visible" label="กันเครื่องหลับ (☕)" hint="โหมด On / Auto / Off อยู่ในหน้า Arkai" />
			<Switch id="kingu.statusBar.resources.visible" label="Resource Manager" hint="หน่วยความจำและ terminal ที่เปิดอยู่" />
			<Switch id="kingu.statusBar.ports.visible" label="Ports" hint="พอร์ตที่โปรเซสของ Kingu เปิดอยู่" />
			<Switch id="kingu.statusBar.usage.visible" label="Usage" hint="โควตา session และรายสัปดาห์ของ Claude" />
		</div>
	</div>
</div>
