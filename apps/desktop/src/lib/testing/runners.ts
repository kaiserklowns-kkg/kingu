// How each runner is asked to run or debug a set of tests (VS Code: a test controller's run
// profiles): the command per project, the report it writes, and the launch configuration for
// debugging one test. Pure, so every command line is unit-tested.

import type { LaunchConfig } from '#lib/debug/launch.ts';
import { leaves, type Runner, type TestItem } from './model.ts';

export type Parser = 'cargo' | 'go' | 'junit' | 'jest';

/** Where a run with coverage writes it: an lcov file, a directory holding `lcov.info`, or Go's cover profile. */
export type CoverageOutput = { format: 'lcov' | 'go'; path: string; dir: boolean };

/** One command of a run: in `cwd` (workspace-relative project dir), reading results with `parser`. */
export type RunPlan = { runner: Runner; project: string; argv: string[]; parser: Parser; report?: string; coverage?: CoverageOutput; tests: TestItem[] };

/** Joins workspace-relative parts ('' is the root). */
export const joinRel = (...parts: string[]) => parts.filter(Boolean).join('/');
/** `rel` relative to `dir` (both workspace-relative). */
export const relTo = (dir: string, rel: string) => (dir && rel.startsWith(`${dir}/`) ? rel.slice(dir.length + 1) : rel);

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** A test's name for libtest's filter: the module path in the crate, then its own path. */
export function cargoName(item: TestItem): string {
	const prefix = item.meta?.prefix ? item.meta.prefix.split('::') : [];
	return [...prefix, ...item.path].join('::');
}

/** The target flag of a Rust test target (`lib`, `bin:x`, `test:x`). */
export function cargoTargetArgs(target: string): string[] {
	if (target === 'lib') return ['--lib'];
	const [kind, name] = target.split(':');
	return kind === 'bin' ? ['--bin', name] : kind === 'test' ? ['--test', name] : [];
}

/** The crate name libtest binaries are named after (the Running line): `-` becomes `_`. */
export function cargoBinaryName(pkg: string, target: string): string {
	const name = target === 'lib' ? pkg : target.split(':')[1] ?? pkg;
	return name.replace(/-/g, '_');
}

/** VS Code's test name pattern for jest/vitest/bun `-t`: names joined by spaces, anchored. */
export function namePattern(items: readonly TestItem[]): string | null {
	if (!items.length || items.some((i) => !i.path.length)) return null;
	const alts = [...new Set(items.map((i) => escapeRegex(i.path.join(' ')) + (i.kind === 'test' ? '$' : '')))];
	return alts.length === 1 ? `^${alts[0]}` : `^(?:${alts.join('|')})`;
}

/** The pytest node id of an item (`tests/test_a.py::TestB::test_c[1]`), from its project. */
export function pytestNodeId(item: TestItem): string {
	const file = relTo(item.project, item.rel ?? '');
	// A parametrized test's own name already carries the function name (`test_c[1]`).
	const path = item.path.length >= 2 && /\[.*\]$/.test(item.path[item.path.length - 1]) ? [...item.path.slice(0, -2), item.path[item.path.length - 1]] : item.path;
	return [file, ...path].join('::');
}

type PlanOptions = {
	/** A report path per plan that writes one (jest/vitest JSON, bun/pytest JUnit). */
	report: () => string;
	/** The Python to run pytest with (the project's .venv, else python3). */
	python?: (project: string) => string;
	/** Run with Coverage: fresh output paths, and whether the project has the runner's coverage tool
	 * (cargo-llvm-cov, pytest-cov, a vitest coverage provider); without one the plan runs plain. */
	coverage?: { file: () => string; dir: () => string; supports: (runner: Runner, project: string) => boolean };
};

/**
 * The commands that run `selected` (any mix of projects, files, suites and tests), grouped as each
 * runner wants: one cargo command per crate target, one go command per package, one per project
 * for the others.
 */
