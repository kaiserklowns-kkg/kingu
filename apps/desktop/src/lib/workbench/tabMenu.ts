// Editor tab context menu (VS Code's Close Others / Close to the Right / Close Saved / Close All).
// Pure: which tabs a close command takes.

export type TabClose = 'others' | 'right' | 'saved' | 'all';

/** Tabs `kind` closes when right-clicking `path`, in tab order. Dirty tabs are left for the caller to keep. */
export function tabsToClose(kind: TabClose, tabs: { path: string; dirty?: boolean }[], path: string): string[] {
	const i = tabs.findIndex((t) => t.path === path);
	switch (kind) {
		case 'others':
			return tabs.filter((t) => t.path !== path).map((t) => t.path);
		case 'right':
			return i < 0 ? [] : tabs.slice(i + 1).map((t) => t.path);
		case 'saved':
			return tabs.filter((t) => !t.dirty).map((t) => t.path);
		case 'all':
			return tabs.map((t) => t.path);
	}
}
