// The JavaScript Debug Terminal and Node.js auto attach (VS Code: js-debug's debug terminal and the
// debug-auto-launch extension). js-debug's DAP server launches a program with its bootloader in
// NODE_OPTIONS and the address it listens on in VSCODE_INSPECTOR_OPTIONS; every Node.js process
// started with that environment connects back and becomes a child session. The debug terminal is
// such a launch whose "program" is the user's shell; auto attach keeps one launch running without a
// terminal and gives its environment, with `debug.javascript.autoAttachFilter`'s mode, to every new
// terminal. Pure: the configurations and the environment rewrite are unit-tested.

import type { LaunchConfig } from './launch.ts';

export type AutoAttachFilter = 'always' | 'smart' | 'onlyWithFlag' | 'disabled';
export const AUTO_ATTACH_FILTERS: readonly AutoAttachFilter[] = ['always', 'smart', 'onlyWithFlag', 'disabled'];

/** js-debug's environment variable for the bootloader (several settings may be joined with `:::`). */
export const INSPECTOR_OPTIONS = 'VSCODE_INSPECTOR_OPTIONS';
const DELIMITER = ':::';

/** The tools `$KNOWN_TOOLS$` stands for in `debug.javascript.autoAttachSmartPattern` (test runners,
 * transpilers and package managers js-debug's smart mode attaches to even under node_modules). */
export const KNOWN_TOOLS = ['ts-node', 'babel-node', 'tsx', 'mocha', 'jest', 'jest-cli', 'ava', 'tape', 'tap', 'vitest', 'nodemon', 'next', 'nuxt', 'vite', 'webpack', 'webpack-cli', 'react-scripts', 'gulp', 'grunt'];

/** VS Code's default smart pattern. */
export const DEFAULT_SMART_PATTERNS = ['${workspaceFolder}/**', '!**/node_modules/**', '**/$KNOWN_TOOLS$/**'];

/** The smart patterns with `${workspaceFolder}` and `$KNOWN_TOOLS$` filled in. */
export function smartPatterns(patterns: readonly string[] | undefined, workspaceFolder: string): string[] {
	const list = patterns?.length ? patterns : DEFAULT_SMART_PATTERNS;
	return list.map((p) => p.replaceAll('${workspaceFolder}', workspaceFolder).replace('$KNOWN_TOOLS$', `{${KNOWN_TOOLS.join(',')}}`));
}

/** The launch that runs the user's shell under js-debug (the JavaScript Debug Terminal). */
export function debugTerminalConfig(shell: string, cwd: string, extra: Record<string, unknown> = {}): LaunchConfig {
	return {
		// debug.javascript.terminalOptions first: the terminal's own fields win.
		...extra,
		type: 'pwa-node',
		request: 'launch',
		name: 'JavaScript Debug Terminal',
		runtimeExecutable: shell,
		runtimeArgs: ['-l'],
		console: 'integratedTerminal',
		autoAttachChildProcesses: true,
		cwd,
		skipFiles: ['<node_internals>/**', ...(Array.isArray(extra.skipFiles) ? (extra.skipFiles as string[]) : [])]
	};
}

/** The launch that keeps auto attach's listener up: its terminal is never opened, only its environment kept. */
export function autoAttachConfig(shell: string, cwd: string, extra: Record<string, unknown> = {}): LaunchConfig {
	return { ...debugTerminalConfig(shell, cwd, extra), name: 'Auto Attach', __autoAttach: true };
}

/** The bootloader settings in a VSCODE_INSPECTOR_OPTIONS value: the last JSON part. */
export function readInspectorOptions(value: string | null | undefined): Record<string, unknown> | null {
	if (!value) return null;
	const parts = value.split(DELIMITER).filter((p) => p.trim());
	try {
		const last = JSON.parse(parts.at(-1) ?? '');
		return last && typeof last === 'object' && !Array.isArray(last) ? last : null;
	} catch {
		return null;
	}
}

/**
 * The environment for new terminals while auto attach is on: the listener launch's NODE_OPTIONS and
 * VSCODE_INSPECTOR_OPTIONS, the latter with the filter's mode (`smart` with its patterns). Null
 * when the filter is `disabled` or the environment has no bootloader settings.
 */
export function autoAttachEnv(env: Record<string, string | null | undefined>, filter: AutoAttachFilter, patterns: readonly string[] | undefined, workspaceFolder: string): Record<string, string> | null {
	if (filter === 'disabled') return null;
	const raw = env[INSPECTOR_OPTIONS];
	const options = readInspectorOptions(raw);
	const nodeOptions = env.NODE_OPTIONS;
	if (!options || !nodeOptions) return null;
	const next: Record<string, unknown> = { ...options, autoAttachMode: filter, onlyEntrypoint: false };
	if (filter === 'smart') next.aaPatterns = smartPatterns(patterns, workspaceFolder);
	else delete next.aaPatterns;
	return { NODE_OPTIONS: nodeOptions, [INSPECTOR_OPTIONS]: `${DELIMITER}${JSON.stringify(next)}` };
}

/** The status bar text for auto attach (VS Code: "Auto Attach: With Flag"). */
export function autoAttachLabel(filter: AutoAttachFilter): string {
	return { always: 'Always', smart: 'Smart', onlyWithFlag: 'With Flag', disabled: 'Off' }[filter];
}
