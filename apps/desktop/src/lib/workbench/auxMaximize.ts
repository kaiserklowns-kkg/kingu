// Maximize Secondary Side Bar (VS Code layout.ts setAuxiliaryBarMaximized): the secondary side bar
// alone beside the activity bar, the side bar, editor and panel hidden; restoring brings back the
// parts that were showing before. Pure, for `bun test`; layout.svelte.ts keeps the state.

export type AuxParts = { sideBar: boolean; panel: boolean; auxiliaryBar: boolean };

/** What the window showed when the secondary side bar was maximized. */
export type AuxRestore = Readonly<AuxParts>;

/** Maximizing: the secondary side bar shows (VS Code shows it first if hidden), the rest hide. */
export function maximizeAux(now: AuxParts): { parts: AuxParts; restore: AuxRestore } {
	return { parts: { sideBar: false, panel: false, auxiliaryBar: true }, restore: { ...now } };
}

/**
 * Restoring: the side bar and panel as they were before (VS Code sets each from the saved state,
 * so one shown while maximized hides again if it was hidden before); the secondary side bar stays
 * as it is now.
 */
export function restoreAux(now: AuxParts, restore: AuxRestore | null): AuxParts {
	if (!restore) return now;
	return { sideBar: restore.sideBar, panel: restore.panel, auxiliaryBar: now.auxiliaryBar };
}
