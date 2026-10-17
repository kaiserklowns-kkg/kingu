<script lang="ts">
	// One dropdown of the in-window menu bar (and its submenus, recursively). Keyboard like VS Code's
	// menus: ↑/↓ move, → opens a submenu (or moves to the next menu at the top level), ← closes a
	// submenu (or moves to the previous menu), Enter/Space runs, Escape closes one level, a letter
	// jumps to the next item starting with it.
	import { onMount } from 'svelte';
	import Icon from './Icon.svelte';
	import MenuList from './MenuList.svelte';
	import type { MenuNode } from './menus';

	type Props = {
		items: MenuNode[];
		label: string;
		/** Run an item or role; the menu bar closes everything first. */
		onRun: (node: MenuNode) => void;
		/** Escape: close this level. */
		onClose: () => void;
		/** ← / → past the edge of this level (top-level dropdowns switch menus). */
		onSide?: (dir: -1 | 1) => void;
		/** Focus the first item when shown (opened from the keyboard). */
		focusFirst?: boolean;
		submenu?: boolean;
	};
	let { items, label, onRun, onClose, onSide, focusFirst = false, submenu = false }: Props = $props();

	let list: HTMLDivElement | undefined = $state();
	let openSub = $state<number | null>(null);
	let subFocusFirst = $state(false);

	const enabled = (n: MenuNode) => n.type === 'role' || n.type === 'submenu' || (n.type === 'item' && n.enabled);

	onMount(() => {
		if (focusFirst) focusAt(0, 1);
		else list?.focus();
	});

	function buttons(): HTMLElement[] {
		return list ? [...list.querySelectorAll<HTMLElement>(':scope > [data-index] > button')] : [];
	}

	/** Focuses the first enabled item at or after `from` going `dir`, wrapping around. */
	function focusAt(from: number, dir: 1 | -1) {
		const all = buttons();
		if (!all.length) return;
		for (let i = 0; i < all.length; i++) {
			const b = all[(from + dir * i + all.length * 2) % all.length];
			if (b.getAttribute('aria-disabled') !== 'true') return b.focus();
		}
	}

	function current(): number {
		return buttons().indexOf(document.activeElement as HTMLElement);
	}

	function openSubmenu(index: number, fromKeyboard: boolean) {
		subFocusFirst = fromKeyboard;
		openSub = index;
	}

	function activate(node: MenuNode, index: number, fromKeyboard: boolean) {
		if (node.type === 'submenu') openSubmenu(index, fromKeyboard);
		else if (enabled(node)) onRun(node);
	}

	function onKey(e: KeyboardEvent) {
		// Keys bubbling up from an open submenu were its own to handle.
		if (e.target !== list && !buttons().includes(e.target as HTMLElement)) return;
		const i = current();
		const node = i >= 0 ? itemNodes[i] : undefined;
		let handled = true;
		if (e.key === 'ArrowDown') focusAt(i + 1, 1);
		else if (e.key === 'ArrowUp') focusAt(i < 0 ? -1 : i - 1, -1);
		else if (e.key === 'Home') focusAt(0, 1);
		else if (e.key === 'End') focusAt(-1, -1);
		else if (e.key === 'ArrowRight') {
			if (node?.type === 'submenu') openSubmenu(i, true);
			else onSide?.(1);
		} else if (e.key === 'ArrowLeft') {
			if (submenu) onClose();
			else onSide?.(-1);
		} else if (e.key === 'Enter' || e.key === ' ') {
			if (node) activate(node, i, true);
		} else if (e.key === 'Escape') onClose();
		else if (e.key === 'Tab') onClose();
		else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
			const ch = e.key.toLowerCase();
			const all = buttons();
			for (let k = 1; k <= all.length; k++) {
				const j = (i + k + all.length) % all.length;
				const n = itemNodes[j];
				if (enabled(n) && 'text' in n && n.text.toLowerCase().startsWith(ch)) {
					all[j].focus();
					break;
				}
			}
		} else handled = false;
		if (handled) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	/** Items that get a row (separators excluded), in DOM order. */
	const itemNodes = $derived(items.filter((n) => n.type !== 'separator'));
	const rows = $derived.by(() => {
		let index = 0;
		return items.map((node) => ({ node, index: node.type === 'separator' ? -1 : index++ }));
	});
</script>

<div
	bind:this={list}
	role="menu"
	aria-label={label}
	tabindex="-1"
	class={[
		'absolute z-50 min-w-[240px] rounded-md border border-[color:var(--vscode-menu-border,#454545)] bg-[var(--vscode-menu-background,#1F1F1F)] py-1 text-[13px] text-[color:var(--vscode-menu-foreground,#CCCCCC)] shadow-[0_2px_8px_rgba(0,0,0,0.36)] outline-none',
		submenu ? 'top-[-5px] left-full' : 'top-full left-0'
	]}
	onkeydown={onKey}
>
	{#each rows as { node, index }, r (r)}
		{#if node.type === 'separator'}
			<div role="separator" class="mx-2 my-1 h-px bg-[var(--vscode-menu-separatorBackground,#454545)]"></div>
		{:else}
			{@const disabled = !enabled(node)}
			{@const key = node.type === 'submenu' ? undefined : node.keyLabel}
			<div data-index={index} class="relative" role="none">
				<button
					role={node.type === 'item' && node.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
					aria-checked={node.type === 'item' && node.checked !== undefined ? node.checked : undefined}
					aria-disabled={disabled}
					aria-haspopup={node.type === 'submenu' ? 'menu' : undefined}
					aria-expanded={node.type === 'submenu' ? openSub === index : undefined}
					tabindex="-1"
					class={[
						'mx-1 flex h-6 w-[calc(100%-8px)] items-center gap-2 rounded px-2 text-left',
						disabled ? 'opacity-40' : 'hover:bg-[var(--vscode-menu-selectionBackground,#0078D4)] hover:text-[color:var(--vscode-menu-selectionForeground,#FFFFFF)] focus:bg-[var(--vscode-menu-selectionBackground,#0078D4)] focus:text-[color:var(--vscode-menu-selectionForeground,#FFFFFF)]',
						openSub === index && 'bg-[var(--vscode-menu-selectionBackground,#0078D4)] text-[color:var(--vscode-menu-selectionForeground,#FFFFFF)]',
						'outline-none'
					]}
					onpointerenter={() => (node.type === 'submenu' ? openSubmenu(index, false) : (openSub = null))}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => activate(node, index, false)}
				>
					<span class="grid w-4 shrink-0 place-items-center">
						{#if node.type === 'item' && node.checked}<Icon name="check" size={14} />{/if}
					</span>
					<span class="flex-1 truncate">{node.text}</span>
					{#if key}<span class="ml-6 shrink-0 text-xs opacity-80">{key}</span>{/if}
					{#if node.type === 'submenu'}<Icon name="chevronRight" size={14} />{/if}
				</button>
				{#if node.type === 'submenu' && openSub === index}
					<MenuList
						items={node.items}
						label={node.text}
						submenu
						focusFirst={subFocusFirst}
						{onRun}
						onClose={() => {
							openSub = null;
							focusAt(index, 1);
						}}
						onSide={(dir) => dir > 0 && onSide?.(1)}
					/>
				{/if}
			</div>
		{/if}
	{/each}
</div>
