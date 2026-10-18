// Undo / redo for the right side bar's file operations (Orca's fileExplorerUndoRedo): a linear
// history of steps that each know how to reverse and replay themselves. A delete is undone from
// the copy Rust keeps before trashing (`fs_delete` returns its token, `fs_restore` puts it back),
// since the Trash has no portable restore. Free of runes so `bun test` covers it.

export type FileStep = {
	/** What the step did, for the status bar ("Undo Rename"). */
	label: string;
	undo: () => Promise<void>;
	redo: () => Promise<void>;
};

export const UNDO_STEPS = 50;

export class FileUndo {
	#past: FileStep[] = [];
	#future: FileStep[] = [];
	#busy = false;
	readonly max: number;

	constructor(max = UNDO_STEPS) {
		this.max = max;
	}

	get canUndo() {
		return this.#past.length > 0;
	}

	get canRedo() {
		return this.#future.length > 0;
	}

	/** A new step: the oldest falls off past `max`, and anything undone can no longer be redone. */
	push(step: FileStep) {
		this.#past.push(step);
		if (this.#past.length > this.max) this.#past.shift();
		this.#future = [];
	}

	/** Reverses the latest step; resolves to its label, or null with nothing to undo (or one
	 * already running). A step that fails is dropped: the files no longer match it. */
	undo(): Promise<string | null> {
		return this.#step(this.#past, this.#future, 'undo');
	}

	redo(): Promise<string | null> {
		return this.#step(this.#future, this.#past, 'redo');
	}

	clear() {
		this.#past = [];
		this.#future = [];
	}

	async #step(from: FileStep[], to: FileStep[], how: 'undo' | 'redo'): Promise<string | null> {
		if (this.#busy) return null;
		const step = from.pop();
		if (!step) return null;
		this.#busy = true;
		try {
			await step[how]();
			to.push(step);
			return step.label;
		} finally {
			this.#busy = false;
		}
	}
}
