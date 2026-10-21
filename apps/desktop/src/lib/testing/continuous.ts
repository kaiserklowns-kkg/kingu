// Continuous run (VS Code: Start Continuous Run / Turn on Continuous Run for a test): the watched
// tests run again when a file they depend on is saved. Without a language-level dependency graph
// Kingu takes the runner's view: a saved test file reruns its own watched tests, any other file
// reruns the watched tests of the project (package.json / Cargo.toml / go.mod directory) it is in.
// Pure, so which tests a save reruns is unit-tested.

import { findItem, leaves, walk, type TestItem } from './model.ts';

/** Watching every test (the toolbar's Continuous Run, not one test's). */
export const ALL = '*';

const inProject = (rel: string, project: string) => !project || rel === project || rel.startsWith(`${project}/`);

/** The watched items (ALL: every project). Unknown ids (a test since deleted) are left out. */
export function watchedItems(items: readonly TestItem[], watched: ReadonlySet<string>): TestItem[] {
	if (watched.has(ALL)) return [...items];
	return [...watched].map((id) => findItem(items, id)).filter((x): x is TestItem => !!x);
}

/**
 * What saving `changed` files reruns: for each watched item, the test files among them it holds
 * (or itself, a test of one of them), else, for a file of its project that is not a test file,
 * the whole watched item. Items under another item already chosen are dropped.
 */
export function affectedTests(items: readonly TestItem[], watched: ReadonlySet<string>, changed: readonly string[]): TestItem[] {
	const out: TestItem[] = [];
	const testFiles = new Set<string>();
	walk(items, (i) => i.kind === 'test' && i.rel && testFiles.add(i.rel));
	for (const root of watchedItems(items, watched)) {
		for (const rel of changed) {
			if (testFiles.has(rel)) {
				// A test file: only what of it is watched.
				if (root.rel === rel) out.push(root);
				else walk([root], (i) => i.kind === 'file' && i.rel === rel && out.push(i));
			} else if (inProject(rel, root.project)) out.push(root);
		}
	}
	// One run per item, and none for an item inside another being run.
	const unique = out.filter((i, n) => out.findIndex((x) => x.id === i.id) === n);
	return unique.filter((i) => !unique.some((p) => p.id !== i.id && contains(p, i)));
}

function contains(parent: TestItem, item: TestItem): boolean {
	return parent.children.some((c) => c.id === item.id || contains(c, item));
}

/** Whether an item is watched, itself or through an ancestor (ALL watches everything). */
export function isWatched(watched: ReadonlySet<string>, item: TestItem, ancestors: readonly TestItem[]): boolean {
	return watched.has(ALL) || watched.has(item.id) || ancestors.some((a) => watched.has(a.id));
}

/** Turn on / off continuous run for an item (ALL for every test). */
export function toggleWatched(watched: ReadonlySet<string>, id: string): Set<string> {
	const next = new Set(watched);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return next;
}

/** How many tests a run of these items covers (the auto run's status text). */
export const testCount = (items: readonly TestItem[]) => items.reduce((n, i) => n + leaves(i).length, 0);
