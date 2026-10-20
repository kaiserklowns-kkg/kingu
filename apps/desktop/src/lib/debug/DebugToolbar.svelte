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
	import { toolbarSessions, toolbarShown, toolbarTarget, type ToolBarLocation } from './debugSettings.ts';
	import { t } from '#lib/i18n/index.ts';

	let { placement }: { placement: Exclude<ToolBarLocation, 'hidden'> } = $props();

	const shown = $derived(
		debug.active && toolbarShown(placement, settings.get<ToolBarLocation>('debug.toolBarLocation'), settings.get<boolean>('window.commandCenter') !== false)
	);

	// debug.showSubSessionsInToolBar: the session picker lists top-level sessions only, unless on.
	const showSub = $derived(settings.get<boolean>('debug.showSubSessionsInToolBar') === true);
	const pickable = $derived(toolbarSessions(debug.sessions, showSub));
	const selected = $derived(toolbarTarget(debug.sessions, debug.focusedKey, showSub));

	/** Picking a top-level session focuses the part of its tree that has program state (a stopped child, else its newest). */
	function pick(key: number) {
		if (showSub) return debug.focusSession(key);
		const tree = (k: number): number[] => debug.sessions.filter((s) => s.parentKey === k).flatMap((s) => [s.key, ...tree(s.key)]);
		const below = tree(key);
		const stopped = below.find((k) => debug.sessions.find((s) => s.key === k)?.model.state === 'stopped');
		debug.focusSession(stopped ?? below.at(-1) ?? key);
	}

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
		// Shown for adapters with supportsStepBack (VS Code's toolbar does the same).
		{ icon: 'arrowLeft', label: 'Step Back', command: 'workbench.action.debug.stepBack', show: !!debug.capabilities.supportsStepBack },
		{ icon: 'discard', label: 'Reverse', command: 'workbench.action.debug.reverseContinue', show: !!debug.capabilities.supportsStepBack },
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
	{#if pickable.length > 1}
		<select
			aria-label={t('debugger.sessionPicker')}
			title={t('debugger.sessionPicker')}
			class="h-6 max-w-40 min-w-0 truncate rounded border border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) px-1 text-(--vscode-dropdown-foreground)"
			value={selected ?? undefined}
			onchange={(e) => pick(Number(e.currentTarget.value))}
		>
			{#each pickable as s (s.key)}
				<option value={s.key}>{s.name}</option>
			{/each}
		</select>
	{/if}
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
