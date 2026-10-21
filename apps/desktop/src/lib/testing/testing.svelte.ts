// The Testing service (VS Code: ITestService + the Test Explorer's run/debug commands, without
// extensions): finds the tests of every project in the folder (cargo, bun, vitest, jest, go,
// pytest), runs them in a test terminal and reads the results as they stream or from the
// runner's report, debugs one through the debugger, and keeps the results for the Testing view,
// the editor gutter and the failure peek.

import { invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { debug } from '#lib/debug/debug.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { shellFrom, shellPlatform } from '#lib/settings/mappings.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { killPty } from '#lib/terminal/pty.ts';
import { focusTerminal, tapOutput, type TaskSpawn } from '#lib/terminal/registry.ts';
import { terminals } from '#lib/terminal/terminals.svelte.ts';
import { TaskOutput, formatMessageForTerminal } from '#lib/tasks/taskOutput.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import {
	cargoPackageName,
	goModule,
	goTests,
	isJsTestFile,
	isPythonTestFile,
	jsRunnerFor,
	jsTests,
	parseCargoList,
	parseGoList,
	parsePytestCollect,
	pytestDeclared,
	pythonTests,
	rustTarget,
	rustTests
} from './discover.ts';
import { addDynamic, ancestors, countBadge, fileItem, findItem, keepDynamic, leaves, projectItems, RUNNER_LABELS, stateOf, summary, testAt, testsInFile, walk, type Declared, type Runner, type TestItem, type TestMessage, type TestResult, type TestState } from './model.ts';
import { mergeCoverage, parseGoCoverProfile, parseLcov, type FileCoverage } from './coverage.ts';
import { CargoParser, GoParser, parseJestJson, parseJunit, type TestEvent } from './results.ts';
import { cargoBinaryName, cargoName, cargoTestExecutable, debugConfig, joinRel, relTo, runPlans, shellLine, type RunPlan } from './runners.ts';

type BuildResult = { success: boolean; output: string };
/** The failure peek (VS Code: the testing output peek) open in an editor. */
export type Peek = { rel: string; line: number; itemId: string; index: number };

const dirOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
/** The nearest directory at or above `rel`'s directory that is in `dirs`. */
function nearest(rel: string, dirs: ReadonlySet<string>): string | null {
	let d = dirOf(rel);
	for (;;) {
		if (dirs.has(d)) return d;
		if (!d) return null;
		d = dirOf(d);
	}
}

const SKIP_DIR = /(^|\/)(node_modules|target|\.git|dist|build|vendor|\.venv|venv|__pycache__)\//;

class Testing {
	/** The test tree: one node per runner and project. */
	items = $state.raw<TestItem[]>([]);
	results = $state.raw<ReadonlyMap<string, TestResult>>(new Map());
	running = $state(false);
	discovering = $state(false);
	peek = $state.raw<Peek | null>(null);
	/** Rows to reveal in the view (testing.followRunningTest). */
	revealId = $state<string | null>(null);
	/** The open coverage (VS Code: the Test Coverage view and editor decorations), by file. */
	coverage = $state.raw<ReadonlyMap<string, FileCoverage> | null>(null);
	/** Toggle Inline Coverage: covered and uncovered lines are shaded, not only marked in the gutter. */
	coverageInline = $state(false);
	root = '';

	badge = $derived(countBadge(this.results, settings.get<string>('testing.countBadge')));
	totals = $derived(summary(this.results));

	#files = new Map<string, TestItem>();
	#fileSet = new Set<string>();
	#lastRun: { ids: string[]; debug: boolean; coverage?: boolean } | null = null;
	/** Whether a project has its runner's coverage tool, asked once per folder. */
	#coverageTools = new Map<string, Promise<boolean>>();
	#cancel: (() => void) | null = null;
	#pendingResults: Map<string, TestResult> | null = null;
	#loaded: Promise<void> | null = null;

	reset() {
		this.#files.clear();
		this.#fileSet.clear();
		this.items = [];
		this.results = new Map();
		this.peek = null;
		this.coverage = null;
		this.#coverageTools.clear();
		this.#lastRun = null;
		this.#loaded = null;
		this.#terminalFor.clear();
		this.#lastTerminal = null;
		this.root = '';
	}

	/** Discovery runs once the view (or a test command) needs it, then follows file changes. */
	ensureLoaded(): Promise<void> {
		this.#loaded ??= this.refresh(false);
		return this.#loaded;
	}

	// --- Discovery -----------------------------------------------------------------------------

