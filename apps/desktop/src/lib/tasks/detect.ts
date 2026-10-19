// Detected tasks (VS Code's task providers): npm scripts of every package.json (extensions/npm
// tasks.ts: `npm: <script>`, `<script> - <folder>` for nested packages, the package manager from
// the lock file like preferred-pm.ts, build/test groups by name, plus `install`), cargo's
// build / check / test / clean / run (rust-analyzer: `rust: cargo build`, $rustc) and go's build /
// test of the package and the workspace (vscode-go: `go: build package`, $go). Pure: the task
// system hands in the files it read.

import { customTask, DEFAULT_PRESENTATION, DEFAULT_RUN_OPTIONS, type CommandString, type Task, type TaskGroup } from './taskConfig.ts';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** preferred-pm.ts order: npm's lock file, then pnpm, yarn, bun; npm when there is none. */
export function packageManagerFor(files: ReadonlySet<string>): PackageManager {
	if (files.has('package-lock.json')) return 'npm';
	if (files.has('pnpm-lock.yaml')) return 'pnpm';
	if (files.has('yarn.lock')) return 'yarn';
	if (files.has('bun.lockb') || files.has('bun.lock')) return 'bun';
	return 'npm';
}

const BUILD_NAMES = ['build', 'compile', 'watch'];
const PRE_POST = new Set(['install', 'pack', 'publish', 'publishOnly', 'restart', 'shrinkwrap', 'stop', 'test', 'uninstall', 'version']);

function npmGroup(script: string): TaskGroup | undefined {
	const name = script.toLowerCase();
	if (BUILD_NAMES.some((b) => name.includes(b))) return { kind: 'build', isDefault: false };
	if (name === 'test') return { kind: 'test', isDefault: false };
	if (PRE_POST.has(name)) return { kind: 'clean', isDefault: false };
	return undefined;
}

/** npm's escapeCommandLine: an argument with white space is quoted (weak when it holds `--`). */
function escapeArg(arg: string): CommandString {
	return /\s/.test(arg) ? { value: arg, quoting: arg.includes('--') ? 'weak' : 'strong' } : arg;
}

function detectedTask(id: string, label: string, source: string, definition: Record<string, unknown>, command: string, args: string[], props: Partial<Task>): Task {
	return {
		...customTask(label, 'shell', {}),
		id,
		label,
		type: String(definition.type),
		source,
		definition,
		runtime: 'shell',
		command,
		args: args.map(escapeArg),
		configured: false,
		presentation: { ...DEFAULT_PRESENTATION },
		runOptions: { ...DEFAULT_RUN_OPTIONS },
		...props
	};
}

/** `npm: build`, or `npm: build - packages/app` for a package.json below the folder root. */
export function npmTask(script: string, dir: string, pm: PackageManager, scriptValue?: string): Task {
	const definition: Record<string, unknown> = { type: 'npm', script };
	if (dir) definition.path = dir;
	const name = dir ? `${script} - ${dir}` : script;
	const args = script === 'install' ? ['install'] : ['run', script];
	return detectedTask(`npm:${dir}:${script}`, `npm: ${name}`, 'npm', definition, pm, args, {
		detail: scriptValue,
		group: script === 'install' ? { kind: 'clean', isDefault: false } : npmGroup(script),
		options: { cwd: dir ? `\${workspaceFolder}/${dir}` : '${workspaceFolder}' }
	});
}

/** The scripts of one package.json (`rel` is its path in the folder), plus `install`. */
export function npmTasks(rel: string, text: string, pm: PackageManager): Task[] {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return [];
	}
	const scripts = (json as { scripts?: unknown })?.scripts;
	const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
	const out: Task[] = [];
	if (scripts && typeof scripts === 'object' && !Array.isArray(scripts))
		for (const [name, value] of Object.entries(scripts)) if (typeof value === 'string') out.push(npmTask(name, dir, pm, value));
	out.push(npmTask('install', dir, pm, 'install dependencies from package'));
	return out;
}

/** package.json files the npm provider reads: not in node_modules (npm.exclude's default). */
export function packageJsonFiles(files: Iterable<string>): string[] {
	return [...files].filter((f) => (f === 'package.json' || f.endsWith('/package.json')) && !f.split('/').includes('node_modules')).sort();
}

