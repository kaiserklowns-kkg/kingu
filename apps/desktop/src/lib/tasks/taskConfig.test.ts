/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { findTask, globMatch, groupTasks, mergeTasks, parseTasksJson } from './taskConfig.ts';
import { cargoTasks, detectTasks, npmTasks, packageManagerFor, taskFromDefinition } from './detect.ts';
import { addAllArgument, shellCommandLine, taskLaunch } from './commandLine.ts';
import { collectVariables, resolveInputs, substitute, VariableError, type VariableContext } from './variables.ts';
import { TaskOutput, stripAnsi, visibleLine } from './taskOutput.ts';
import { runTask, type Execution, type GraphHost, type Summary } from './dependencies.ts';

const TASKS = `{
	// VS Code tasks.json (JSONC)
	"version": "2.0.0",
	"options": { "env": { "GLOBAL": "1" }, "cwd": "\${workspaceFolder}/global" },
	"presentation": { "panel": "dedicated" },
	"tasks": [
		{
			"label": "build",
			"type": "shell",
			"command": "make",
			"args": ["all", { "value": "a b", "quoting": "escape" }],
			"group": { "kind": "build", "isDefault": true },
			"problemMatcher": "$gcc",
			"options": { "env": { "TASK": "2" } },
			"osx": { "command": "gmake", "args": ["mac"], "options": { "env": { "OS": "mac" } } },
			"linux": { "command": "make-linux" }
		},
		{ "label": "test", "type": "process", "command": "cargo", "args": ["test"], "group": "test", "presentation": { "reveal": "silent", "clear": true } },
		{ "label": "all", "dependsOn": ["build", "test"], "dependsOrder": "sequence" },
		{ "label": "watch", "type": "shell", "command": "tsc -w", "isBackground": true, "problemMatcher": "$tsc-watch", "runOptions": { "runOn": "folderOpen" } },
		{ "type": "npm", "script": "lint", "problemMatcher": ["$eslint-stylish"], "group": "build" },
		{ "type": "shell", "command": "no label" },
		{ "label": "empty", "type": "shell" }
	],
	"inputs": [
		{ "id": "name", "type": "promptString", "description": "Name?", "default": "\${workspaceFolderBasename}" },
		{ "id": "pick", "type": "pickString", "options": ["a", { "label": "Bee", "value": "b" }], "default": "a" }
	]
}`;

