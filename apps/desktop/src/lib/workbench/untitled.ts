// Untitled editors (VS Code: UntitledTextEditorService). A tab key `untitled:Untitled-1` names
// an in-memory buffer with no file; its first save asks for a path (Save As). Pure.

export const UNTITLED_PREFIX = 'untitled:';

export const isUntitled = (key: string) => key.startsWith(UNTITLED_PREFIX);

/** The display name of an untitled key (`Untitled-1`). */
export const untitledName = (key: string) => key.slice(UNTITLED_PREFIX.length);

/** VS Code's naming: the lowest `Untitled-N` not already open. */
export function nextUntitledKey(open: Iterable<string>): string {
	const used = new Set<number>();
	for (const key of open) {
		const m = /^untitled:Untitled-(\d+)$/.exec(key);
		if (m) used.add(Number(m[1]));
	}
	let n = 1;
	while (used.has(n)) n++;
	return `${UNTITLED_PREFIX}Untitled-${n}`;
}

/** Save As's suggested file name: the first line of text (VS Code's untitled title), else `Untitled-1.txt`. */
export function suggestedName(key: string, text: string): string {
	const first = text
		.split(/\r?\n/, 1)[0]
		.trim()
		.replace(/[\\/:*?"<>|]+/g, '')
		.slice(0, 40)
		.trim();
	return first || (isUntitled(key) ? `${untitledName(key)}.txt` : key.slice(key.lastIndexOf('/') + 1));
}