const CARGO: { command: string; group?: TaskGroup }[] = [
	{ command: 'build', group: { kind: 'build', isDefault: false } },
	{ command: 'check', group: { kind: 'build', isDefault: false } },
	{ command: 'clippy', group: { kind: 'build', isDefault: false } },
	{ command: 'test', group: { kind: 'test', isDefault: false } },
	{ command: 'clean', group: { kind: 'clean', isDefault: false } },
	{ command: 'run' }
];

/** rust-analyzer's cargo task: `{ type: 'cargo', command, args }`. */
export function cargoTask(command: string, args: string[] = [], group?: TaskGroup): Task {
	const name = ['cargo', command, ...args].join(' ');
	return detectedTask(`cargo:${command}:${args.join(' ')}`, `rust: ${name}`, 'rust', { type: 'cargo', command, ...(args.length ? { args } : {}) }, 'cargo', [command, ...args], {
		group,
		problemMatcher: ['$rustc'],
		runtime: 'process',
		options: { cwd: '${workspaceFolder}' }
	});
}

export function cargoTasks(): Task[] {
	return CARGO.map((c) => cargoTask(c.command, [], c.group));
}

/** vscode-go's tasks: build / test of the active file's package and of the whole workspace. */
export function goTasks(): Task[] {
	const go = (label: string, command: string, target: string, group: TaskGroup) =>
		detectedTask(`go:${label}`, `go: ${label}`, 'go', { type: 'go', command, args: [target] }, 'go', [command, target], {
			group,
			problemMatcher: ['$go'],
			runtime: 'process',
			options: { cwd: '${workspaceFolder}' }
		});
	return [
		go('build package', 'build', '${fileDirname}', { kind: 'build', isDefault: false }),
		go('test package', 'test', '${fileDirname}', { kind: 'test', isDefault: false }),
		go('build workspace', 'build', './...', { kind: 'build', isDefault: false }),
		go('test workspace', 'test', './...', { kind: 'test', isDefault: false })
	];
}

/** The files a detection needs, read by the task system. */
export type DetectInput = {
	/** Workspace-relative paths of the folder's files. */
	files: ReadonlySet<string>;
	read(rel: string): Promise<string | null>;
	/** npm.packageManager-like override; `auto` (default) reads the lock files. */
	packageManager?: string;
};

/** Every detected task of the folder (VS Code: each provider's provideTasks). */
export async function detectTasks(input: DetectInput): Promise<Task[]> {
	const out: Task[] = [];
	const rootFiles = new Set([...input.files].filter((f) => !f.includes('/')));
	const pm = input.packageManager && input.packageManager !== 'auto' ? (input.packageManager as PackageManager) : packageManagerFor(rootFiles);
	for (const rel of packageJsonFiles(input.files).slice(0, 50)) {
		const text = await input.read(rel);
		if (text !== null) out.push(...npmTasks(rel, text, pm));
	}
	if (rootFiles.has('Cargo.toml')) out.push(...cargoTasks());
	if (rootFiles.has('go.mod')) out.push(...goTasks());
	return out;
}

/** A tasks.json identifier of a detected type that detection did not find (autoDetect off, a
 * package.json outside the listed files): the task it describes, when one can be made. */
export function taskFromDefinition(def: Record<string, unknown>, pm: PackageManager): Task | null {
	if (def.type === 'npm' && typeof def.script === 'string') return npmTask(def.script, typeof def.path === 'string' ? def.path.replace(/\/$/, '') : '', pm);
	if (def.type === 'cargo' && typeof def.command === 'string') return cargoTask(def.command, Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === 'string') : []);
	if (def.type === 'go' && typeof def.command === 'string') {
		const args = Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === 'string') : [];
		const t = goTasks().find((g) => g.definition?.command === def.command && JSON.stringify(g.definition?.args) === JSON.stringify(args));
		return t ?? detectedTask(`go:${def.command}:${args.join(' ')}`, `go: ${[def.command, ...args].join(' ')}`, 'go', def, 'go', [def.command, ...args], { problemMatcher: ['$go'], runtime: 'process', options: { cwd: '${workspaceFolder}' } });
	}
	return null;
}