export function runPlans(selected: readonly TestItem[], opts: PlanOptions): RunPlan[] {
	const plans: RunPlan[] = [];
	const byKey = new Map<string, TestItem[]>();
	const add = (key: string, item: TestItem) => byKey.set(key, [...(byKey.get(key) ?? []), item]);
	for (const item of selected) {
		if (item.runner === 'cargo') {
			if (item.kind === 'project') add(`cargo|${item.project}|*`, item);
			else for (const leaf of leaves(item)) add(`cargo|${leaf.project}|${leaf.meta?.target ?? 'lib'}`, leaf);
		} else if (item.runner === 'go') {
			if (item.kind === 'project') add(`go|${item.project}|*`, item);
			else for (const leaf of leaves(item)) add(`go|${leaf.project}|${leaf.meta?.dir ?? '.'}`, leaf);
		} else add(`${item.runner}|${item.project}`, item);
	}
	for (const [key, items] of byKey) {
		const [runner, project, part] = key.split('|') as [Runner, string, string?];
		const tests = items.flatMap(leaves);
		const whole = items.some((i) => i.kind === 'project');
		switch (runner) {
			case 'cargo': {
				const pkg = items[0].meta?.crate;
				const p = pkg ? ['-p', pkg] : [];
				// cargo-llvm-cov takes `cargo test`'s arguments after `llvm-cov`.
				const cov = opts.coverage?.supports(runner, project) ? { format: 'lcov' as const, path: opts.coverage.file(), dir: false } : undefined;
				const test = cov ? ['cargo', 'llvm-cov'] : ['cargo', 'test'];
				const out = cov ? ['--lcov', '--output-path', cov.path] : [];
				const argv = whole || part === '*' ? [...test, ...p, '--no-fail-fast', ...out] : [...test, ...p, ...cargoTargetArgs(part ?? 'lib'), ...out, '--', '--exact', ...tests.map(cargoName)];
				plans.push({ runner, project, argv, parser: 'cargo', tests, ...(cov ? { coverage: cov } : {}) });
				break;
			}
			case 'go': {
				const cov = opts.coverage ? { format: 'go' as const, path: opts.coverage.file(), dir: false } : undefined;
				const profile = cov ? [`-coverprofile=${cov.path}`] : [];
				const withCov = cov ? { coverage: cov } : {};
				if (whole || part === '*') plans.push({ runner, project, argv: ['go', 'test', '-v', ...profile, './...'], parser: 'go', tests, ...withCov });
				else {
					// A subtest (`TestA/case`, found from a run) runs with its top-level test.
					const names = [...new Set(tests.map((t) => escapeRegex(t.path[0] ?? t.label)))];
					plans.push({ runner, project, argv: ['go', 'test', '-v', ...profile, '-run', `^(${names.join('|')})$`, part === '.' ? '.' : `./${part}`], parser: 'go', tests, ...withCov });
				}
				break;
			}
			case 'pytest': {
				const report = opts.report();
				const ids = whole ? [] : [...new Set(items.filter((i) => i.kind !== 'project').map((i) => (i.kind === 'file' ? relTo(project, i.rel ?? '') : pytestNodeId(i))))];
				const cov = opts.coverage?.supports(runner, project) ? { format: 'lcov' as const, path: opts.coverage.file(), dir: false } : undefined;
				const covArgs = cov ? ['--cov', `--cov-report=lcov:${cov.path}`] : [];
				plans.push({ runner, project, argv: [opts.python?.(project) ?? 'python3', '-m', 'pytest', '-v', '--tb=short', '-o', 'junit_family=xunit1', `--junitxml=${report}`, ...covArgs, ...ids], parser: 'junit', report, tests, ...(cov ? { coverage: cov } : {}) });
				break;
			}
			default: {
				// bun, vitest, jest: the files, narrowed by a name pattern when not whole files.
				const report = opts.report();
				const files = whole ? [] : [...new Set(items.map((i) => relTo(project, i.rel ?? '')).filter(Boolean))];
				const named = items.filter((i) => i.kind === 'suite' || i.kind === 'test');
				const pattern = !whole && named.length === items.length ? namePattern(named) : null;
				const t = pattern ? ['-t', pattern] : [];
				// Coverage as lcov into a fresh directory (`<dir>/lcov.info`): bun and jest have it built in,
				// vitest only with a coverage provider installed in the project (it would offer to install one).
				const cov = opts.coverage?.supports(runner, project) ? { format: 'lcov' as const, path: opts.coverage.dir(), dir: true } : undefined;
				const covArgs = !cov
					? []
					: runner === 'bun'
						? ['--coverage', '--coverage-reporter=lcov', `--coverage-dir=${cov.path}`]
						: runner === 'vitest'
							? ['--coverage.enabled=true', '--coverage.reporter=lcov', `--coverage.reportsDirectory=${cov.path}`]
							: ['--coverage', '--coverageReporters=lcov', `--coverageDirectory=${cov.path}`];
				const argv =
					runner === 'bun'
						? ['bun', 'test', '--reporter=junit', `--reporter-outfile=${report}`, ...covArgs, ...files.map((f) => `./${f}`), ...t]
						: runner === 'vitest'
							? ['npx', 'vitest', 'run', ...files, ...t, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`, ...covArgs]
							: ['npx', 'jest', ...files, ...t, '--json', `--outputFile=${report}`, '--testLocationInResults', ...covArgs];
				plans.push({ runner, project, argv, parser: runner === 'bun' ? 'junit' : 'jest', report, tests, ...(cov ? { coverage: cov } : {}) });
			}
		}
	}
	return plans;
}

/** A shell command line for `argv` (each word quoted when it needs to be). */
export function shellLine(argv: readonly string[]): string {
	return argv.map((a) => (/^[\w@%+=:,./^-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

// --- Debugging one test ----------------------------------------------------------------------------

/** `cargo test --no-run --message-format=json` output: the test executable built for `target`. */
export function cargoTestExecutable(output: string, pkg: string, target: string): string | null {
	const want = target === 'lib' ? { kind: 'lib', name: pkg.replace(/-/g, '_') } : { kind: target.split(':')[0], name: target.split(':')[1] };
	for (const line of output.split('\n')) {
		if (!line.startsWith('{')) continue;
		let msg: { reason?: string; executable?: string | null; profile?: { test?: boolean }; target?: { kind?: string[]; name?: string } };
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}
		if (msg.reason !== 'compiler-artifact' || !msg.executable || !msg.profile?.test) continue;
		const kinds = msg.target?.kind ?? [];
		const kindOk = want.kind === 'lib' ? kinds.some((k) => k === 'lib' || k === 'rlib' || k === 'proc-macro' || k === 'cdylib' || k === 'staticlib') : kinds.includes(want.kind);
		if (kindOk && (msg.target?.name ?? '').replace(/-/g, '_') === want.name.replace(/-/g, '_')) return msg.executable;
	}
	return null;
}

/**
 * The launch configuration that debugs one test (VS Code: a controller's Debug profile): lldb on the
 * libtest binary (`build` gives the cargo command that builds it), Delve's test mode, debugpy
 * running pytest, js-debug running vitest or jest. Bun has no DAP debugger: null.
 */
export function debugConfig(item: TestItem, root: string): { config: LaunchConfig; build?: string[] } | null {
	const abs = (rel: string) => (rel ? `${root}/${rel}` : root);
	const name = `Debug Test: ${item.label}`;
	switch (item.runner) {
		case 'cargo': {
			const target = item.meta?.target ?? 'lib';
			const pkg = item.meta?.crate ?? '';
			const filter = item.kind === 'test' ? [cargoName(item), '--exact'] : item.kind === 'suite' ? [cargoName(item)] : [];
			return {
				config: { type: 'lldb', request: 'launch', name, program: '', args: [...filter, '--nocapture'], cwd: abs(item.project) },
				build: ['cargo', 'test', '--no-run', ...(pkg ? ['-p', pkg] : []), ...cargoTargetArgs(target), '--message-format=json']
			};
		}
		case 'go': {
			const dir = item.meta?.dir ?? '.';
			const run = item.kind === 'test' ? ['-test.run', `^${escapeRegex(item.label)}$`] : [];
			return { config: { type: 'go', request: 'launch', name, mode: 'test', program: abs(joinRel(item.project, dir === '.' ? '' : dir)), args: [...run, '-test.v'] } };
		}
		case 'pytest': {
			const id = item.kind === 'file' ? relTo(item.project, item.rel ?? '') : item.kind === 'project' ? '' : pytestNodeId(item);
			return { config: { type: 'debugpy', request: 'launch', name, module: 'pytest', args: [...(id ? [id] : []), '-q'], cwd: abs(item.project), console: 'internalConsole', justMyCode: false } };
		}
		case 'vitest':
		case 'jest': {
			const file = item.rel ? relTo(item.project, item.rel) : '';
			const pattern = item.kind === 'suite' || item.kind === 'test' ? namePattern([item]) : null;
			const t = pattern ? ['-t', pattern] : [];
			const program = item.runner === 'vitest' ? abs(joinRel(item.project, 'node_modules/vitest/vitest.mjs')) : abs(joinRel(item.project, 'node_modules/jest/bin/jest.js'));
			const args = item.runner === 'vitest' ? ['run', ...(file ? [file] : []), ...t] : [...(file ? [file] : []), ...t, '--runInBand'];
			return { config: { type: 'node', request: 'launch', name, program, args, cwd: abs(item.project), autoAttachChildProcesses: true, skipFiles: ['<node_internals>/**'], console: 'internalConsole' } };
		}
		default:
			return null;
	}
}
