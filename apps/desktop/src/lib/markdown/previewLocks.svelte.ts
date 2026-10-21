// Locked Markdown previews (VS Code's "Open Locked Preview to the Side" / "Toggle Preview
// Locking"): a locked preview keeps showing its file; an unlocked one follows the active Markdown
// editor (MarkdownPreview.svelte, previewModel.ts followRemap).
import { SvelteSet } from 'svelte/reactivity';

class PreviewLocks {
	/** Editor keys (`preview:<rel>`) of the locked previews. */
	keys = new SvelteSet<string>();

	isLocked = (key: string) => this.keys.has(key);

	set(key: string, locked: boolean) {
		if (locked) this.keys.add(key);
		else this.keys.delete(key);
	}

	toggle(key: string): boolean {
		this.set(key, !this.keys.has(key));
		return this.keys.has(key);
	}
}

export const previewLocks = new PreviewLocks();
