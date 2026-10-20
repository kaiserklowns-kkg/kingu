// The Test Explorer's model (VS Code: ITestItem trees from test controllers, TestResultState):
// the tests per runner as a tree (project → file → suite → test), the results of a run, and how a
// parent's state rolls up from its children. Pure, so the tree building and states are unit-tested.

/** The test frameworks Kingu runs without extensions. */
export type Runner = 'cargo' | 'bun' | 'vitest' | 'jest' | 'go' | 'pytest';
export const RUNNER_LABELS: Record<Runner, string> = { cargo: 'Cargo', bun: 'Bun', vitest: 'Vitest', jest: 'Jest', go: 'Go', pytest: 'pytest' };

export type TestKind = 'project' | 'file' | 'suite' | 'test';

export type TestItem = {
	/** Unique in the workspace: runner, project and the names down to this item. */
	id: string;
	runner: Runner;
	kind: TestKind;
	label: string;
	/** The project (package.json / Cargo.toml / go.mod directory), workspace-relative; '' is the root. */
	project: string;
	/** The file, workspace-relative (files, suites and tests). */
	rel?: string;
	/** 1-based line of the declaration. */
	line?: number;
	/** Names from the file (exclusive) down to this item: describe blocks and the test; Rust module path. */
	path: string[];
	/** Runner-specific: Rust `crate` (package) and `target` (lib, bin:x, test:x); Go `pkg` dir; pytest `nodeid`. */
	meta?: Record<string, string>;
	children: TestItem[];
};

export type TestState = 'unset' | 'queued' | 'running' | 'passed' | 'failed' | 'errored' | 'skipped';

export type TestLocation = { rel: string; line: number; column?: number };
export type TestMessage = { message: string; expected?: string; actual?: string; location?: TestLocation };
export type TestResult = { state: TestState; duration?: number; messages: TestMessage[] };

/** VS Code's statePriority: the state a parent shows is its most important child's. */
const PRIORITY: Record<TestState, number> = { unset: 0, skipped: 1, passed: 2, queued: 3, running: 4, failed: 5, errored: 6 };

export const worse = (a: TestState, b: TestState): TestState => (PRIORITY[b] > PRIORITY[a] ? b : a);

/** A node's state: its own result for a test, else the roll-up of its children. */
export function stateOf(item: TestItem, results: ReadonlyMap<string, TestResult>): TestState {
	const own = results.get(item.id)?.state;
	if (item.kind === 'test' || !item.children.length) return own ?? 'unset';
	let s: TestState = 'unset';
	for (const c of item.children) s = worse(s, stateOf(c, results));
	// A parent whose children all passed or were skipped shows passed (VS Code shows the same).
	return own && PRIORITY[own] > PRIORITY[s] ? own : s;
}

/** Every test (leaf) under `item`, itself included when it is one. */
export function leaves(item: TestItem): TestItem[] {
	return item.kind === 'test' || !item.children.length ? [item] : item.children.flatMap(leaves);
}

export function walk(items: readonly TestItem[], fn: (item: TestItem, parents: TestItem[]) => void, parents: TestItem[] = []) {
	for (const i of items) {
		fn(i, parents);
		walk(i.children, fn, [...parents, i]);
	}
}

export function findItem(items: readonly TestItem[], id: string): TestItem | undefined {
	let found: TestItem | undefined;
	walk(items, (i) => {
		if (!found && i.id === id) found = i;
	});
	return found;
}

/** The ancestors of `id` (outermost first), for revealing it. */
export function ancestors(items: readonly TestItem[], id: string): TestItem[] {
	let out: TestItem[] = [];
	walk(items, (i, parents) => {
		if (i.id === id) out = parents;
	});
	return out;
}

/** The tests declared in a file, for the gutter. */
export function testsInFile(items: readonly TestItem[], rel: string): TestItem[] {
	const out: TestItem[] = [];
	walk(items, (i) => {
		if (i.rel === rel && i.line && (i.kind === 'test' || i.kind === 'suite')) out.push(i);
	});
	return out;
}

/** The innermost test or suite whose declaration is at or above `line` in `rel` (Run Test at Cursor). */
export function testAt(items: readonly TestItem[], rel: string, line: number): TestItem | undefined {
	const inFile = testsInFile(items, rel).filter((i) => (i.line ?? 0) <= line);
	inFile.sort((a, b) => (b.line ?? 0) - (a.line ?? 0) || b.path.length - a.path.length);
	return inFile[0];
}

/** The `testing.countBadge` number. */
export function countBadge(results: ReadonlyMap<string, TestResult>, setting: string): number {
	if (setting === 'off') return 0;
	const want: TestState = setting === 'passed' ? 'passed' : setting === 'skipped' ? 'skipped' : 'failed';
	let n = 0;
	for (const r of results.values()) if (r.state === want || (want === 'failed' && r.state === 'errored')) n++;
	return n;
}