	/** testing.refreshTests: reads every test file again; `collect` also asks cargo, go and pytest for their listings. */
	async refresh(collect = true): Promise<void> {
		const info = await invoke<{ workspace: string }>('app_info').catch(() => ({ workspace: '' }));
		this.root = info.workspace;
		if (!this.root) return;
		this.discovering = true;
		try {
			const files = await invoke<string[]>('fs_list_files').catch(() => [] as string[]);
			this.#fileSet = new Set(files);
			this.#dirCache.clear();
			this.#files.clear();
			const candidates = files.filter((f) => !SKIP_DIR.test(f) && this.#isCandidate(f));
			for (let i = 0; i < candidates.length; i += 24) await Promise.all(candidates.slice(i, i + 24).map((f) => this.#scan(f)));
			this.#publish();
			if (collect) await this.#collect();
			else void this.#collect(['pytest']);
		} finally {
			this.discovering = false;
		}
	}

	#isCandidate(rel: string): boolean {
		return isJsTestFile(rel) || (rel.endsWith('.rs') && this.#cargoDirs().size > 0) || rel.endsWith('_test.go') || isPythonTestFile(rel);
	}

	/** Directories holding a file called `name` (Cargo.toml, go.mod, package.json…), cached until the file list changes. */
	#dirCache = new Map<string, Set<string>>();
	#dirsWith(name: string): Set<string> {
		let out = this.#dirCache.get(name);
		if (!out) {
			out = new Set<string>();
			for (const f of this.#fileSet) if (f === name || f.endsWith(`/${name}`)) out.add(dirOf(f));
			this.#dirCache.set(name, out);
		}
		return out;
	}
	#cargoDirs = () => this.#dirsWith('Cargo.toml');

	async #read(rel: string): Promise<string | null> {
		return invoke<string>('read_workspace_file', { rel }).catch(() => null);
	}

	/** Re-reads one file's tests (a save, a watcher change). */
	async #scan(rel: string): Promise<void> {
		const text = await this.#read(rel);
		if (text === null) {
			this.#files.delete(rel);
			return;
		}
		const item = await this.#itemFor(rel, text);
		// Tests found by earlier runs (test.each cases, subtests) stay under the rescanned file.
		const kept = item ? keepDynamic(item, this.#files.get(rel)) : null;
		if (kept && kept.children.length) this.#files.set(rel, kept);
		else this.#files.delete(rel);
	}

	async #itemFor(rel: string, text: string): Promise<TestItem | null> {
		if (rel.endsWith('.rs')) {
			if (!/#\s*\[\s*(?:\w+\s*::\s*)*(?:test|rstest)\b/.test(text)) return null;
			const crateDir = nearest(rel, this.#cargoDirs());
			if (crateDir === null) return null;
			const toml = (await this.#read(joinRel(crateDir, 'Cargo.toml'))) ?? '';
			const pkg = cargoPackageName(toml);
			if (!pkg) return null;
			const target = rustTarget(relTo(crateDir, rel), this.#fileSet.has(joinRel(crateDir, 'src/lib.rs')), pkg);
			if (!target) return null;
			const declared: Declared[] = [];
			for (const t of rustTests(text)) {
				// Modules become suites (rust-analyzer's test explorer shows them nested).
				let list = declared;
				for (const m of t.path.slice(0, -1)) {
					let s = list.find((d) => d.kind === 'suite' && d.name === m);
					if (!s) list.push((s = { name: m, line: t.line, kind: 'suite', children: [] }));
					list = s.children;
				}
				list.push({ name: t.path[t.path.length - 1], line: t.line, kind: 'test', children: [] });
			}
			// A suite's line is its first test's: find the `mod` line instead when it is there.
			const lines = text.split('\n');
			const fixLines = (ds: Declared[]) =>
				ds.forEach((d) => {
					if (d.kind === 'suite') {
						const at = lines.findIndex((l) => new RegExp(`^\\s*(pub(\\([^)]*\\))?\\s+)?mod\\s+${d.name}\\s*\\{`).test(l));
						if (at >= 0) d.line = at + 1;
						fixLines(d.children);
					}
				});
			fixLines(declared);
			return fileItem('cargo', crateDir, rel, declared, { crate: pkg, target: target.target, prefix: target.prefix.join('::') });
		}
		if (rel.endsWith('_test.go')) {
			const modDir = nearest(rel, this.#dirsWith('go.mod'));
			if (modDir === null) return null;
			const mod = goModule((await this.#read(joinRel(modDir, 'go.mod'))) ?? '') ?? '';
			const inner = dirOf(rel);
			const dir = modDir ? (inner === modDir ? '.' : relTo(modDir, inner)) : inner || '.';
			const importPath = dir === '.' ? mod : `${mod}/${dir}`;
			return fileItem('go', modDir, rel, goTests(text), { dir, importPath });
		}
		if (isPythonTestFile(rel)) {
			const roots = new Set([...['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'].flatMap((n) => [...this.#dirsWith(n)])]);
			const project = nearest(rel, roots) ?? '';
			return fileItem('pytest', project, rel, pythonTests(text));
		}
		if (isJsTestFile(rel)) {
			const pkgDirs = this.#dirsWith('package.json');
			const project = nearest(rel, pkgDirs) ?? '';
			const pkg = await this.#read(joinRel(project, 'package.json'));
			const bunLock = [...this.#dirsWith('bun.lock'), ...this.#dirsWith('bun.lockb')].some((d) => d === project || !d || project.startsWith(`${d}/`));
			const runner = jsRunnerFor(text, pkg, bunLock);
			if (!runner) return null;
			return fileItem(runner, project, rel, jsTests(text));
		}
		return null;
	}

	/** The listings (`cargo test -- --list`, `go test -list .`, `pytest --collect-only -q`): tests the
	 * text scan can't see (macros, parametrized cases) are added. */
	async #collect(only?: Runner[]) {
		const projects = new Map<string, Runner>();
		for (const f of this.#files.values()) projects.set(`${f.runner}|${f.project}`, f.runner);
		for (const [key, runner] of projects) {
			if (only && !only.includes(runner)) continue;
			const project = key.slice(key.indexOf('|') + 1);
			try {
				if (runner === 'pytest') await this.#collectPytest(project);
				else if (runner === 'cargo') await this.#collectCargo(project);
				else if (runner === 'go') await this.#collectGo(project);
			} catch (e) {
				clientLog('info', `test collect ${runner} ${project}: ${e}`);
			}
		}
		this.#publish();
	}

	async #run(argv: string[], cwd: string): Promise<BuildResult> {
		return invoke<BuildResult>('testing_collect', { argv, cwd: cwd || null });
	}

	#python(project: string): string {
		for (const v of ['.venv/bin/python', 'venv/bin/python']) if (this.#fileSet.has(joinRel(project, v))) return `${this.root}/${joinRel(project, v)}`;
		return 'python3';
	}

	async #collectPytest(project: string) {
		const res = await this.#run([this.#python(project), '-m', 'pytest', '--collect-only', '-q'], project);
		const ids = parsePytestCollect(res.output);
		if (!ids.length) return;
		const byFile = new Map<string, string[]>();
		for (const id of ids) {
			const file = joinRel(project, id.slice(0, id.indexOf('::')));
			byFile.set(file, [...(byFile.get(file) ?? []), id]);
		}
		for (const [rel, list] of byFile) {
			const text = await this.#read(rel);
			this.#files.set(rel, fileItem('pytest', project, rel, pytestDeclared(list, text)));
		}
	}

	async #collectCargo(project: string) {
		const res = await this.#run(['cargo', 'test', '--', '--list', '--format', 'terse'], project);
		const known = new Set<string>();
		for (const f of this.#files.values()) if (f.runner === 'cargo') walk([f], (i) => i.kind === 'test' && known.add(`${cargoBinaryName(i.meta?.crate ?? '', i.meta?.target ?? 'lib')}|${cargoName(i)}`));
		for (const bin of parseCargoList(res.output)) {
			const missing = bin.tests.filter((n) => !known.has(`${bin.crate}|${n}`));
			if (!missing.length) continue;
			// Tests the text scan did not find (macro-generated): listed under their binary, without a location.
			const rel = joinRel(project, bin.source);
			const any = [...this.#files.values()].find((f) => f.runner === 'cargo' && f.project === project);
			const crate = any?.meta?.crate ?? bin.crate;
			const target = bin.source === 'src/lib.rs' ? 'lib' : bin.source.startsWith('tests/') ? `test:${bin.source.slice(6).replace(/(\/main)?\.rs$/, '')}` : `bin:${bin.crate}`;
			const existing = this.#files.get(rel);
			const extra = fileItem('cargo', project, rel, missing.map((n) => ({ name: n, line: 0, kind: 'test' as const, children: [] })), { crate, target, prefix: '' });
			for (const c of extra.children) c.line = undefined;
			this.#files.set(rel, existing ? { ...existing, children: [...existing.children, ...extra.children] } : extra);
		}
	}

	async #collectGo(project: string) {
		const res = await this.#run(['go', 'test', '-list', '.', './...'], project);
		for (const [importPath, names] of parseGoList(res.output)) {
			const files = [...this.#files.values()].filter((f) => f.runner === 'go' && f.project === project && f.meta?.importPath === importPath);
			if (!files.length) continue;
			const have = new Set(files.flatMap(leaves).map((l) => l.label));
			const missing = names.filter((n) => !have.has(n) && !n.startsWith('Benchmark'));
			if (!missing.length) continue;
			// Tests go lists that no file scan found (generated, build-tagged): under the package's first file, without a line.
			const f = files[0];
			const extra = fileItem('go', project, f.rel ?? '', missing.map((n) => ({ name: n, line: 0, kind: 'test' as const, children: [] })), f.meta);
			for (const c of extra.children) c.line = undefined;
			this.#files.set(f.rel ?? '', { ...f, children: [...f.children, ...extra.children] });
		}
	}

	#publish() {
		this.items = projectItems([...this.#files.values()]);
	}

	/** A test file changed on disk (or was saved): its tests are read again. */
	async fileChanged(rels: readonly string[]) {
		if (!this.#loaded || !this.root) return;
		let changed = false;
		for (const rel of rels) {
			if (SKIP_DIR.test(rel)) continue;
			if (!this.#fileSet.has(rel)) {
				this.#fileSet.add(rel);
				this.#dirCache.clear();
			}
			if (!this.#isCandidate(rel) && !this.#files.has(rel)) continue;
			await this.#scan(rel);
			changed = true;
		}
		if (changed) this.#publish();
	}

	// --- Lookup ----------------------------------------------------------------------------------

	stateOf(item: TestItem): TestState {
		return stateOf(item, this.results);
	}

	testsInFile(rel: string): TestItem[] {
		return testsInFile(this.items, rel);
	}

	find(id: string): TestItem | undefined {
		return findItem(this.items, id);
	}

	/** Failure messages located in `rel` (the editor's message decorations). */
	messagesIn(rel: string): { item: TestItem; message: TestMessage; index: number }[] {
		const out: { item: TestItem; message: TestMessage; index: number }[] = [];
		for (const [id, r] of this.results) {
			if (r.state !== 'failed' && r.state !== 'errored') continue;
			const item = this.find(id);
			if (!item) continue;
			r.messages.forEach((m, index) => {
				const at = m.location ?? (item.rel && item.line ? { rel: item.rel, line: item.line } : undefined);
				if (at?.rel === rel) out.push({ item, message: { ...m, location: at }, index });
			});
		}
		return out;
	}

	// --- Running ---------------------------------------------------------------------------------

	#set(id: string, result: TestResult) {
		const next = this.#pendingResults ?? new Map(this.results);
		next.set(id, result);
		if (!this.#pendingResults) {
			this.#pendingResults = next;
			setTimeout(() => {
				if (this.#pendingResults) this.results = this.#pendingResults;
				this.#pendingResults = null;
			}, 30);
		}
	}

	#flushResults() {
		if (this.#pendingResults) this.results = this.#pendingResults;
		this.#pendingResults = null;
	}

	/** Runs (or with `debug`, debugs; with `coverage`, runs with coverage) tests: any mix of projects, files, suites and tests. */
	async run(selected: readonly TestItem[], { debug: asDebug = false, coverage = false } = {}) {
		if (!selected.length) return status.flash(t('testing.noTests'));
		if (this.running) return status.flash(t('testing.alreadyRunning'));
		this.#lastRun = { ids: selected.map((s) => s.id), debug: asDebug, coverage };
		// testing.saveBeforeTest
		if (settings.get<boolean>('testing.saveBeforeTest')) {
			const { saveFile } = await import('#lib/workbench/editorModels.ts');
			for (const p of editors.dirtyPaths()) await saveFile(p, 'explicit');
		}
		if (asDebug) return this.#debug(selected[0]);
		const open = settings.get<string>('testing.automaticallyOpenTestResults');
		if (open === 'openExplorerOnTestStart') {
			layout.sideView = 'testing';
			layout.sidebarVisible = true;
		}
		const reports = await Promise.all(Array.from({ length: (selected.length + 4) * (coverage ? 2 : 1) }, () => invoke<string>('testing_report_new').catch(() => '')));
		let r = 0;
		const covered = coverage ? await this.#coverageSupport(selected) : null;
		const covDirs = coverage ? await Promise.all(Array.from({ length: selected.length + 4 }, () => invoke<string>('testing_coverage_new').catch(() => ''))) : [];
		let d = 0;
		const plans = runPlans(selected, {
			report: () => reports[r++] ?? '',
			python: (p) => this.#python(p),
			...(covered ? { coverage: { file: () => reports[r++] ?? '', dir: () => covDirs[d++] ?? '', supports: (runner: Runner, project: string) => covered.has(`${runner}|${project}`) } } : {})
		});
		// Directories no plan took are removed.
		for (const dir of covDirs.slice(d)) if (dir) void invoke('testing_coverage_take', { path: dir }).catch(() => {});
		if (covered) this.#warnNoCoverageTool(selected, covered);
		const runCoverage: FileCoverage[] = [];
		for (const p of plans) for (const tst of p.tests) this.#set(tst.id, { state: 'queued', messages: [] });
		this.#flushResults();
		this.running = true;
		let cancelled = false;
		this.#cancel = () => (cancelled = true);
		let failures = 0;
		try {
			for (const plan of plans) {
				if (cancelled) break;
				failures += await this.#runPlan(plan, open, () => cancelled, runCoverage);
			}
		} finally {
			this.running = false;
			this.#cancel = null;
			// Whatever is still queued did not run.
			for (const [id, res] of this.results) if (res.state === 'queued' || res.state === 'running') this.#set(id, { state: 'unset', messages: [] });
			this.#flushResults();
		}
		const s = this.totals;
		status.flash(t('testing.done', { passed: s.passed, failed: s.failed, skipped: s.skipped }));
		if (coverage) {
			if (runCoverage.length) {
				this.coverage = new Map(mergeCoverage(runCoverage).map((f) => [f.rel, f]));
				layout.sideView = 'testing';
				layout.sidebarVisible = true;
			} else if (!cancelled) notifications.info(t('testing.coverage.none'));
		}
		if (failures) this.#afterFailures();
	}

	/** The runners and projects of `selected` that can run with coverage (`runner|project`). */
	async #coverageSupport(selected: readonly TestItem[]): Promise<Set<string>> {
		const keys = new Set(selected.map((i) => `${i.runner}|${i.project}`));
		const out = new Set<string>();
		await Promise.all(
			[...keys].map(async (key) => {
				const [runner, project] = key.split('|') as [Runner, string];
				let probe = this.#coverageTools.get(key);
				if (!probe) this.#coverageTools.set(key, (probe = this.#probeCoverage(runner, project)));
				if (await probe) out.add(key);
			})
		);
		return out;
	}

	/** Whether the project has the coverage tool its runner needs; nothing is ever installed. */
	async #probeCoverage(runner: Runner, project: string): Promise<boolean> {
		const ok = (argv: string[]) => this.#run(argv, project).then((r) => r.success).catch(() => false);
		switch (runner) {
			case 'cargo':
				return ok(['cargo', 'llvm-cov', '--version']);
			case 'pytest':
				return ok([this.#python(project), '-c', 'import pytest_cov']);
			case 'vitest': {
				// Without a provider vitest offers to install one: only offer coverage when one is there.
				for (let dir: string | null = project; dir !== null; dir = dir ? dirOf(dir) : null)
					for (const provider of ['@vitest/coverage-v8', '@vitest/coverage-istanbul'])
						if ((await this.#read(joinRel(dir, `node_modules/${provider}/package.json`))) !== null) return true;
				return false;
			}
			default:
				// bun and jest have coverage built in; go's cover profile is part of `go test`.
				return true;
		}
	}

	#warnNoCoverageTool(selected: readonly TestItem[], covered: ReadonlySet<string>) {
		const tools: Partial<Record<Runner, string>> = { cargo: 'cargo-llvm-cov', pytest: 'pytest-cov', vitest: '@vitest/coverage-v8' };
		const missing = [...new Set(selected.filter((i) => !covered.has(`${i.runner}|${i.project}`) && tools[i.runner]).map((i) => i.runner))];
		for (const runner of missing) notifications.info(t('testing.coverage.needsTool', { runner: RUNNER_LABELS[runner], tool: tools[runner]! }));
	}

	/** A plan's coverage output, read once, as workspace files. */
	async #readCoverage(plan: RunPlan): Promise<FileCoverage[]> {
		const out = plan.coverage;
		if (!out?.path) return [];
		const text = await invoke<string | null>(out.dir ? 'testing_coverage_take' : 'testing_report_take', { path: out.path }).catch((e) => {
			clientLog('info', `coverage ${plan.runner} ${plan.project || '.'}: ${e}`);
			return null;
		});
		if (!text) return [];
		if (out.format === 'go') return parseGoCoverProfile(text, (p) => this.#goCoverFile(plan.project, p));
		return parseLcov(text, (p) => this.#coverFile(plan.project, p));
	}

	/** An lcov `SF:` path (absolute, or relative to the project) as a workspace file. */
	#coverFile(project: string, path: string): string | null {
		if (path.startsWith('/')) return path.startsWith(`${this.root}/`) ? path.slice(this.root.length + 1) : null;
		const inProject = joinRel(project, path.replace(/^\.\//, ''));
		if (this.#fileSet.has(inProject) || !this.#fileSet.has(path)) return inProject;
		return path;
	}

	/** A cover profile's `<import path>/<file>.go` as a workspace file, through the packages' test files. */
	#goCoverFile(project: string, path: string): string | null {
		const slash = path.lastIndexOf('/');
		const pkg = path.slice(0, slash);
		const base = path.slice(slash + 1);
		for (const f of this.#files.values()) if (f.runner === 'go' && f.project === project && f.meta?.importPath === pkg) return joinRel(dirOf(f.rel ?? ''), base);
		// A package without tests: under the module's root, from any package's import path and directory.
		for (const f of this.#files.values()) {
			if (f.runner !== 'go' || f.project !== project || !f.meta?.importPath) continue;
			const dir = f.meta.dir ?? '.';
			const mod = dir === '.' ? f.meta.importPath : f.meta.importPath.slice(0, -(dir.length + 1));
			if (path.startsWith(`${mod}/`)) return joinRel(project, path.slice(mod.length + 1));
		}
		return null;
	}

	/** One command in a test terminal; resolves with its failures (its coverage goes to `coverage`). */
	#runPlan(plan: RunPlan, open: string, cancelled: () => boolean, coverage: FileCoverage[] = []): Promise<number> {
		return new Promise((resolve) => {
			const cwd = plan.project ? `${this.root}/${plan.project}` : this.root;
			const line = shellLine(plan.argv);
			const shell = shellFrom((id) => settings.get(id), shellPlatform());
			const argv = shell.shell ? [shell.shell, ...shell.args, '-c', line] : [...shell.args, '-c', line];
			const env: Record<string, string> = plan.runner === 'bun' ? { NO_COLOR: '1' } : plan.runner === 'cargo' ? { CARGO_TERM_COLOR: 'always' } : {};
			const spawn: TaskSpawn = {
				argv,
				defaultShell: !shell.shell,
				cwd,
				env,
				echo: formatMessageForTerminal(t('testing.executing', { command: line }), { excludeLeadingNewLine: true }),
				failedPrefix: '',
				failedSuffix: '',
				wait: formatMessageForTerminal(t('testing.terminalDone'))
			};
			const title = t('testing.terminalTitle', { runner: plan.runner, project: plan.project || '.' });
			// One test terminal per runner and project, replaced by the next run (VS Code reuses its test output terminal).
			const slot = `${plan.runner}|${plan.project}`;
			const previous = this.#terminalFor.get(slot);
			const id = terminals.openTask({ title, task: spawn, replace: previous !== undefined && terminals.get(previous) ? previous : undefined });
			this.#terminalFor.set(slot, id);
			this.#lastTerminal = id;
			const key = terminals.key(id);
			if (open === 'openOnTestStart') {
				terminals.active = id;
				layout.showPanel('terminal');
			}
			const parser = plan.parser === 'cargo' ? new CargoParser() : plan.parser === 'go' ? new GoParser() : null;
			const output = new TaskOutput();
			let failures = 0;
			let finished = false;
			const apply = (events: TestEvent[]) => {
				for (const ev of events) failures += this.#apply(plan, ev);
			};
			const finish = async (code: number | undefined) => {
				if (finished) return;
				finished = true;
				clearInterval(poll);
				untap();
				for (const l of output.flush()) apply(parser?.feed(l) ?? []);
				if (parser) apply(parser.end());
				if (plan.report) {
					const text = await invoke<string | null>('testing_report_take', { path: plan.report }).catch(() => null);
					if (text) apply(plan.parser === 'junit' ? parseJunit(text) : parseJestJson(text));
				}
				if (plan.coverage) coverage.push(...(await this.#readCoverage(plan)));
				if (this.#dynamicAdded) {
					this.#dynamicAdded = false;
					this.#publish();
				}
				// A test that got no result: errored when the command failed, else left unrun.
				for (const tst of plan.tests) {
					const res = this.#pendingResults?.get(tst.id) ?? this.results.get(tst.id);
					if (res && (res.state === 'queued' || res.state === 'running')) {
						if (code && !cancelled()) {
							failures++;
							this.#set(tst.id, { state: 'errored', messages: [{ message: t('testing.noResult', { code }) }] });
						} else this.#set(tst.id, { state: 'unset', messages: [] });
					}
				}
				this.#flushResults();
				terminals.endTask(id);
				if (failures && open === 'openOnTestFailure') {
					terminals.active = id;
					layout.showPanel('terminal');
				}
				clientLog('info', `tests ${plan.runner} ${plan.project || '.'}: exit ${code ?? 'cancelled'}, ${failures} failed`);
				resolve(failures);
			};
			const untap = tapOutput(key, (chunk) => {
				const { lines, signals, processExited } = output.feed(chunk);
				for (const l of lines) apply(parser?.feed(l) ?? []);
				for (const s of signals) if (s.kind === 'exit') void finish(s.code);
				if (processExited) void finish(undefined);
			});
			// Cancel: the terminal's process is killed.
			const poll = setInterval(() => {
				if (cancelled() && !finished) {
					killPty(key);
					void finish(undefined);
				}
			}, 200);
		});
	}

	#terminalFor = new Map<string, number>();
	#lastTerminal: number | null = null;

	/** Maps a runner's event to its item and records it; returns 1 for a failure. */
	#apply(plan: RunPlan, ev: TestEvent): number {
		const ids = this.#idsFor(plan, ev);
		if (!ids.length) return 0;
		const messages = (ev.messages ?? []).map((m) => (m.location ? { ...m, location: this.#resolve(plan, m.location) } : m));
		for (const id of ids) {
			this.#set(id, { state: ev.state, duration: ev.duration, messages });
			// testing.followRunningTest / testing.alwaysRevealTestOnStateChange
			if (settings.get<boolean>('testing.followRunningTest') && (settings.get<boolean>('testing.alwaysRevealTestOnStateChange') || ev.state === 'failed' || ev.state === 'running')) this.revealId = id;
		}
		return ev.state === 'failed' || ev.state === 'errored' ? ids.length : 0;
	}

	/** The items an event is about (a package-level error: every requested test of it). */
	#idsFor(plan: RunPlan, ev: TestEvent): string[] {
		switch (plan.runner) {
			case 'cargo':
				return plan.tests.filter((x) => cargoBinaryName(x.meta?.crate ?? '', x.meta?.target ?? 'lib') === ev.scope && cargoName(x) === ev.name).map((x) => x.id);
			case 'go': {
				if (!ev.name) return plan.tests.filter((x) => x.meta?.importPath === ev.scope).map((x) => x.id);
				if (ev.name.includes('/')) {
					// A subtest (`t.Run`): added under its test, in the file that declares it.
					const parts = ev.name.split('/');
					const top = plan.tests.find((x) => x.path[0] === parts[0] && x.path.length === 1 && (!ev.scope || x.meta?.importPath === ev.scope));
					return top?.rel ? this.#dynamic(top.rel, parts) : [];
				}
				return plan.tests.filter((x) => x.label === ev.name && (!ev.scope || x.meta?.importPath === ev.scope)).map((x) => x.id);
			}
			case 'pytest': {
				const file = joinRel(plan.project, ev.file ?? '');
				const dotted = relTo(plan.project, file).replace(/\.py$/, '').replace(/\//g, '.');
				const cls = ev.classname && ev.classname.startsWith(`${dotted}.`) ? ev.classname.slice(dotted.length + 1).split('.') : [];
				const name = ev.path?.[ev.path.length - 1] ?? '';
				const param = name.match(/^([^[]+)\[/);
				const path = [...cls, ...(param ? [param[1], name] : [name])];
				const id = `pytest:${file}::${path.join(' > ')}`;
				const known = this.#known(plan, id);
				return known.length ? known : this.#dynamic(file, path, ev.line);
			}
			default: {
				const file = ev.file?.startsWith('/') ? (ev.file.startsWith(`${this.root}/`) ? ev.file.slice(this.root.length + 1) : ev.file) : joinRel(plan.project, ev.file ?? '');
				if (!ev.path?.length) return ev.state === 'errored' ? plan.tests.filter((x) => x.rel === file).map((x) => x.id) : [];
				const known = this.#known(plan, `${plan.runner}:${file}::${ev.path.join(' > ')}`);
				// `test.each` cases and other names the file scan could not see join the tree.
				return known.length ? known : this.#dynamic(file, ev.path, ev.line);
			}
		}
	}

	#dynamicAdded = false;

	/** Adds a reported test under its (known) file; [] when the file has no tests in the tree. */
	#dynamic(rel: string, path: readonly string[], line?: number): string[] {
		const file = this.#files.get(rel);
		if (!file || !path.length) return [];
		const added = addDynamic(file, path, line);
		if (added.file !== file) {
			this.#files.set(rel, added.file);
			this.#dynamicAdded = true;
		}
		return [added.id];
	}

	#known(plan: RunPlan, id: string): string[] {
		return plan.tests.some((x) => x.id === id) || this.find(id) ? [id] : [];
	}

	/** A failure location as the runner printed it, as a workspace file when it is one. */
	#resolve(plan: RunPlan, at: { rel: string; line: number; column?: number }) {
		const file = at.rel;
		const candidates = file.startsWith('/')
			? [file.startsWith(`${this.root}/`) ? file.slice(this.root.length + 1) : '']
			: [joinRel(plan.project, file), file, ...plan.tests.map((x) => joinRel(dirOf(x.rel ?? ''), file))];
		const rel = candidates.find((c) => c && this.#fileSet.has(c)) ?? candidates[0] ?? file;
		return { ...at, rel };
	}

	/** testing.automaticallyOpenPeekView after a run with failures. */
	#afterFailures() {
		const when = settings.get<string>('testing.automaticallyOpenPeekView');
		if (when === 'never') return;
		for (const [id, r] of this.results) {
			if (r.state !== 'failed' && r.state !== 'errored') continue;
			const item = this.find(id);
			const at = r.messages[0]?.location ?? (item?.rel && item.line ? { rel: item.rel, line: item.line } : null);
			if (!item || !at) continue;
			const visible = editors.tabs.some((tab) => tab.path === at.rel);
			if (when === 'failureInVisibleDocument' && !visible) continue;
			this.openPeek(id, 0);
			return;
		}
	}

	/** Shows a failure's message in the editor at its location (VS Code: Peek Output / the error peek). */
	openPeek(id: string, index = 0) {
		const item = this.find(id);
		const r = this.results.get(id);
		const m = r?.messages[index];
		const at = m?.location ?? (item?.rel && item.line ? { rel: item.rel, line: item.line } : null);
		if (!item || !at) return;
		this.peek = { rel: at.rel, line: at.line, itemId: id, index };
		editors.open(at.rel, { preview: false, reveal: { line: at.line, column: at.column ?? 1, focus: true } });
	}

	closePeek() {
		this.peek = null;
	}

	async #debug(item: TestItem) {
		const made = debugConfig(item, this.root);
		if (!made) return status.flash(t('testing.noDebug', { runner: item.runner }));
		let config = made.config;
		if (made.build) {
			const res = await this.#run(made.build, item.project).catch((e) => ({ success: false, output: String(e) }));
			const exe = res.success ? cargoTestExecutable(res.output, item.meta?.crate ?? '', item.meta?.target ?? 'lib') : null;
			if (!exe) return notifications.error(t('testing.buildFailed', { command: made.build.join(' ') }));
			config = { ...config, program: exe };
		}
		await debug.startConfig(config);
	}

	cancel() {
		this.#cancel?.();
	}

	clearResults() {
		this.results = new Map();
		this.peek = null;
	}

	// --- Commands ------------------------------------------------------------------------------

	async runAll(asDebug = false, coverage = false) {
		await this.ensureLoaded();
		if (asDebug) return status.flash(t('testing.debugOne'));
		await this.run(this.items, { coverage });
	}

	async runAtCursor(asDebug = false, coverage = false) {
		await this.ensureLoaded();
		const rel = editors.active;
		const item = rel ? testAt(this.items, rel, editors.cursor.line) : undefined;
		if (!item) return status.flash(t('testing.noTestAtCursor'));
		await this.run([item], { debug: asDebug, coverage });
	}

	async runCurrentFile(asDebug = false, coverage = false) {
		await this.ensureLoaded();
		const rel = editors.active;
		const file = rel ? this.#files.get(rel) : undefined;
		const item = file ? this.find(file.id) : undefined;
		if (!item) return status.flash(t('testing.noTestsInFile'));
		await this.run([item], { debug: asDebug, coverage });
	}

	async reRunLast(asDebug?: boolean, coverage?: boolean) {
		const last = this.#lastRun;
		if (!last) return status.flash(t('testing.noLastRun'));
		const items = last.ids.map((id) => this.find(id)).filter((x): x is TestItem => !!x);
		await this.run(items, { debug: asDebug ?? last.debug, coverage: coverage ?? (asDebug === undefined && !!last.coverage) });
	}

	/** Clear Coverage (testing.coverage.close). */
	closeCoverage() {
		this.coverage = null;
	}

	/** Go to Next / Previous Uncovered Line in the active editor (wrapping). */
	gotoMissedLine(next: boolean) {
		const rel = editors.active;
		const f = rel ? this.coverage?.get(rel) : undefined;
		if (!rel || !f) return status.flash(t('testing.coverage.noneInFile'));
		const missed = [...f.lines].filter(([, h]) => h === 0).map(([l]) => l).sort((a, b) => a - b);
		if (!missed.length) return status.flash(t('testing.coverage.allCovered'));
		const line = editors.cursor.line;
		const target = next ? (missed.find((l) => l > line) ?? missed[0]) : ([...missed].reverse().find((l) => l < line) ?? missed[missed.length - 1]);
		editors.openAt(rel, target);
	}

	async reRunFailed() {
		const failed = [...this.results].filter(([, r]) => r.state === 'failed' || r.state === 'errored').map(([id]) => this.find(id)).filter((x): x is TestItem => !!x && x.kind === 'test');
		if (!failed.length) return status.flash(t('testing.noFailed'));
		await this.run(failed);
	}

	/** testing.showMostRecentOutput: the last test terminal. */
	showOutput() {
		const last = this.#lastTerminal;
		if (last === null || !terminals.get(last)) return status.flash(t('testing.noOutput'));
		terminals.active = last;
		layout.showPanel('terminal');
		focusTerminal(terminals.key(last));
	}

	/** The parents of an item, for expanding the view to it. */
	ancestorsOf(id: string): TestItem[] {
		return ancestors(this.items, id);
	}
}

export const testing = new Testing();

/** Commands and keys (VS Code's testing ids and default keybindings). Returns the uninstaller. */
export function installTesting(): () => void {
	const unFiles = workspace.onFilesChanged((files) => void testing.fileChanged(files));
	// Open Folder: the old folder's tests and results go.
	let lastRoot: string | null | undefined;
	const unRoot = $effect.root(() => {
		$effect(() => {
			const root = workspace.root;
			if (lastRoot !== undefined && root !== lastRoot) testing.reset();
			lastRoot = root;
		});
	});
	const ide = { scope: 'ide' as const };
	const unregister = [
		commands.register({ id: 'workbench.view.testing', title: 'Show Testing', category: 'View', ...ide, run: () => ((layout.sideView = 'testing'), (layout.sidebarVisible = true), void testing.ensureLoaded()) }),
		commands.register({ id: 'testing.runAll', title: 'Run All Tests', category: 'Test', key: 'cmd+; a', ...ide, run: () => testing.runAll() }),
		commands.register({ id: 'testing.debugAll', title: 'Debug All Tests', category: 'Test', key: 'cmd+; cmd+a', ...ide, run: () => testing.runAll(true) }),
		commands.register({ id: 'testing.runAtCursor', title: 'Run Test at Cursor', category: 'Test', key: 'cmd+; c', ...ide, run: () => testing.runAtCursor() }),
		commands.register({ id: 'testing.debugAtCursor', title: 'Debug Test at Cursor', category: 'Test', key: 'cmd+; cmd+c', ...ide, run: () => testing.runAtCursor(true) }),
		commands.register({ id: 'testing.runCurrentFile', title: 'Run Tests in Current File', category: 'Test', key: 'cmd+; f', ...ide, run: () => testing.runCurrentFile() }),
		commands.register({ id: 'testing.debugCurrentFile', title: 'Debug Tests in Current File', category: 'Test', key: 'cmd+; cmd+f', ...ide, run: () => testing.runCurrentFile(true) }),
		commands.register({ id: 'testing.reRunLastRun', title: 'Rerun Last Run', category: 'Test', key: 'cmd+; l', ...ide, run: () => testing.reRunLast(false) }),
		commands.register({ id: 'testing.debugLastRun', title: 'Debug Last Run', category: 'Test', key: 'cmd+; cmd+l', ...ide, run: () => testing.reRunLast(true) }),
		commands.register({ id: 'testing.reRunFailTests', title: 'Rerun Failed Tests', category: 'Test', key: 'cmd+; e', ...ide, run: () => testing.reRunFailed() }),
		commands.register({ id: 'testing.cancelRun', title: 'Cancel Test Run', category: 'Test', key: 'cmd+; cmd+x', ...ide, when: () => testing.running, run: () => testing.cancel() }),
		commands.register({ id: 'testing.showMostRecentOutput', title: 'Show Output', category: 'Test', key: 'cmd+; cmd+o', ...ide, run: () => testing.showOutput() }),
		commands.register({ id: 'testing.refreshTests', title: 'Refresh Tests', category: 'Test', key: 'cmd+; cmd+r', ...ide, run: () => testing.refresh(true) }),
		commands.register({ id: 'testing.clearTestResults', title: 'Clear All Results', category: 'Test', ...ide, run: () => testing.clearResults() }),
		// Coverage (VS Code's coverage run profile commands and keys).
		commands.register({ id: 'testing.coverageAll', title: 'Run All Tests with Coverage', category: 'Test', key: 'cmd+; cmd+shift+a', ...ide, run: () => testing.runAll(false, true) }),
		commands.register({ id: 'testing.coverageAtCursor', title: 'Run Test at Cursor with Coverage', category: 'Test', key: 'cmd+; cmd+shift+c', ...ide, run: () => testing.runAtCursor(false, true) }),
		commands.register({ id: 'testing.coverageCurrentFile', title: 'Run Tests with Coverage in Current File', category: 'Test', key: 'cmd+; cmd+shift+f', ...ide, run: () => testing.runCurrentFile(false, true) }),
		commands.register({ id: 'testing.coverageLastRun', title: 'Rerun Last Run with Coverage', category: 'Test', key: 'cmd+; cmd+shift+l', ...ide, run: () => testing.reRunLast(false, true) }),
		commands.register({ id: 'testing.coverage.close', title: 'Clear Coverage', category: 'Test', ...ide, when: () => testing.coverage !== null, run: () => testing.closeCoverage() }),
		commands.register({ id: 'testing.toggleInlineCoverage', title: 'Toggle Inline Coverage', category: 'Test', key: 'cmd+; cmd+shift+i', ...ide, when: () => testing.coverage !== null, run: () => (testing.coverageInline = !testing.coverageInline) }),
		commands.register({ id: 'testing.coverage.goToNextMissedLine', title: 'Go to Next Uncovered Line', category: 'Test', key: 'alt+f9', ...ide, when: () => testing.coverage !== null, run: () => testing.gotoMissedLine(true) }),
		commands.register({ id: 'testing.coverage.goToPreviousMissedLine', title: 'Go to Previous Uncovered Line', category: 'Test', key: 'alt+shift+f9', ...ide, when: () => testing.coverage !== null, run: () => testing.gotoMissedLine(false) })
	];
	return () => {
		unFiles();
		unRoot();
		unregister.forEach((u) => u());
	};
}
