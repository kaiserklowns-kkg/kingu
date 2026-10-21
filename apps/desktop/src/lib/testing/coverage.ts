// Test coverage (VS Code: testCoverage.ts, codeCoverageDisplayUtils.ts, the Test Coverage view):
// what a run with coverage reports per file, read from the runners' own formats (lcov from bun,
// jest, vitest, cargo-llvm-cov and pytest-cov; Go's cover profile), the percentages and colors
// the view and the editor show (`testing.displayedCoveragePercent`, `testing.coverageBarThresholds`)
// and the folder tree of the Test Coverage view. Pure.

export type CoverageCount = { covered: number; total: number };

export type FileCoverage = {
	/** Workspace-relative. */
	rel: string;
	/** Execution count per 1-based line that has a statement. */
	lines: Map<number, number>;
	/** Lines with a branch that was never taken (VS Code's missing-branch indicator). */
	missedBranches: Set<number>;
	statement: CoverageCount;
	branch?: CoverageCount;
	/** Functions (VS Code's declaration coverage). */
	declaration?: CoverageCount;
};

export type CoverageSource = Pick<FileCoverage, 'statement' | 'branch' | 'declaration'>;

/** Maps a path as the runner printed it to a workspace-relative file (null: not in the folder). */
export type PathResolver = (path: string) => string | null;

const count = (covered: number, total: number): CoverageCount => ({ covered, total });

/** An lcov tracefile (`SF:`, `DA:`, `FN:`/`FNDA:`, `BRDA:`, `end_of_record`). */
export function parseLcov(text: string, resolve: PathResolver): FileCoverage[] {
	const out: FileCoverage[] = [];
	let rel: string | null = null;
	let lines = new Map<number, number>();
	let missed = new Set<number>();
	let fns = new Map<string, number>();
	let branches = { covered: 0, total: 0 };
	let any = false;
	const flush = () => {
		if (rel !== null && any) {
			let covered = 0;
			for (const hits of lines.values()) if (hits > 0) covered++;
			let fnCovered = 0;
			for (const hits of fns.values()) if (hits > 0) fnCovered++;
			out.push({
				rel,
				lines,
				missedBranches: missed,
				statement: count(covered, lines.size),
				...(branches.total ? { branch: count(branches.covered, branches.total) } : {}),
				...(fns.size ? { declaration: count(fnCovered, fns.size) } : {})
			});
		}
		rel = null;
		lines = new Map();
		missed = new Set();
		fns = new Map();
		branches = { covered: 0, total: 0 };
		any = false;
	};
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		const colon = line.indexOf(':');
		const tag = colon > 0 ? line.slice(0, colon) : line;
		const value = colon > 0 ? line.slice(colon + 1) : '';
		switch (tag) {
			case 'SF':
				flush();
				rel = resolve(value);
				break;
			case 'DA': {
				const [ln, hits] = value.split(',');
				const n = Number(ln);
				if (!Number.isFinite(n) || n < 1) break;
				lines.set(n, Math.max(lines.get(n) ?? 0, Number(hits) || 0));
				any = true;
				break;
			}
			case 'FN': {
				// FN:<line>[,<end line>],<name>
				const name = value.slice(value.lastIndexOf(',') + 1);
				if (!fns.has(name)) fns.set(name, 0);
				any = true;
				break;
			}
			case 'FNDA': {
				const comma = value.indexOf(',');
				const name = value.slice(comma + 1);
				fns.set(name, Math.max(fns.get(name) ?? 0, Number(value.slice(0, comma)) || 0));
				any = true;
				break;
			}
			case 'BRDA': {
				const parts = value.split(',');
				const taken = parts[3];
				branches.total++;
				if (taken !== '-' && Number(taken) > 0) branches.covered++;
				else missed.add(Number(parts[0]));
				any = true;
				break;
			}
			case 'end_of_record':
				flush();
				break;
		}
	}
	flush();
	return mergeCoverage(out);
}

/**
 * Go's `-coverprofile` (`mode: set|count|atomic`, then `<import path>/<file>:<l>.<c>,<l>.<c> <stmts> <count>`).
 * `resolve` gets `<import path>/<file>`. Statements are counted per block, like `go tool cover`;
 * a line is as covered as the most-run block on it.
 */