/** Totals of the last run, for the view's summary line. */
export function summary(results: ReadonlyMap<string, TestResult>): { passed: number; failed: number; skipped: number; total: number } {
	let passed = 0;
	let failed = 0;
	let skipped = 0;
	for (const r of results.values()) {
		if (r.state === 'passed') passed++;
		else if (r.state === 'failed' || r.state === 'errored') failed++;
		else if (r.state === 'skipped') skipped++;
	}
	return { passed, failed, skipped, total: passed + failed + skipped };
}

/** A declaration found in a file: a suite with children, or a test. */
export type Declared = { name: string; line: number; kind: 'suite' | 'test'; children: Declared[] };

/** The items of one file under its project: suites and tests with ids from the names. */
export function fileItem(runner: Runner, project: string, rel: string, declared: Declared[], meta?: Record<string, string>): TestItem {
	const fileId = `${runner}:${rel}`;
	const build = (d: Declared, path: string[]): TestItem => {
		const p = [...path, d.name];
		return { id: `${fileId}::${p.join(' > ')}`, runner, kind: d.kind, label: d.name, project, rel, line: d.line, path: p, meta, children: d.children.map((c) => build(c, p)) };
	};
	const base = rel.slice(rel.lastIndexOf('/') + 1);
	return { id: fileId, runner, kind: 'file', label: base, project, rel, path: [], meta, children: declared.map((d) => build(d, [])) };
}

/** Files grouped under one node per runner and project (VS Code shows one root per controller). */
export function projectItems(files: readonly TestItem[]): TestItem[] {
	const groups = new Map<string, TestItem>();
	for (const f of files) {
		const key = `${f.runner}:${f.project}`;
		let g = groups.get(key);
		if (!g) {
			const name = f.project ? `${RUNNER_LABELS[f.runner]} · ${f.project}` : RUNNER_LABELS[f.runner];
			g = { id: `${f.runner}:project:${f.project}`, runner: f.runner, kind: 'project', label: name, project: f.project, path: [], meta: f.meta, children: [] };
			groups.set(key, g);
		}
		g.children.push(f);
	}
	for (const g of groups.values()) g.children.sort((a, b) => (a.rel ?? a.label).localeCompare(b.rel ?? b.label));
	return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// --- Dynamic tests ------------------------------------------------------------------------------

/** Whether an item came from a runner's report rather than the file (test.each cases, Go subtests…). */
export const isDynamic = (item: TestItem) => item.meta?.dynamic === '1';

/**
 * Adds a test a runner reported that the file scan could not see (`test.each` with interpolated
 * names, a parametrized case, a Go subtest) under `file` at `path`; missing parents become suites.
 * Returns the file with it and the test's id (the file itself when the test is already there).
 */
export function addDynamic(file: TestItem, path: readonly string[], line?: number): { file: TestItem; id: string } {
	const fileId = file.id;
	const id = `${fileId}::${path.join(' > ')}`;
	if (!path.length) return { file, id: fileId };
	const insert = (children: TestItem[], depth: number): TestItem[] => {
		const name = path[depth];
		const p = path.slice(0, depth + 1);
		const at = children.findIndex((c) => c.label === name && c.path.length === p.length);
		const last = depth === path.length - 1;
		if (at >= 0) {
			if (last) return children;
			const c = children[at];
			const inner = insert(c.children, depth + 1);
			return inner === c.children ? children : children.map((x, i) => (i === at ? { ...c, children: inner } : x));
		}
		const meta = { ...(file.meta ?? {}), dynamic: '1' };
		const node: TestItem = { id: `${fileId}::${p.join(' > ')}`, runner: file.runner, kind: last ? 'test' : 'suite', label: name, project: file.project, rel: file.rel, ...(line ? { line } : {}), path: p, meta, children: [] };
		return [...children, last ? node : { ...node, children: insert([], depth + 1) }];
	};
	const children = insert(file.children, 0);
	return { file: children === file.children ? file : { ...file, children }, id };
}

/** A rescanned file keeps the tests earlier runs added, where their parents still exist. */
export function keepDynamic(next: TestItem, previous: TestItem | undefined): TestItem {
	if (!previous) return next;
	let out = next;
	walk([previous], (i, parents) => {
		if (!isDynamic(i) || i.kind !== 'test') return;
		const staticParent = [...parents].reverse().find((p) => !isDynamic(p) && p.kind !== 'file');
		if (staticParent && !findItem([out], staticParent.id)) return;
		out = addDynamic(out, i.path, i.line).file;
	});
	return out;
}