describe('tasks.json', () => {
	const file = parseTasksJson(TASKS, 'osx');

	test('custom tasks, OS overrides, global options and presentation', () => {
		expect(file.tasks.map((t) => t.label)).toEqual(['build', 'test', 'all', 'watch']);
		const build = file.tasks[0];
		expect(build).toMatchObject({ type: 'shell', runtime: 'shell', command: 'gmake', args: ['mac'], group: { kind: 'build', isDefault: true }, problemMatcher: '$gcc', configured: true });
		expect(build.options.env).toEqual({ GLOBAL: '1', TASK: '2', OS: 'mac' });
		expect(build.options.cwd).toBe('${workspaceFolder}/global');
		expect(build.presentation).toMatchObject({ panel: 'dedicated', reveal: 'always', echo: true, showReuseMessage: true });
		const linux = parseTasksJson(TASKS, 'linux').tasks[0];
		expect(linux).toMatchObject({ command: 'make-linux', args: ['all', { value: 'a b', quoting: 'escape' }] });
		const test = file.tasks[1];
		expect(test).toMatchObject({ runtime: 'process', group: { kind: 'test', isDefault: false }, presentation: { reveal: 'silent', clear: true, panel: 'dedicated' } });
	});

	test('compound tasks, background, runOptions, inputs and errors', () => {
		expect(file.tasks[2]).toMatchObject({ dependsOn: ['build', 'test'], dependsOrder: 'sequence' });
		expect(file.tasks[2].command).toBeUndefined();
		expect(file.tasks[2].runtime).toBeUndefined();
		expect(file.tasks[3]).toMatchObject({ isBackground: true, runOptions: { runOn: 'folderOpen' }, promptOnClose: true });
		expect(file.inputs).toEqual([
			{ id: 'name', type: 'promptString', description: 'Name?', default: '${workspaceFolderBasename}', password: false },
			{ id: 'pick', type: 'pickString', description: undefined, options: [{ value: 'a' }, { label: 'Bee', value: 'b' }], default: 'a' }
		]);
		expect(file.errors.some((e) => e.includes('must provide a label'))).toBe(true);
		expect(file.errors.some((e) => e.includes("'empty' neither specifies a command"))).toBe(true);
		expect(file.customizations).toEqual([expect.objectContaining({ definition: { type: 'npm', script: 'lint' } })]);
	});

	test('bad JSON is an error, not an exception', () => {
		expect(parseTasksJson('{ "tasks": [', 'osx').errors).toHaveLength(1);
	});

	test('customizations lay over detected tasks; unmatched ones are built from the identifier', () => {
		const detected = npmTasks('package.json', JSON.stringify({ scripts: { lint: 'eslint .', build: 'vite build' } }), 'bun');
		const { tasks, errors } = mergeTasks(file, detected, (d) => taskFromDefinition(d, 'bun'));
		expect(errors).toEqual(file.errors);
		const lint = tasks.find((t) => t.label === 'npm: lint')!;
		expect(lint).toMatchObject({ configured: true, problemMatcher: ['$eslint-stylish'], group: { kind: 'build' }, command: 'bun', args: ['run', 'lint'], detail: 'eslint .' });
		expect(tasks.find((t) => t.label === 'npm: build')?.configured).toBe(false);
		const only = mergeTasks(file, [], (d) => taskFromDefinition(d, 'npm'));
		expect(only.tasks.find((t) => t.label === 'npm: lint')).toMatchObject({ command: 'npm', configured: true });
	});

	test('dependsOn references by label and by identifier; default build task; glob isDefault', () => {
		const detected = cargoTasks();
		const { tasks } = mergeTasks(file, detected, () => null);
		expect(findTask(tasks, 'build')?.label).toBe('build');
		expect(findTask(tasks, { type: 'cargo', command: 'check' })?.label).toBe('rust: cargo check');
		expect(groupTasks(tasks, 'build').defaults.map((t) => t.label)).toEqual(['build']);
		expect(groupTasks(tasks, 'test').all.map((t) => t.label)).toEqual(['test', 'rust: cargo test']);
		expect(globMatch('**/*.ts', 'src/a/b.ts')).toBe(true);
		expect(globMatch('*.ts', 'src/a.ts')).toBe(true);
		expect(globMatch('src/*.{js,ts}', 'src/a.js')).toBe(true);
		expect(globMatch('**/*.rs', 'src/a.ts')).toBe(false);
	});
});

describe('detection', () => {
	test('npm: package manager from lock files (VS Code order), nested packages, groups', async () => {
		expect(packageManagerFor(new Set(['bun.lock']))).toBe('bun');
		expect(packageManagerFor(new Set(['yarn.lock', 'bun.lockb']))).toBe('yarn');
		expect(packageManagerFor(new Set(['package-lock.json', 'pnpm-lock.yaml']))).toBe('npm');
		const files = new Set(['package.json', 'bun.lock', 'apps/web/package.json', 'node_modules/x/package.json', 'Cargo.toml', 'go.mod']);
		const texts: Record<string, string> = {
			'package.json': JSON.stringify({ scripts: { build: 'vite build', test: 'bun test', 'watch:css': 'x', dev: 'vite' } }),
			'apps/web/package.json': JSON.stringify({ scripts: { start: 'node .' } })
		};
		const tasks = await detectTasks({ files, read: async (rel) => texts[rel] ?? null });
		const labels = tasks.map((t) => t.label);
		expect(labels).toContain('npm: build');
		expect(labels).toContain('npm: start - apps/web');
		expect(labels).toContain('npm: install');
		expect(labels).toContain('rust: cargo build');
		expect(labels).toContain('go: test workspace');
		expect(labels.some((l) => l.includes('node_modules'))).toBe(false);
		const by = (l: string) => tasks.find((t) => t.label === l)!;
		expect(by('npm: build')).toMatchObject({ command: 'bun', args: ['run', 'build'], group: { kind: 'build' }, definition: { type: 'npm', script: 'build' } });
		expect(by('npm: watch:css').group?.kind).toBe('build');
		expect(by('npm: test').group?.kind).toBe('test');
		expect(by('npm: dev').group).toBeUndefined();
		expect(by('npm: start - apps/web')).toMatchObject({ options: { cwd: '${workspaceFolder}/apps/web' }, definition: { path: 'apps/web' } });
		expect(by('rust: cargo test')).toMatchObject({ runtime: 'process', command: 'cargo', args: ['test'], problemMatcher: ['$rustc'] });
		expect(by('go: build package')).toMatchObject({ args: ['build', '${fileDirname}'], problemMatcher: ['$go'] });
	});
});