export function parseGoCoverProfile(text: string, resolve: PathResolver): FileCoverage[] {
	const files = new Map<string, { lines: Map<number, number>; covered: number; total: number }>();
	for (const raw of text.split('\n')) {
		const m = /^(.+):(\d+)\.\d+,(\d+)\.\d+ (\d+) (\d+)$/.exec(raw.trim());
		if (!m) continue;
		const rel = resolve(m[1]);
		if (!rel) continue;
		let f = files.get(rel);
		if (!f) files.set(rel, (f = { lines: new Map(), covered: 0, total: 0 }));
		const [start, end, stmts, hits] = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
		f.total += stmts;
		if (hits > 0) f.covered += stmts;
		for (let l = start; l <= end; l++) f.lines.set(l, Math.max(f.lines.get(l) ?? 0, hits));
	}
	return [...files].map(([rel, f]) => ({ rel, lines: f.lines, missedBranches: new Set(), statement: count(f.covered, f.total) }));
}

const add = (a: CoverageCount | undefined, b: CoverageCount | undefined): CoverageCount | undefined => (a || b ? count((a?.covered ?? 0) + (b?.covered ?? 0), (a?.total ?? 0) + (b?.total ?? 0)) : undefined);

/** One entry per file; a file two runs (or two lcov records) cover keeps the most hits per line. */
export function mergeCoverage(files: readonly FileCoverage[]): FileCoverage[] {
	const by = new Map<string, FileCoverage>();
	for (const f of files) {
		const prev = by.get(f.rel);
		if (!prev) {
			by.set(f.rel, f);
			continue;
		}
		const lines = new Map(prev.lines);
		for (const [l, h] of f.lines) lines.set(l, Math.max(lines.get(l) ?? 0, h));
		let covered = 0;
		for (const h of lines.values()) if (h > 0) covered++;
		const better = (a: CoverageCount | undefined, b: CoverageCount | undefined) => (!a ? b : !b ? a : a.covered / (a.total || 1) >= b.covered / (b.total || 1) ? a : b);
		by.set(f.rel, {
			rel: f.rel,
			lines,
			missedBranches: new Set([...prev.missedBranches].filter((l) => f.missedBranches.has(l) || !f.lines.has(l))),
			statement: count(covered, lines.size),
			branch: better(prev.branch, f.branch),
			declaration: better(prev.declaration, f.declaration)
		});
	}
	return [...by.values()];
}

// --- Percentages ------------------------------------------------------------------------------

export const percent = (c: CoverageCount) => Math.min(1, Math.max(0, c.total === 0 ? 1 : c.covered / c.total));

/** VS Code's getTotalCoveragePercent: statements, branches and functions together. */
export function totalPercent(c: CoverageSource): number {
	let num = c.statement.covered;
	let den = c.statement.total;
	for (const x of [c.branch, c.declaration]) {
		if (!x) continue;
		num += x.covered;
		den += x.total;
	}
	return den === 0 ? 1 : num / den;
}

export type DisplayedPercent = 'totalCoverage' | 'statement' | 'minimum';

/** `testing.displayedCoveragePercent`. */
export function displayedPercent(c: CoverageSource, method: DisplayedPercent | string): number {
	if (method === 'statement') return percent(c.statement);
	if (method === 'minimum') {
		let v = percent(c.statement);
		if (c.branch) v = Math.min(v, percent(c.branch));
		if (c.declaration) v = Math.min(v, percent(c.declaration));
		return v;
	}
	return totalPercent(c);
}

/** `12.34%`; never a rounded-up 100% for coverage that is not complete (VS Code's displayPercent). */
export function displayPercent(value: number, precision = 2): string {
	const shown = (value * 100).toFixed(precision);
	if (value < 1 - 1e-7 && Number(shown) >= 100) return `${(100 - 10 ** -precision).toFixed(precision)}%`;
	return `${shown}%`;
}

export type Thresholds = { red: number; yellow: number; green: number };
export const DEFAULT_THRESHOLDS: Thresholds = { red: 0, yellow: 60, green: 90 };

