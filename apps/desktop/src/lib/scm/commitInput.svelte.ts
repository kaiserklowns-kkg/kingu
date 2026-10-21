// The commit input's message history per repository (commitHistory.ts), kept in localStorage so
// it survives a reload, and the ↑/↓ keys of the Source Control input that walk it.

import { addEntry, caretAllows, freshCursor, step, type HistoryCursor } from './commitHistory';

const KEY = 'kingu.scm.commitHistory';

function read(): Record<string, string[]> {
	try {
		const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
		return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
	} catch {
		return {};
	}
}

class CommitHistory {
	#entries: Record<string, string[]> | null = null;
	#cursors = new Map<string, HistoryCursor>();

	#all(): Record<string, string[]> {
		return (this.#entries ??= read());
	}

	entries(repo: string): string[] {
		const list = this.#all()[repo];
		return Array.isArray(list) ? list.filter((e) => typeof e === 'string') : [];
	}

	/** A commit went in with `message`. */
	add(repo: string, message: string) {
		const all = this.#all();
		all[repo] = addEntry(this.entries(repo), message);
		this.#cursors.delete(repo);
		try {
			localStorage.setItem(KEY, JSON.stringify(all));
		} catch {
			// Storage unavailable: the history lasts until the window reloads.
		}
	}

	/** Typing leaves the history: the next ↑ starts from the newest message again. */
	reset(repo: string) {
		this.#cursors.delete(repo);
	}

	/**
	 * ↑/↓ in `input` (the commit message of `repo`): shows the previous or next message and
	 * returns true when it did (the caller prevents the key's default then).
	 */
	key(repo: string, e: KeyboardEvent, input: HTMLTextAreaElement, set: (value: string) => void): boolean {
		if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
		const dir = e.key === 'ArrowUp' ? -1 : 1;
		if (input.selectionStart !== input.selectionEnd || !caretAllows(input.value, input.selectionStart, dir)) return false;
		const moved = step(this.entries(repo), this.#cursors.get(repo) ?? freshCursor(), input.value, dir);
		if (!moved) return false;
		this.#cursors.set(repo, moved.cursor);
		set(moved.value);
		queueMicrotask(() => {
			const at = dir === -1 ? 0 : input.value.length;
			input.setSelectionRange(at, at);
		});
		return true;
	}
}

export const commitHistory = new CommitHistory();
