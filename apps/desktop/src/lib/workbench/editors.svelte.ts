// Single editor group (VS Code: EditorGroupModel). At most one preview tab, shown in italics;
// opening another file unpinned replaces it. Editing or double-clicking pins.

export type EditorTab = { path: string; preview: boolean; dirty: boolean };
export type Cursor = { line: number; column: number };

class Editors {
	tabs = $state<EditorTab[]>([]);
	active = $state<string | null>(null);
	cursor = $state<Cursor>({ line: 1, column: 1 });
	language = $state('');
	indent = $state('');
	eol = $state('');
	/** Set by the editor host once Monaco is up. */
	gotoLine: (line: number, column?: number) => void = () => {};
	/** Cursor target for a tab whose model is still loading; the editor host applies and clears it. */
	reveal: { path: string; line: number; column: number } | null = null;

	/** Opens `path` with the cursor at `line`:`column` (Problems, Go to Definition). */
	openAt(path: string, line: number, column = 1, opts: { preview?: boolean } = {}) {
		const shown = this.active === path;
		this.open(path, opts);
		if (shown) this.gotoLine(line, column);
		else this.reveal = { path, line, column };
	}

	open(path: string, { preview = true }: { preview?: boolean } = {}) {
		const existing = this.tabs.find((t) => t.path === path);
		if (existing) {
			if (!preview) existing.preview = false;
		} else {
			const tab = { path, preview, dirty: false };
			const previewIdx = preview ? this.tabs.findIndex((t) => t.preview && !t.dirty) : -1;
			if (previewIdx >= 0) this.tabs[previewIdx] = tab;
			else {
				const at = this.active ? this.tabs.findIndex((t) => t.path === this.active) + 1 : this.tabs.length;
				this.tabs.splice(at, 0, tab);
			}
		}
		this.active = path;
	}

	pin(path: string) {
		const tab = this.tabs.find((t) => t.path === path);
		if (tab) tab.preview = false;
	}

	setDirty(path: string, dirty: boolean) {
		const tab = this.tabs.find((t) => t.path === path);
		if (!tab || tab.dirty === dirty) return;
		tab.dirty = dirty;
		if (dirty) tab.preview = false;
	}

	/** Returns false when the tab is dirty (the caller asks before discarding). */
	close(path: string, { force = false } = {}): boolean {
		const i = this.tabs.findIndex((t) => t.path === path);
		if (i < 0) return true;
		if (this.tabs[i].dirty && !force) return false;
		this.tabs.splice(i, 1);
		if (this.active === path) this.active = this.tabs[Math.min(i, this.tabs.length - 1)]?.path ?? null;
		return true;
	}
}

export const editors = new Editors();