/** `testing.coverageBarThresholds`: the color of a percentage (0..1), the closest threshold below it. */
export function coverageColor(pct: number, thresholds: Partial<Thresholds> | null | undefined): 'red' | 'yellow' | 'green' {
	const th = { ...DEFAULT_THRESHOLDS, ...(thresholds && typeof thresholds === 'object' ? thresholds : {}) };
	let best: 'red' | 'yellow' | 'green' = 'red';
	let distance = pct;
	for (const key of ['red', 'yellow', 'green'] as const) {
		const v = Number(th[key]) / 100;
		if (v && pct >= v && pct - v < distance) {
			best = key;
			distance = pct - v;
		}
	}
	return best;
}

// --- The Test Coverage view's tree ---------------------------------------------------------------

export type CoverageNode = CoverageSource & { id: string; label: string; rel: string; kind: 'folder' | 'file'; children: CoverageNode[] };

/** Folders and files with their summed counts; a folder with one child folder is compacted (`src/lib`). */
export function coverageTree(files: readonly FileCoverage[]): CoverageNode[] {
	const root: CoverageNode = { id: '', label: '', rel: '', kind: 'folder', statement: count(0, 0), children: [] };
	for (const f of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
		const parts = f.rel.split('/');
		let node = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const rel = parts.slice(0, i + 1).join('/');
			let next = node.children.find((c) => c.kind === 'folder' && c.rel === rel);
			if (!next) node.children.push((next = { id: `d:${rel}`, label: parts[i], rel, kind: 'folder', statement: count(0, 0), children: [] }));
			node = next;
		}
		node.children.push({ id: `f:${f.rel}`, label: parts[parts.length - 1], rel: f.rel, kind: 'file', statement: f.statement, branch: f.branch, declaration: f.declaration, children: [] });
	}
	const sum = (n: CoverageNode): CoverageNode => {
		if (n.kind === 'file') return n;
		const children = n.children.map(sum).sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'folder' ? -1 : 1));
		let statement: CoverageCount = count(0, 0);
		let branch: CoverageCount | undefined;
		let declaration: CoverageCount | undefined;
		for (const c of children) {
			statement = add(statement, c.statement)!;
			branch = add(branch, c.branch);
			declaration = add(declaration, c.declaration);
		}
		const out: CoverageNode = { ...n, children, statement, branch, declaration };
		if (out.id && children.length === 1 && children[0].kind === 'folder') return { ...children[0], label: `${out.label}/${children[0].label}` };
		return out;
	};
	return sum(root).children;
}

/** The totals of a whole run. */
export function coverageTotals(files: readonly FileCoverage[]): CoverageSource {
	let statement: CoverageCount = count(0, 0);
	let branch: CoverageCount | undefined;
	let declaration: CoverageCount | undefined;
	for (const f of files) {
		statement = add(statement, f.statement)!;
		branch = add(branch, f.branch);
		declaration = add(declaration, f.declaration);
	}
	return { statement, branch, declaration };
}

/** The editor decorations of one file: covered and uncovered lines, and lines with a missed branch. */
export function lineDecorations(f: FileCoverage, lineCount: number): { line: number; kind: 'covered' | 'uncovered' | 'partial' }[] {
	const out: { line: number; kind: 'covered' | 'uncovered' | 'partial' }[] = [];
	for (const [line, hits] of [...f.lines].sort((a, b) => a[0] - b[0])) {
		if (line > lineCount) continue;
		out.push({ line, kind: hits === 0 ? 'uncovered' : f.missedBranches.has(line) ? 'partial' : 'covered' });
	}
	return out;
}

/** `testing.showCoverageInExplorer`: the coverage of every covered file and of each folder above one. */
export function explorerCoverage(files: readonly FileCoverage[]): Map<string, CoverageSource> {
	const out = new Map<string, CoverageSource>();
	for (const f of files) {
		out.set(f.rel, f);
		const parts = f.rel.split('/');
		for (let i = 1; i < parts.length; i++) {
			const dir = parts.slice(0, i).join('/');
			const prev = out.get(dir);
			out.set(dir, prev ? { statement: add(prev.statement, f.statement)!, branch: add(prev.branch, f.branch), declaration: add(prev.declaration, f.declaration) } : { statement: f.statement, branch: f.branch, declaration: f.declaration });
		}
	}
	return out;
}
