<script lang="ts">
	// Orca's floating workspace panel: a 36px title bar holding the tab strip (terminals and
	// markdown notes, "+" for more) with Maximize / Minimize at the right, eight resize handles,
	// drag the title bar to move, double-click it to maximize. Minimize only hides the panel; its
	// shells keep running. Shortcuts inside it: ⌘T terminal, ⇧⌘M new note, ⇧⌘O open note,
	// ⌘W close tab (hide when none), ⌘1–9 select a tab.
	import Terminal from '#lib/terminal/Terminal.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import Icon from './Icon.svelte';
	import PopupMenu, { menuItem } from './PopupMenu.svelte';
	import FloatingNote from './FloatingNote.svelte';
	import FloatingToggle from './FloatingToggle.svelte';
	import { floating } from './floating.svelte';
	import { clampRect, resizeRect, type Edge, type Rect } from './floating';

	const cwd = $derived(settings.get<string>('kingu.floating.cwd') ?? '~');
	let panel: HTMLElement | undefined = $state();

	// --- Move and resize (preview while dragging, commit on release) ---------------------------
	let preview = $state<Rect | null>(null);
	const rect = $derived(preview ?? floating.rect);
	let drag: { kind: 'move' | Edge; px: number; py: number; start: Rect; moved: boolean } | null = null;
	const NO_DRAG = 'button,input,textarea,select,[role="tab"],[data-floating-terminal-no-drag]';

	function begin(e: PointerEvent, kind: 'move' | Edge) {
		if (e.button !== 0) return;
		if (kind === 'move' && (floating.maximized || (e.target as HTMLElement).closest(NO_DRAG))) return;
		drag = { kind, px: e.clientX, py: e.clientY, start: { ...floating.rect }, moved: false };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		panel?.focus({ preventScroll: true });
		e.preventDefault();
	}
	function move(e: PointerEvent) {
		if (!drag) return;
		const dx = e.clientX - drag.px;
		const dy = e.clientY - drag.py;
		drag.moved ||= dx !== 0 || dy !== 0;
		const s = drag.start;
		const next = drag.kind === 'move' ? { ...s, left: s.left + dx, top: s.top + dy } : resizeRect(s, drag.kind, dx, dy);
		preview = clampRect(next, window.innerWidth, window.innerHeight);
	}
	function end() {
		if (drag?.moved && preview) floating.commit(preview);
		drag = null;
		preview = null;
	}
	const HANDLES: { edge: Edge; cls: string }[] = [
		{ edge: 'n', cls: 'top-0 left-2 right-2 h-2 cursor-n-resize' },
		{ edge: 's', cls: 'bottom-0 left-2 right-2 h-2 cursor-s-resize' },
		{ edge: 'w', cls: 'left-0 top-2 bottom-2 w-2 cursor-w-resize' },
		{ edge: 'e', cls: 'right-0 top-2 bottom-2 w-2 cursor-e-resize' },
		{ edge: 'nw', cls: 'top-0 left-0 size-3 cursor-nw-resize' },
		{ edge: 'ne', cls: 'top-0 right-0 size-3 cursor-ne-resize' },
		{ edge: 'sw', cls: 'bottom-0 left-0 size-3 cursor-sw-resize' },
		{ edge: 'se', cls: 'bottom-0 right-0 size-3 cursor-se-resize' }
	];

	// --- Tabs -----------------------------------------------------------------------------------
	let renaming = $state<string | null>(null);
	let newMenu = $state<{ x: number; y: number } | null>(null);
	const NEW_ITEMS = [menuItem('note', 'New Markdown', { keyLabel: '⇧⌘M' }), menuItem('open', 'Open Markdown...', { keyLabel: '⇧⌘O' }), menuItem('terminal', 'New Terminal', { keyLabel: '⌘T' })];
	function runNew(id: string) {
		if (id === 'note') void floating.newNote();
		else if (id === 'open') void floating.openNote();
		else floating.newTerminal();
	}

	// --- Keyboard inside the panel (before the workbench's own shortcuts) ---------------------
	function onkeydown(e: KeyboardEvent) {
		if (!floating.open || !panel?.contains(e.target as Node) || !e.metaKey || e.ctrlKey) return;
		const k = e.key.toLowerCase();
		let handled = true;
		if (!e.shiftKey && !e.altKey && k === 't') floating.newTerminal();
		else if (e.shiftKey && !e.altKey && k === 'm') void floating.newNote();
		else if (e.shiftKey && !e.altKey && k === 'o') void floating.openNote();
		else if (!e.shiftKey && !e.altKey && k === 'w') {
			if (floating.active) floating.closeTab(floating.active);
			else floating.hide();
		} else if (!e.shiftKey && !e.altKey && /^[1-9]$/.test(k)) {
			const t = floating.tabs[Number(k) - 1];
			if (t) floating.select(t.id);
		} else handled = false;
		if (handled) {
			e.preventDefault();
			e.stopImmediatePropagation();
		}
	}
	// Opening focuses the active terminal, or the panel so the empty-state shortcuts work.
	$effect(() => {
		if (!floating.open || !panel) return;
		const el = panel;
		requestAnimationFrame(() => {
			const term = el.querySelector<HTMLElement>('[data-floating-active] .xterm-helper-textarea, [data-floating-active] textarea');
			(term ?? el).focus({ preventScroll: true });
		});
	});

	const CONTROL = 'grid size-6 place-items-center rounded-md border border-(--vscode-widget-border) bg-(--vscode-list-inactiveSelectionBackground) text-(--vscode-foreground) shadow-xs hover:bg-(--vscode-toolbar-hoverBackground)';
	const EMPTY_ROW = 'grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 text-left text-sm hover:bg-(--vscode-list-hoverBackground)';
	const KBD = 'rounded border border-(--vscode-widget-border) px-1 font-sans text-[10px] text-(--vscode-descriptionForeground)';
