// ⇧⌘⌫ Delete Workspace (Orca's `workspace.delete`, "Delete Selected Workspace"): which side bar
// cards the shortcut acts on, and whether it acts at all. Pure; AdeSidebar.svelte runs the result
// through the same delete paths as the context menu (adeTasks.remove, the bulk delete).
//
// Ported from Orca's source:
// - sidebar/worktree-list/navigation/sidebar-workspace-delete.ts `resolveSidebarWorkspaceDeleteIntent`:
//   the target is the side bar's selection (not the card under the mouse); nothing selected does
//   nothing; a multi-selection deletes its deletable members as one batch, a lone deletable member
//   as a single delete, and does nothing when none is deletable; a single primary checkout does nothing.
// - sidebar/workspace-actions/context-menu/worktree-context-menu-policy.ts `isContextWorktreeDeletable`:
//   the primary (main) worktree is never deletable.
// - sidebar/worktree-list/navigation/use-sidebar-workspace-delete-keyboard.ts: a held key (auto
//   repeat) is swallowed and deletes nothing.
// - sidebar/worktree-list/navigation/use-keyboard.ts `handleContainerKeyDown`: the key acts only
//   with focus on the worktree list, never while a text input composes or an overlay is open.

export type DeleteShortcutTarget = { kind: 'none' } | { kind: 'single'; key: string } | { kind: 'bulk'; keys: string[] };

export type DeleteShortcutInput = {
	/** The multi-selection (⌘/Shift-click); it counts from two cards up, as in the context menu. */
	selection: readonly string[];
	/** The open worktree's card; null while none is shown (the board). */
	current: string | null;
	/** A task with a worktree of its own: not the primary checkout, and still in the list. */
	deletable: (key: string) => boolean;
	/** The keydown is an auto-repeat of a held key. */
	repeat?: boolean;
	/** A menu or dialog is open over the side bar. */
	overlay?: boolean;
};

/** What ⇧⌘⌫ deletes right now; every result still goes through the delete confirmation. */
export function deleteShortcutTarget(input: DeleteShortcutInput): DeleteShortcutTarget {
	const none: DeleteShortcutTarget = { kind: 'none' };
	if (input.repeat || input.overlay) return none;
	if (input.selection.length > 1) {
		const keys = input.selection.filter(input.deletable);
		if (!keys.length) return none;
		return keys.length === 1 ? { kind: 'single', key: keys[0] } : { kind: 'bulk', keys };
	}
	const key = input.current;
	return key !== null && input.deletable(key) ? { kind: 'single', key } : none;
}

/**
 * Whether the keybinding applies to where the focus is: on the worktree list (or a card in it),
 * and not in a text field (a card being renamed). Orca requires the list itself to hold the focus.
 */
export function deleteShortcutHasFocus(focus: { inList: boolean; typing: boolean }): boolean {
	return focus.inList && !focus.typing;
}
