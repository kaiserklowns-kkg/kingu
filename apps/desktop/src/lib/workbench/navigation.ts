// Editor navigation history (VS Code: EditorNavigationStack behind Go Back / Go Forward).
// Pure, so it is unit-testable; navigation.svelte.ts wires it to the editors.
//
// Every cursor position of the active editor is offered to `record`. A position within
// NEARBY_LINES of the current entry in the same file replaces it (typing, arrow keys and small
// scrolls keep one entry up to date); a file switch or a larger jump (Go to Line, Go to Definition,
// a search result) adds an entry and drops the forward entries, like a browser.

export type Location = { path: string; line: number; column: number };

export const NEARBY_LINES = 10;
export const MAX_ENTRIES = 50;

export class NavigationHistory {
	#stack: Location[] = [];
	#index = -1;

	constructor(
		readonly nearby = NEARBY_LINES,
		readonly max = MAX_ENTRIES
	) {}

	get entries(): readonly Location[] {
		return this.#stack;
	}
	get index() {
		return this.#index;
	}
	get current(): Location | null {
		return this.#stack[this.#index] ?? null;
	}
	get canGoBack() {
		return this.#index > 0;
	}
	get canGoForward() {
		return this.#index < this.#stack.length - 1;
	}

	isNear(a: Location, b: Location) {
		return a.path === b.path && Math.abs(a.line - b.line) <= this.nearby;
	}

	/** Returns true when an entry was added (false when the current one was updated). */
	record(loc: Location): boolean {
		const cur = this.current;
		if (cur && this.isNear(cur, loc)) {
			this.#stack[this.#index] = { ...loc };
			return false;
		}
		this.#stack.splice(this.#index + 1);
		this.#stack.push({ ...loc });
		if (this.#stack.length > this.max) this.#stack.splice(0, this.#stack.length - this.max);
		this.#index = this.#stack.length - 1;
		return true;
	}

	/** Moves back and returns the location to show, or null at the start. */
	back(): Location | null {
		if (!this.canGoBack) return null;
		return { ...this.#stack[--this.#index] };
	}

	forward(): Location | null {
		if (!this.canGoForward) return null;
		return { ...this.#stack[++this.#index] };
	}

	/** Drops the entries whose file matches (deleted files, a closed folder). */
	remove(match: (path: string) => boolean) {
		const keep: Location[] = [];
		let index = -1;
		this.#stack.forEach((loc, i) => {
			if (match(loc.path)) return;
			// Two neighbours of one file meeting after a removal collapse into one entry.
			const prev = keep[keep.length - 1];
			if (prev && prev.path === loc.path && Math.abs(prev.line - loc.line) <= this.nearby) {
				if (i <= this.#index) index = keep.length - 1;
				return;
			}
			keep.push(loc);
			if (i <= this.#index) index = keep.length - 1;
		});
		this.#stack = keep;
		this.#index = keep.length ? Math.max(0, index) : -1;
	}

	clear() {
		this.#stack = [];
		this.#index = -1;
	}
}
