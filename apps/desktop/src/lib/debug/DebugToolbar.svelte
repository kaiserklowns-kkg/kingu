<script lang="ts">
	// The debug toolbar (VS Code: debugToolBar.ts) at `debug.toolBarLocation`: `floating` over the
	// workbench below the title bar (drag the grip to move it sideways), `docked` at the top of the
	// Run and Debug view, `commandCenter` in the title bar's command center, or `hidden`. Each
	// placement renders its own instance; only the one that matches the setting shows.
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { commands, keyOf } from '#lib/workbench/commands.svelte.ts';
	import { keyLabel } from '#lib/workbench/keys.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { debug } from './debug.svelte.ts';
	import { toolbarShown, type ToolBarLocation } from './debugSettings.ts';

	let { placement }: { placement: Exclude<ToolBarLocation, 'hidden'> } = $props();

	const shown = $derived(
		debug.active && toolbarShown(placement, settings.get<ToolBarLocation>('debug.toolBarLocation'), settings.get<boolean>('window.commandCenter') !== false)
	);

	const titled = (label: string, id: string) => {
		const cmd = commands.get(id);
		const key = cmd && keyOf(cmd);
		return key ? `${label} (${keyLabel(key)})` : label;
	};
	type Tool = { icon: IconName; label: string; command: string; show: boolean };
	const tools = $derived<Tool[]>([
		{ icon: 'play', label: 'Continue', command: 'workbench.action.debug.start', show: debug.stopped },
		{ icon: 'pause', label: 'Pause', command: 'workbench.action.debug.pause', show: !debug.stopped },
		{ icon: 'stepOver', label: 'Step Over', command: 'workbench.action.debug.stepOver', show: true },
		{ icon: 'stepInto', label: 'Step Into', command: 'workbench.action.debug.stepInto', show: true },
		{ icon: 'stepOut', label: 'Step Out', command: 'workbench.action.debug.stepOut', show: true },
		{ icon: 'refresh', label: 'Restart', command: 'workbench.action.debug.restart', show: true },
		{ icon: 'stop', label: 'Stop', command: 'workbench.action.debug.stop', show: true }
	]);

	// Floating: the horizontal position, as a fraction of the window width (VS Code keeps it too).
	const POSITION_KEY = 'kingu.debug.toolbarX';
	let x = $state(readX());
	function readX(): number {
		try {
			const v = Number(localStorage.getItem(POSITION_KEY));
			return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.5;
		} catch {
			return 0.5;
		}
	}
	function drag(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
		const move = (m: PointerEvent) => (x = Math.min(0.95, Math.max(0.05, m.clientX / window.innerWidth)));
		const up = () => {
			el.removeEventListener('pointermove', move);
			el.removeEventListener('pointerup', up);
			try {
				localStorage.setItem(POSITION_KEY, String(x));
			} catch {
				// Storage unavailable: the position lasts for this window only.
			}
		};
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', up);
	}

	const BUTTON = 'grid size-6 shrink-0 place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
</script>

{#snippet buttons()}
	{#each tools as t (t.label)}
		{#if t.show}
			<button aria-label={t.label} title={titled(t.label, t.command)} disabled={!commands.enabled(t.command)} class={BUTTON} onclick={() => commands.run(t.command)}>
				<Icon name={t.icon} size={16} />
			</button>
		{/if}
	{/each}
{/snippet}

{#if shown}
	{#if placement === 'floating'}
		<div
			role="toolbar"
			aria-label="Debug"
			class="fixed z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-md border border-(--vscode-widget-border) bg-(--vscode-debugToolBar-background,var(--vscode-editorWidget-background)) p-0.5 shadow-lg"
			style:left="{x * 100}%"
			style:top="calc(var(--kg-titlebar-height) + 4px)"
			data-tauri-drag-region="false"
		>
			<span role="presentation" class="h-5 w-2 cursor-grab border-x border-dotted border-(--vscode-descriptionForeground) opacity-60" onpointerdown={drag}></span>
			{@render buttons()}
		</div>
	{:else}
		<div role="toolbar" aria-label="Debug" class="flex shrink-0 items-center gap-0.5">
			{@render buttons()}
		</div>
	{/if}
{/if}