describe('command lines', () => {
	test('VS Code quoting for bash/zsh: strong quotes on spaces, explicit quoting kinds', () => {
		expect(shellCommandLine('zsh', undefined, 'echo', 'echo', ['hello world', { value: 'a b', quoting: 'escape' }, { value: 'x y', quoting: 'weak' }, 'plain'])).toBe(`echo 'hello world' a\\ b "x y" plain`);
		expect(shellCommandLine('bash', undefined, 'npm run build && echo ok', 'npm run build && echo ok', [])).toBe('npm run build && echo ok');
		expect(shellCommandLine('bash', undefined, 'my tool', '${tool}', [])).toBe("'my tool'");
		expect(shellCommandLine('bash', undefined, "'already quoted'", 'x', ['a'])).toBe("'already quoted' a");
		expect(shellCommandLine('pwsh', undefined, 'my app', 'x', ['a b'], true)).toBe(`& 'my app' 'a b'`);
	});

	test('the launch argv: default shell -l -c, a configured shell as given, a process as is', () => {
		const base = { args: [], options: {} };
		expect(taskLaunch({ ...base, runtime: 'shell', command: 'make all' }, 'make all', { executable: null, args: ['-l'] })).toEqual({ argv: ['-l', '-c', 'make all'], defaultShell: true, commandLine: 'make all' });
		expect(taskLaunch({ ...base, runtime: 'shell', command: 'x' }, 'x', { executable: '/bin/bash', args: ['-l', '-c'] }).argv).toEqual(['/bin/bash', '-l', '-c', 'x']);
		expect(taskLaunch({ ...base, runtime: 'shell', command: 'x', options: { shell: { executable: 'bash', args: ['-c'] } } }, 'x', { executable: null, args: ['-l'] }).argv).toEqual(['bash', '-c', 'x']);
		expect(taskLaunch({ runtime: 'process', command: 'cargo', args: ['test', 'a b;rm -rf /'], options: {} }, 'cargo', { executable: null, args: [] }).argv).toEqual(['cargo', 'test', 'a b;rm -rf /']);
		expect(addAllArgument(['-c'], ['-l', '-c'])).toEqual(['-l', '-c']);
		expect(addAllArgument(['-c'], ['-c', 'x'])).toEqual(['-c', 'x', '-c']);
	});
});

