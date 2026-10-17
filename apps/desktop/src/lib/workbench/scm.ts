// Pure Source Control helpers (no runes, so they are unit-testable). Shapes mirror Rust `git.rs`.

export type StatusEntry = {
	path: string;
	orig_path: string | null;
	/** git's X letter (staged side), null when unchanged. */
	index: string | null;
	/** git's Y letter (working tree side), `?` when untracked, null when unchanged. */
	worktree: string | null;
	conflict: boolean;
};

export type GitStatus = {
	branch: string | null;
	head: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	entries: StatusEntry[];
};

/** A row in one of the two groups ("Staged Changes" / "Changes"). */
export type Resource = { entry: StatusEntry; staged: boolean; letter: string; color: string; deleted: boolean };

// VS Code gitDecoration.* dark colors.
const COLORS = {
	modified: '#E2C08D',
	added: '#73C991',
	deleted: '#F48771',
	conflict: '#E4676B'
};

/** VS Code's decoration letter and color for a git status code. */
export function decoration(code: string, conflict = false): { letter: string; color: string } {
	if (conflict) return { letter: '!', color: COLORS.conflict };
	switch (code) {
		case '?':
			return { letter: 'U', color: COLORS.added };
		case 'A':
		case 'C':
			return { letter: code, color: COLORS.added };
		case 'R':
			return { letter: 'R', color: COLORS.added };
		case 'D':
			return { letter: 'D', color: COLORS.deleted };
		default:
			return { letter: code === 'T' ? 'T' : 'M', color: COLORS.modified };
	}
}

const byPath = (a: Resource, b: Resource) => a.entry.path.localeCompare(b.entry.path);

/** Splits entries like VS Code: a file staged and then edited again is in both groups. Conflicts go to Changes. */
export function groups(entries: StatusEntry[]): { staged: Resource[]; changes: Resource[] } {
	const staged: Resource[] = [];
	const changes: Resource[] = [];
	for (const entry of entries) {
		if (entry.conflict) {
			changes.push({ entry, staged: false, ...decoration('U', true), deleted: false });
			continue;
		}
		if (entry.index) staged.push({ entry, staged: true, ...decoration(entry.index), deleted: entry.index === 'D' });
		if (entry.worktree) changes.push({ entry, staged: false, ...decoration(entry.worktree), deleted: entry.worktree === 'D' });
	}
	return { staged: staged.sort(byPath), changes: changes.sort(byPath) };
}

/** `src/lib/a.ts` → `['a.ts', 'src/lib']`. */
export function splitPath(path: string): [name: string, dir: string] {
	const i = path.lastIndexOf('/');
	return i < 0 ? [path, ''] : [path.slice(i + 1), path.slice(0, i)];
}

/** Editor tab key for a diff of a workspace file against HEAD. */
export const DIFF_PREFIX = 'diff:';
export const diffKey = (rel: string) => DIFF_PREFIX + rel;
export const isDiffKey = (key: string) => key.startsWith(DIFF_PREFIX);
/** The workspace file behind an editor tab key (itself for plain file tabs). */
export const fileOf = (key: string) => (isDiffKey(key) ? key.slice(DIFF_PREFIX.length) : key);

/** Tab label: `a.ts`, or `a.ts (Working Tree)` for a diff, like VS Code. */
export function tabLabel(key: string): string {
	const [name] = splitPath(fileOf(key));
	return isDiffKey(key) ? `${name} (Working Tree)` : name;
}
