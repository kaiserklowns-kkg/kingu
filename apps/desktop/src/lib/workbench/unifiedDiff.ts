// Unified diff (`git diff`) → files, hunks and numbered lines, for the combined diff view
// (Orca's CombinedDiffViewer). Pure, so it is unit-testable.

export type DiffLine = { kind: 'add' | 'del' | 'ctx'; text: string; old: number | null; new: number | null };
export type DiffHunk = { header: string; lines: DiffLine[] };
export type DiffFile = {
	path: string;
	oldPath: string | null;
	status: 'added' | 'deleted' | 'renamed' | 'modified';
	binary: boolean;
	hunks: DiffHunk[];
	added: number;
	deleted: number;
};

const unquote = (p: string) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p);

export function parseUnifiedDiff(text: string): { files: DiffFile[]; truncated: boolean } {
	const files: DiffFile[] = [];
	let file: DiffFile | null = null;
	let hunk: DiffHunk | null = null;
	let o = 0;
	let n = 0;
	let truncated = false;
	for (const line of text.split('\n')) {
		if (line.startsWith('diff --git ')) {
			const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
			const path = unquote(m?.[2] ?? line.slice(11));
			file = { path, oldPath: null, status: 'modified', binary: false, hunks: [], added: 0, deleted: 0 };
			files.push(file);
			hunk = null;
		} else if (line === '\\ kingu: diff truncated') truncated = true;
		else if (!file) continue;
		else if (line.startsWith('new file mode')) file.status = 'added';
		else if (line.startsWith('deleted file mode')) file.status = 'deleted';
		else if (line.startsWith('rename from ')) (file.status = 'renamed'), (file.oldPath = unquote(line.slice(12)));
		else if (line.startsWith('Binary files ')) file.binary = true;
		else if (line.startsWith('@@')) {
			const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			o = Number(m?.[1] ?? 0);
			n = Number(m?.[2] ?? 0);
			hunk = { header: line, lines: [] };
			file.hunks.push(hunk);
		} else if (!hunk || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
		else if (line.startsWith('+')) hunk.lines.push({ kind: 'add', text: line.slice(1), old: null, new: n++ }), file.added++;
		else if (line.startsWith('-')) hunk.lines.push({ kind: 'del', text: line.slice(1), old: o++, new: null }), file.deleted++;
		else if (line.startsWith(' ')) hunk.lines.push({ kind: 'ctx', text: line.slice(1), old: o++, new: n++ });
	}
	return { files, truncated };
}