describe('variables', () => {
	const ctx: VariableContext = {
		workspaceFolder: '/w/app',
		file: '/w/app/src/lib/a.test.ts',
		lineNumber: 3,
		selectedText: 'sel',
		userHome: '/home/u',
		env: { HOME: '/home/u' },
		config: (k) => (k === 'editor.tabSize' ? 4 : k === 'obj' ? { a: 1 } : undefined),
		defaultBuildTask: 'build'
	};

	test('the file family, env, config, workspace', () => {
		expect(
			substitute(
				['${workspaceFolder}', '${workspaceFolderBasename}', '${file}', '${relativeFile}', '${relativeFileDirname}', '${fileBasename}', '${fileBasenameNoExtension}', '${fileDirname}', '${fileExtname}', '${fileDirnameBasename}', '${env:HOME}', '${env:NOPE}', '${config:editor.tabSize}', '${cwd}', '${lineNumber}', '${selectedText}', '${pathSeparator}', '${userHome}', '${defaultBuildTask}'],
				ctx
			)
		).toEqual(['/w/app', 'app', '/w/app/src/lib/a.test.ts', 'src/lib/a.test.ts', 'src/lib', 'a.test.ts', 'a.test', '/w/app/src/lib', '.ts', 'lib', '/home/u', '', '4', '/w/app', '3', 'sel', '/', '/home/u', 'build']);
		expect(() => substitute('${config:obj}', ctx)).toThrow(VariableError);
		expect(() => substitute('${file}', { ...ctx, file: undefined })).toThrow(/open an editor/);
		expect(() => substitute('${command:foo}', ctx)).toThrow(VariableError);
		expect(substitute({ cwd: '${workspaceFolder}/x', n: 1 }, ctx)).toEqual({ cwd: '/w/app/x', n: 1 });
	});

	test('${workspaceFolder:name} picks a root folder of a multi-root workspace', () => {
		const folders = [{ path: '/w/app', name: 'app' }, { path: '/w/lib', name: 'Library' }];
		expect(substitute(['${workspaceFolder:Library}/out', '${workspaceFolder:lib}', '${workspaceFolderBasename:Library}', '${workspaceFolder}'], { ...ctx, folders })).toEqual(['/w/lib/out', '/w/lib', 'lib', '/w/app']);
		expect(() => substitute('${workspaceFolder:nope}', { ...ctx, folders })).toThrow(/No workspace folder named nope/);
		// A single-folder window (no folder list): any name is the folder, as before.
		expect(substitute('${workspaceFolder:whatever}', ctx)).toBe('/w/app');
	});

	test('inputs are asked once each; cancel stops; defaults use variables', async () => {
		const file = parseTasksJson(TASKS, 'osx');
		const vars = collectVariables(['${input:name} ${input:pick}', '${input:name}', '${file}']);
		const asked: string[] = [];
		const answers = await resolveInputs(vars, file.inputs, ctx, {
			promptString: async (i) => (asked.push(`${i.id}=${i.default}`), 'Ann'),
			pickString: async (i) => (asked.push(i.id), i.options[1].value)
		});
		expect(asked).toEqual(['name=app', 'pick']);
		expect(substitute('${input:name}-${input:pick}', ctx, answers)).toBe('Ann-b');
		const cancelled = await resolveInputs(vars, file.inputs, ctx, { promptString: async () => undefined, pickString: async () => 'a' });
		expect(cancelled).toBeUndefined();
		await expect(resolveInputs(['input:missing'], file.inputs, ctx, { promptString: async () => '', pickString: async () => '' })).rejects.toThrow(/Undefined input variable 'missing'/);
	});
});

describe('task output', () => {
	test('lines without escapes, signals taken out across chunks, carriage returns', () => {
		const out = new TaskOutput();
		expect(out.feed('\x1b[31merror\x1b[0m: one\r\npartial')).toEqual({ lines: ['error: one'], signals: [], processExited: false });
		expect(out.feed(' line\r\nprogress 10%\rprogress 100%\n\x1b]7337;ex')).toEqual({ lines: ['partial line', 'progress 100%'], signals: [], processExited: false });
		expect(out.feed('it;2\x07\x1b]7337;close\x07\r\n[process exited]\r\n')).toEqual({ lines: [''], signals: [{ kind: 'exit', code: 2 }, { kind: 'close' }], processExited: true });
		expect(stripAnsi('\x1b]0;title\x07a\x1b(Bb\x1b[?25lc')).toBe('abc');
		expect(visibleLine('x\r')).toBe('x');
	});
});

