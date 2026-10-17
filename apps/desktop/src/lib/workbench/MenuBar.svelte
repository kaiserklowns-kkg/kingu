<script lang="ts">
	// In-window menu bar for Windows and Linux (VS Code's `window.menuBarVisibility: classic`), drawn
	// from the same model as the macOS native menu (menus.ts). Alt alone focuses it, Alt+letter opens
	// a menu by its mnemonic, ←/→ move between menus, ↓/Enter open one, Escape closes and gives focus
	// back to where it was.
	import MenuList from './MenuList.svelte';
	import { currentMenubar, runMenuItem, runRole } from './appMenu.svelte';
	import type { MenuNode } from './menus';

	const menus = $derived(currentMenubar(false));

	let bar: HTMLDivElement | undefined = $state();
	let openIndex = $state<number | null>(null);
	let focusFirst = $state(false);
	let showMnemonics = $state(false);
	/** Focus before the menu bar took it, restored on close. */
	let previousFocus: HTMLElement | null = null;
	/** Alt went down with no other key since: its release focuses the menu bar. */
	let altArmed = false;

	const tops = () => (bar ? [...bar.querySelectorAll<HTMLButtonElement>(':scope > div > button')] : []);
	const inBar = () => !!bar && bar.contains(document.activeElement);

	function remember() {
		if (!inBar() && document.activeElement instanceof HTMLElement) previousFocus = document.activeElement;
	}

	function open(i: number, fromKeyboard: boolean) {
		remember();
		focusFirst = fromKeyboard;
		openIndex = (i + menus.length) % menus.length;
	}

	function closeAll(restore = true) {
		openIndex = null;
		showMnemonics = false;
		if (restore) previousFocus?.focus();
		previousFocus = null;
	}

	function run(node: MenuNode) {
		closeAll(true);
		// After focus is back where it was, so the command acts on the editor or input the user was in.
		setTimeout(() => {
			if (node.type === 'item') runMenuItem(node.id);
			else if (node.type === 'role') void runRole(node.role);
		});
	}

	function onTopKey(e: KeyboardEvent, i: number) {
		let handled = true;
		if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
			const next = (i + (e.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length;
			if (openIndex !== null) open(next, true);
			else tops()[next]?.focus();
		} else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') open(i, true);
		else if (e.key === 'Escape') closeAll(true);
		else handled = false;
		if (handled) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	function onWindowKeyDown(e: KeyboardEvent) {
		altArmed = e.key === 'Alt' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.shiftKey;
		if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !/^Key[A-Z]$/.test(e.code)) return;
		// Alt+F: the menu whose mnemonic is F (only when no keybinding took the chord).
		const letter = e.code.slice(3).toLowerCase();
		const i = menus.findIndex((m) => m.mnemonic !== undefined && m.text[m.mnemonic].toLowerCase() === letter);
		if (i < 0) return;
		e.preventDefault();
		open(i, true);
	}

	function onWindowKeyUp(e: KeyboardEvent) {
		if (e.key !== 'Alt' || !altArmed) return;
		altArmed = false;
		e.preventDefault();
		if (openIndex !== null || inBar()) return closeAll(true);
		remember();
		showMnemonics = true;
		tops()[0]?.focus();
	}
</script>

<svelte:window onkeydown={onWindowKeyDown} onkeyup={onWindowKeyUp} onblur={() => openIndex !== null && closeAll(false)} />

{#if openIndex !== null}
	<!-- Clicks outside close the menu (VS Code's menus close on any outside click). -->
	<div class="fixed inset-0 z-40" role="presentation" data-tauri-drag-region="false" onpointerdown={() => closeAll(true)}></div>
{/if}

<div
	bind:this={bar}
	role="menubar"
	aria-label="Application menu"
	tabindex="-1"
	data-tauri-drag-region="false"
	class="relative z-50 flex h-full items-center"
	onfocusout={() => queueMicrotask(() => !inBar() && openIndex === null && (showMnemonics = false))}
>
	{#each menus as menu, i (menu.id)}
		<div class="relative">
			<button
				role="menuitem"
				aria-haspopup="menu"
				aria-expanded={openIndex === i}
				tabindex={i === 0 ? 0 : -1}
				class={[
					'h-[26px] rounded px-2 text-[13px] outline-none hover:bg-(--vscode-toolbar-hoverBackground) focus-visible:bg-(--vscode-toolbar-hoverBackground)',
					openIndex === i && 'bg-(--vscode-toolbar-hoverBackground)'
				]}
				onmousedown={(e) => {
					e.preventDefault();
					if (openIndex === i) closeAll(true);
					else open(i, false);
				}}
				onpointerenter={() => openIndex !== null && openIndex !== i && open(i, false)}
				onkeydown={(e) => onTopKey(e, i)}
			>
				{#if showMnemonics && menu.mnemonic !== undefined}
					{menu.text.slice(0, menu.mnemonic)}<u>{menu.text[menu.mnemonic]}</u>{menu.text.slice(menu.mnemonic + 1)}
				{:else}
					{menu.text}
				{/if}
			</button>
			{#if openIndex === i}
				{#key i}
					<MenuList
						items={menu.items}
						label={menu.text}
						{focusFirst}
						onRun={run}
						onClose={() => {
							openIndex = null;
							tops()[i]?.focus();
						}}
						onSide={(dir) => open(i + dir, true)}
					/>
				{/key}
			{/if}
		</div>
	{/each}
</div>