</script>

<svelte:window onkeydowncapture={onkeydown} onresize={() => floating.resized()} />

{#if floating.mounted}
	<section
		bind:this={panel}
		data-floating-terminal-panel
		tabindex="-1"
		aria-label="Floating workspace"
		aria-hidden={!floating.open}
		class={[
			'fixed z-[45] flex min-h-[280px] min-w-[420px] rounded-lg shadow-[0_8px_20px_rgba(0,0,0,0.35),0_28px_72px_rgba(0,0,0,0.58)] outline-none',
			floating.open ? 'visible opacity-100' : 'pointer-events-none invisible opacity-0'
		]}
		style:left="{rect.left}px"
		style:top="{rect.top}px"
		style:width="{rect.width}px"
		style:height="{rect.height}px"
	>
		<div class="relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-lg border border-white/14 bg-(--vscode-editorGroupHeader-tabsBackground)">
			<!-- Title bar: drag to move (not on tabs or buttons), double-click to maximize. -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class={['flex h-9 shrink-0 items-center border-b border-(--vscode-widget-border) select-none', !floating.maximized && 'cursor-grab active:cursor-grabbing']}
				onpointerdown={(e) => begin(e, 'move')}
				onpointermove={move}
				onpointerup={end}
				ondblclick={(e) => !(e.target as HTMLElement).closest(NO_DRAG) && floating.toggleMaximized()}
			>
				<div class="flex h-full min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-1 [scrollbar-width:none]" role="tablist" aria-label="Floating workspace tabs">
					{#each floating.tabs as t (t.id)}
						{@const on = floating.active === t.id}
						<div
							role="tab"
							tabindex="0"
							aria-selected={on}
							class={['group relative flex h-[calc(100%-5px)] max-w-48 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg pr-1 pl-2.5 text-[12px]', on ? 'bg-(--vscode-tab-activeBackground) text-(--vscode-tab-activeForeground)' : 'text-(--vscode-tab-inactiveForeground) hover:bg-(--vscode-tab-hoverBackground)']}
							onclick={() => floating.select(t.id)}
							onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && floating.select(t.id)}
							ondblclick={() => (renaming = t.id)}
							onauxclick={(e) => e.button === 1 && floating.closeTab(t.id)}
						>
							{#if on}<span class="absolute inset-x-2.5 top-0 h-0.5 rounded-b-full bg-(--vscode-tab-activeBorderTop,var(--vscode-focusBorder))"></span>{/if}
							<Icon name={t.kind === 'terminal' ? 'terminal' : 'fileText'} size={13} />
							{#if renaming === t.id}
								<!-- svelte-ignore a11y_autofocus -->
								<input
									class="w-24 bg-transparent outline-none"
									aria-label="Rename tab {t.title}"
									autofocus
									value={t.title}
									onfocus={(e) => e.currentTarget.select()}
									onkeydown={(e) => {
										e.stopPropagation();
										if (e.key === 'Enter') (floating.rename(t.id, e.currentTarget.value), (renaming = null));
										if (e.key === 'Escape') renaming = null;
									}}
									onblur={(e) => (floating.rename(t.id, e.currentTarget.value), (renaming = null))}
								/>
							{:else}
								<span class="truncate">{t.title}</span>
							{/if}
							{#if floating.unread[t.id]}<span class="size-1.5 shrink-0 rounded-full bg-amber-500"></span>{/if}
							<button
								class={['grid size-5 shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)', on ? 'opacity-100' : 'opacity-0 group-hover:opacity-100']}
								aria-label="Close tab {t.title}"
								title="Close (⌘W)"
								onclick={(e) => (e.stopPropagation(), floating.closeTab(t.id))}><Icon name="close" size={12} /></button
							>
						</div>
					{/each}
					<button
						class="mb-1 grid size-6 shrink-0 place-items-center self-center rounded-md text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)"
						aria-label="New tab"
						title="New tab"
						onclick={(e) => {
							const r = e.currentTarget.getBoundingClientRect();
							newMenu = { x: r.left, y: r.bottom + 4 };
						}}><Icon name="plus" size={14} /></button
					>
				</div>
				<div class="flex items-center gap-1 px-2" data-floating-terminal-no-drag>
					<button class={CONTROL} aria-pressed={floating.maximized} aria-label={floating.maximized ? 'Restore floating workspace' : 'Maximize floating workspace'} title="{floating.maximized ? 'Restore' : 'Maximize'} (⌥⇧⌘A)" onclick={() => floating.toggleMaximized()}>
						<Icon name={floating.maximized ? 'restore' : 'maximize'} size={13} />
					</button>
					<button class={CONTROL} aria-label="Minimize floating workspace" title="Minimize" onclick={() => floating.hide()}><Icon name="minus" size={13} /></button>
				</div>
			</div>

			<div class="relative min-h-0 flex-1 overflow-hidden bg-(--vscode-terminal-background,var(--vscode-panel-background))">
				{#each floating.tabs as t (t.id)}
					<div class={['absolute inset-0', floating.active !== t.id && 'invisible']} data-floating-active={floating.active === t.id ? '' : undefined}>
						{#if t.kind === 'terminal'}
							<Terminal floatingCwd={cwd} onoutput={() => floating.activity(t.id)} />
						{:else if t.path}
							<FloatingNote path={t.path} />
						{/if}
					</div>
				{:else}
					<!-- Empty state (Orca): the ways to start, with their shortcuts. -->
					<div class="grid h-full place-items-center bg-(--vscode-editor-background)">
						<div class="flex w-[360px] flex-col gap-1.5">
							<button class={EMPTY_ROW} onclick={() => floating.newTerminal()}><Icon name="terminal" size={15} />New Terminal<span class="flex gap-0.5"><kbd class={KBD}>⌘</kbd><kbd class={KBD}>T</kbd></span></button>
							<button class={EMPTY_ROW} onclick={() => floating.newNote()}><Icon name="fileText" size={15} />New Markdown Note<span class="flex gap-0.5"><kbd class={KBD}>⇧</kbd><kbd class={KBD}>⌘</kbd><kbd class={KBD}>M</kbd></span></button>
							<button class={EMPTY_ROW} onclick={() => floating.openNote()}><Icon name="fileText" size={15} />Open Markdown Note<span class="flex gap-0.5"><kbd class={KBD}>⇧</kbd><kbd class={KBD}>⌘</kbd><kbd class={KBD}>O</kbd></span></button>
							<button class={EMPTY_ROW} onclick={() => floating.hide()}><Icon name="minus" size={15} />Minimize<span class="flex gap-0.5"><kbd class={KBD}>⌘</kbd><kbd class={KBD}>W</kbd></span></button>
						</div>
					</div>
				{/each}
			</div>

			{#if !floating.maximized}
				{#each HANDLES as h (h.edge)}
					<div class="absolute z-10 {h.cls}" data-floating-terminal-no-drag role="presentation" onpointerdown={(e) => begin(e, h.edge)} onpointermove={move} onpointerup={end}></div>
				{/each}
			{/if}
		</div>
	</section>
{/if}

<!-- In the status bar instead when asked, unless the status bar is hidden (Orca falls back). -->
{#if floating.enabled && (floating.location === 'floating-button' || settings.get<boolean>('workbench.statusBar.visible') === false)}
	<FloatingToggle />
{/if}

{#if newMenu}
	<PopupMenu items={NEW_ITEMS} label="New tab" x={newMenu.x} y={newMenu.y} onRun={(n) => n.type === 'item' && runNew(n.id)} onClose={() => (newMenu = null)} />
{/if}