describe('dependsOn', () => {
	type T = { name: string; deps?: string[]; seq?: boolean; bg?: boolean; cmd?: boolean; code?: number; delay?: number };

	function host(tasks: T[], log: string[]) {
		const running = new Map<string, Execution>();
		const h: GraphHost<T, string> = {
			key: (t) => t.name,
			dependsOn: (t) => t.deps ?? [],
			sequence: (t) => !!t.seq,
			isBackground: (t) => !!t.bg,
			hasCommand: (t) => t.cmd !== false,
			resolve: (r) => tasks.find((t) => t.name === r),
			running: (t) => running.get(t.name),
			log: (m) => log.push(`log: ${m}`),
			execute(t) {
				log.push(`start ${t.name}`);
				let inactive: Promise<Summary> | undefined;
				const done = new Promise<Summary>((resolve) =>
					setTimeout(() => {
						log.push(`end ${t.name}`);
						resolve({ exitCode: t.code ?? 0 });
					}, t.delay ?? 5)
				);
				if (t.bg) inactive = new Promise((resolve) => setTimeout(() => (log.push(`idle ${t.name}`), resolve({ exitCode: 0 })), 2));
				const e = { done, inactive };
				running.set(t.name, e);
				return e;
			}
		};
		return h;
	}

	test('parallel by default, each dependency once, the task after them', async () => {
		const log: string[] = [];
		const tasks: T[] = [{ name: 'all', deps: ['a', 'b'] }, { name: 'a', deps: ['c'] }, { name: 'b', deps: ['c'] }, { name: 'c' }];
		const r = await runTask(host(tasks, log), tasks[0]);
		expect(r).toEqual({ exitCode: 0 });
		expect(log.filter((l) => l === 'start c')).toHaveLength(1);
		expect(log.indexOf('end c')).toBeLessThan(log.indexOf('start a'));
		expect(log.indexOf('end a')).toBeLessThan(log.indexOf('start all'));
		expect(log.indexOf('end b')).toBeLessThan(log.indexOf('start all'));
	});

	test('sequence runs in order and stops at the first failure', async () => {
		const log: string[] = [];
		const tasks: T[] = [{ name: 'all', deps: ['a', 'b', 'c'], seq: true }, { name: 'a' }, { name: 'b', code: 1 }, { name: 'c' }];
		const r = await runTask(host(tasks, log), tasks[0]);
		expect(r).toEqual({ exitCode: 1 });
		expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
	});

	test('a background dependency is done when it goes idle; cycles are reported and fail', async () => {
		const log: string[] = [];
		const tasks: T[] = [{ name: 'launch', deps: ['watch'] }, { name: 'watch', bg: true, delay: 50 }];
		await runTask(host(tasks, log), tasks[0]);
		expect(log.indexOf('idle watch')).toBeLessThan(log.indexOf('start launch'));
		// The watcher still runs when its dependent starts.
		expect(log).not.toContain('end watch');

		const log2: string[] = [];
		const cyc: T[] = [{ name: 'a', deps: ['b'] }, { name: 'b', deps: ['a'] }];
		const r = await runTask(host(cyc, log2), cyc[0]);
		expect(r.exitCode).toBeUndefined();
		expect(log2.some((l) => l.includes('dependency cycle'))).toBe(true);
		expect(log2.some((l) => l.startsWith('start'))).toBe(false);
	});

	test('a compound task without a command; a missing dependency is logged and skipped', async () => {
		const log: string[] = [];
		const tasks: T[] = [{ name: 'all', deps: ['a', 'missing'], cmd: false }, { name: 'a' }];
		expect(await runTask(host(tasks, log), tasks[0])).toEqual({ exitCode: 0 });
		expect(log).toContain("log: Couldn't resolve dependent task 'missing' in workspace folder");
	});

	test('untilInactive: a background task as a preLaunchTask', async () => {
		const log: string[] = [];
		const tasks: T[] = [{ name: 'watch', bg: true, delay: 40 }];
		const r = await runTask(host(tasks, log), tasks[0], { untilInactive: true });
		expect(r).toEqual({ exitCode: 0 });
		expect(log).toEqual(['start watch', 'idle watch']);
	});
});
