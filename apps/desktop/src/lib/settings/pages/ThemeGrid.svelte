<script lang="ts">
	// Appearance › Interface: Kingu's color themes and the active Snaps' as preview cards (a miniature workbench each).
	import Icon from '#lib/workbench/Icon.svelte';
	import { allThemes, type ThemeInfo } from '#lib/theme/themes.ts';
	import { themeSwatch } from '#lib/theme/theme.svelte.ts';
	import { snaps } from '#lib/snaps/snaps.svelte.ts';
	import { settings } from '../settings.svelte';
	import { SETTINGS } from '../registry';
	import { t } from '#lib/i18n/index.ts';

	let swatches = $state<Record<string, Awaited<ReturnType<typeof themeSwatch>>>>({});
	// Re-read when the snaps change.
	const themes = $derived((void snaps.list, allThemes()));
	$effect(() => {
		for (const th of themes) if (!swatches[th.id]) void themeSwatch(th).then((s) => (swatches[th.id] = s)).catch(() => {});
	});

	const current = $derived(settings.get<string>('workbench.colorTheme'));
	const defaultOf = (id: string) => SETTINGS.find((s) => s.id === id)?.default;
	const set = (id: string, value: unknown) => void settings.set(id, value === defaultOf(id) ? undefined : value, 'user');
	const pick = (th: ThemeInfo) => set('workbench.colorTheme', th.id);

	const groups = $derived<{ label: string; types: ThemeInfo['type'][] }[]>([
		{ label: t('panes.appearance.dark'), types: ['dark'] },
		{ label: t('panes.appearance.light'), types: ['light'] },
		{ label: t('panes.appearance.highContrast'), types: ['hcDark', 'hcLight'] }
	]);
</script>

<div>
	{#each groups as g (g.label)}
		<h2 class="mt-5 mb-2.5 text-xs first:mt-1 font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase">{g.label}</h2>
		<div class="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
			{#each themes.filter((th) => g.types.includes(th.type)) as th (th.id)}
				{@const s = swatches[th.id]}
				{@const on = current === th.id}
				<button
					class={['group overflow-hidden rounded-xl border text-left transition-colors', on ? 'border-(--vscode-focusBorder) ring-1 ring-(--vscode-focusBorder)' : 'border-(--vscode-widget-border) hover:border-(--vscode-descriptionForeground)']}
					aria-pressed={on}
					onclick={() => pick(th)}
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
						<span class="flex-1 truncate">{th.label}</span>
						{#if th.snap}<span class="shrink-0 rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] leading-4 text-(--vscode-badge-foreground)" title={`Snap: ${th.snap}`}>Snap</span>{/if}
						{#if on}<span class="text-(--vscode-focusBorder)"><Icon name="check" size={14} /></span>{/if}
					</div>
				</button>
			{/each}
		</div>
	{/each}
</div>
