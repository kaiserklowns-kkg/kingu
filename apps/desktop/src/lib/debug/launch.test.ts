/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { cargoBinName, generatedConfigs, parseLaunchJson, runInTerminalArgv, substitute, type VarContext } from './launch.ts';

describe('launch.json', () => {
	test('reads JSONC configurations and skips malformed entries', () => {
		const text = `{
			// VS Code writes comments and trailing commas
			"version": "0.2.0",
			"configurations": [
				{ "type": "lldb", "request": "launch", "name": "Debug app", "program": "\${workspaceFolder}/target/debug/app", },
				{ "type": "go", "name": "no request" },
				"junk",
			],
		}`;
		const { configs, error } = parseLaunchJson(text, '.vscode/launch.json');
		expect(error).toBeUndefined();
		expect(configs.map((c) => c.name)).toEqual(['Debug app']);
		expect(parseLaunchJson('', 'x').configs).toEqual([]);
		expect(parseLaunchJson('{ "version": "0.2.0" }', 'x').configs).toEqual([]);
		expect(parseLaunchJson('{ "configurations": {} }', 'x').error).toContain('array');
		expect(parseLaunchJson('{ nope', '.kingu/launch.json').error).toStartWith('.kingu/launch.json: อ่าน JSON ไม่ได้');
	});
});

describe('variable substitution', () => {
	const ctx: VarContext = { workspaceFolder: '/Users/me/โปรเจกต์', file: '/Users/me/โปรเจกต์/cmd/server/main.go', env: { HOME: '/Users/me', EMPTY: '' } };

	test('workspace, file and env variables, deep in arrays and objects', () => {
		const config = {
			type: 'go',
			request: 'launch',
			name: 'x ${workspaceFolderBasename}',
			program: '${fileDirname}',
			args: ['${file}', '${relativeFile}', '${relativeFileDirname}', '${fileBasename}', '${fileBasenameNoExtension}${fileExtname}'],
			env: { DATA: '${env:HOME}/data', MISSING: '${env:NOPE}', ROOT: '${workspaceRoot}' },
			stopOnEntry: false,
			port: 2345
		};
		expect(substitute(config, ctx)).toEqual({
			type: 'go',
			request: 'launch',
			name: 'x โปรเจกต์',
			program: '/Users/me/โปรเจกต์/cmd/server',
			args: ['/Users/me/โปรเจกต์/cmd/server/main.go', 'cmd/server/main.go', 'cmd/server', 'main.go', 'main.go'],
			env: { DATA: '/Users/me/data', MISSING: '', ROOT: '/Users/me/โปรเจกต์' },
			stopOnEntry: false,
			port: 2345
		});
	});

	test('file variables need an open file; unknown variables are errors', () => {
		expect(() => substitute('${file}', { ...ctx, file: undefined })).toThrow('ต้องมีไฟล์เปิดอยู่');
		expect(() => substitute({ p: '${command:pickProcess}' }, ctx)).toThrow('ไม่รองรับตัวแปร ${command:pickProcess}');
		expect(substitute('${workspaceFolder}/a', { ...ctx, file: undefined })).toBe('/Users/me/โปรเจกต์/a');
	});
});

describe('generated configurations', () => {
	test('Cargo binary name', () => {
		expect(cargoBinName('[package]\nname = "kingu-desktop" # the app\nversion = "0.1.0"\n[dependencies]\nname = "x"\n')).toBe('kingu-desktop');
		expect(cargoBinName('[package]\nname = "lib"\n\n[[bin]]\nname = "tool"\npath = "src/tool.rs"\n')).toBe('tool');
		expect(cargoBinName('[workspace]\nmembers = ["a"]\n')).toBeNull();
	});

	test('per language', () => {
		const [rust] = generatedConfigs('rust', { cargoToml: '[package]\nname = "app"\n' });
		expect(rust.build).toEqual(['cargo', 'build', '--bin', 'app']);
		expect(rust.config).toMatchObject({ type: 'lldb', request: 'launch', program: '${workspaceFolder}/target/debug/app' });
		expect(rust.askProgram).toBeUndefined();
		expect(generatedConfigs('rust', { cargoToml: null })[0].askProgram).toBe(true);
		expect(generatedConfigs('cpp')[0]).toMatchObject({ askProgram: true, config: { type: 'lldb' } });
		expect(generatedConfigs('go')[0].config).toMatchObject({ type: 'go', mode: 'debug', program: '${fileDirname}' });
		expect(generatedConfigs('python')[0].config).toMatchObject({ type: 'debugpy', program: '${file}' });
		expect(generatedConfigs('markdown')).toEqual([]);
	});
});

test('runInTerminal argv keeps every word separate and passes cwd and env without shell syntax', () => {
	const argv = runInTerminalArgv({ cwd: '/w s/ท', args: ['/usr/bin/python3', '-m', 'debugpy.launcher', 'a b'], env: { PYTHONPATH: '/x y', DROP: null } });
	expect(argv).toEqual(['/bin/sh', '-c', 'cd "$1" && shift && exec env "$@"', 'kingu-debug', '/w s/ท', '-u', 'DROP', 'PYTHONPATH=/x y', '/usr/bin/python3', '-m', 'debugpy.launcher', 'a b']);
	// The script really runs: cd, unset, set, then exec the program.
	const out = Bun.spawnSync(runInTerminalArgv({ cwd: '/tmp', args: ['/bin/sh', '-c', 'echo "$(pwd)|${DROP-unset}|$KEEP"'], env: { KEEP: 'ค่า', DROP: null } }), { env: { DROP: 'x', PATH: '/usr/bin:/bin' } });
	expect(out.stdout.toString().trim()).toMatch(/^(\/private)?\/tmp\|unset\|ค่า$/);
});
