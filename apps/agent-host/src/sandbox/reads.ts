// What a sandboxed command may read in the home folder. VS Code's Local harness denies reads of
// the whole home folder and re-opens the working folders and, per command, the tool folders that
// command needs (src/vs/platform/sandbox/common/terminalSandboxEngine.ts `_updateDenyReadPathsWithHome`,
// `_updateAllowReadPathsWithAllowWrite`; the lists are terminalSandboxReadAllowList.ts and
// terminalSandboxRuntimeConfigurationPerOperation.ts, the macOS and Linux entries; Windows has
// none, since VS Code does not sandbox there). VS Code finds the commands
// with tree-sitter (treeSitterCommandParser.ts `extractCommands`); Kingu splits the line with the
// guards' shell word splitter, then applies the same keyword rules (leading `VAR=value`, `env`).
//
// Kingu adds the PATH folders under home (`~/.cargo/bin`, `~/.local/bin`, …): a program installed
// there could not even start otherwise. That is what VS Code's other harness grants by default
// (`chat.agent.sandbox.fileSystem.allowDevToolAccess`, "the tool directories found on PATH").

import { basename } from 'node:path';
import { shellWords } from '../guards/asks.ts';

type Op = 'git' | 'node' | 'rust' | 'go' | 'python' | 'java' | 'dotnet' | 'nuget' | 'ruby' | 'nativeBuild' | 'conan' | 'gnupg' | 'ssh';

/** VS Code's `terminalSandboxReadAllowListKeywordMap`. */
const KEYWORDS: Record<string, Op> = {
	git: 'git', gh: 'git', gpg: 'gnupg',
	node: 'node', npm: 'node', npx: 'node', pnpm: 'node', yarn: 'node', corepack: 'node', bun: 'node', deno: 'node', nvm: 'node', volta: 'node', fnm: 'node', asdf: 'node', mise: 'node',
	cargo: 'rust', rustc: 'rust', rustup: 'rust',
	go: 'go', gofmt: 'go',
	python: 'python', python3: 'python', pip: 'python', pip3: 'python', poetry: 'python', uv: 'python', pipx: 'python', pyenv: 'python',
	java: 'java', javac: 'java', jar: 'java', mvn: 'java', mvnw: 'java', gradle: 'java', gradlew: 'java', sdk: 'java',
	dotnet: 'dotnet', nuget: 'nuget',
	ruby: 'ruby', gem: 'ruby', bundle: 'ruby', bundler: 'ruby', rake: 'ruby', rbenv: 'ruby', rvm: 'ruby',
	ccache: 'nativeBuild', sccache: 'nativeBuild', cmake: 'nativeBuild',
	conan: 'conan'
};

/** The macOS paths of each operation (`getTerminalSandboxReadAllowListForOperation`). */
const PATHS: Record<Op, readonly string[]> = {
	git: ['~/.gitconfig', '~/.config/gh/config.yml', '~/.config/git/config', '~/.gitignore', '~/.gitignore_global', '~/.config/git/ignore', '~/.config/git/attributes'],
	node: [
		'~/.npm', '~/Library/Caches/node', '~/Library/Caches/electron', '~/Library/Caches/ms-playwright', '~/Library/Caches/Yarn', '~/Library/Caches/deno', '~/Library/pnpm',
		'~/.electron-gyp', '~/.node-gyp', '~/.yarn/berry', '~/.local/share/pnpm', '~/.pnpm-store', '~/.bun/install/cache', '~/.bun/bin', '~/.deno', '~/.nvm/versions', '~/.nvm/alias',
		'~/.volta/bin', '~/.volta/tools', '~/.fnm', '~/.asdf/installs/nodejs', '~/.asdf/shims', '~/.local/share/mise/installs/node', '~/.local/share/mise/shims'
	],
	rust: ['~/.cargo/bin', '~/.cargo/registry', '~/.cargo/git', '~/.rustup/toolchains'],
	go: ['~/go/pkg/mod', '~/go/bin', '~/Library/Caches/go-build'],
	python: ['~/Library/Caches/pip', '~/Library/Caches/pypoetry', '~/Library/Caches/uv', '~/.local/bin', '~/.local/share/virtualenv', '~/.local/share/pipx', '~/.pyenv/versions', '~/.pyenv/shims'],
	java: ['~/.m2/repository', '~/.gradle/caches', '~/.gradle/wrapper/dists', '~/.sdkman/candidates'],
	dotnet: ['~/.dotnet'],
	nuget: ['~/.nuget/packages', '~/Library/Caches/NuGet/v3-cache'],
	ruby: ['~/.gem', '~/.rbenv/versions', '~/.rbenv/shims', '~/.rvm/rubies'],
	nativeBuild: ['~/Library/Caches/ccache', '~/Library/Caches/sccache'],
	conan: ['~/.conan2/p', '~/.conan2/b'],
	gnupg: ['~/.gnupg'],
	ssh: ['~/.ssh']
};

/** The Linux paths where they differ from macOS (the same function's `OperatingSystem.Linux` cases). */
const LINUX: Partial<Record<Op, readonly string[]>> = {
	node: [
		'~/.npm', '~/.cache/node', '~/.cache/node/corepack', '~/.cache/electron', '~/.cache/ms-playwright', '~/.cache/yarn', '~/.electron-gyp', '~/.node-gyp', '~/.yarn/berry',
		'~/.local/share/pnpm', '~/.pnpm-store', '~/.bun/install/cache', '~/.bun/bin', '~/.deno', '~/.cache/deno', '~/.nvm/versions', '~/.nvm/alias', '~/.volta/bin', '~/.volta/tools',
		'~/.fnm', '~/.asdf/installs/nodejs', '~/.asdf/shims', '~/.local/share/mise/installs/node', '~/.local/share/mise/shims'
	],
	go: ['~/go/pkg/mod', '~/go/bin', '~/.cache/go-build'],
	python: ['~/.cache/pip', '~/.cache/pypoetry', '~/.cache/uv', '~/.local/bin', '~/.local/share/virtualenv', '~/.local/share/pipx', '~/.pyenv/versions', '~/.pyenv/shims'],
	nuget: ['~/.nuget/packages', '~/.local/share/NuGet/v3-cache'],
	nativeBuild: ['~/.cache/ccache', '~/.cache/sccache']
};

const opPaths = (op: Op, platform: string) => (platform === 'linux' ? (LINUX[op] ?? PATHS[op]) : PATHS[op]);

/** Command-detail rules (`terminalSandboxReadAllowListCommandDetailRules`): key material only for the commands that sign or connect. */
const DETAIL: readonly { keywords: readonly string[]; op: Op }[] = [
	{ keywords: ['gpg', 'gpg2'], op: 'gnupg' },
	{ keywords: ['git'], op: 'gnupg' },
	{ keywords: ['git', 'ssh', 'scp', 'sftp', 'rsync'], op: 'ssh' }
];

/** Writes some commands need (terminalSandboxRuntimeConfigurationPerOperation.ts): git signs with gpg, volta keeps its state. */
const WRITES: readonly { keywords: readonly string[]; paths: readonly string[] }[] = [
	{ keywords: ['git'], paths: ['~/.gnupg'] },
	{ keywords: ['node', 'npm', 'npx', 'pnpm', 'yarn', 'corepack', 'bun', 'deno', 'nvm', 'volta', 'fnm', 'asdf', 'mise'], paths: ['~/.volta'] }
];

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** `env` options that take a value (treeSitterCommandParser.ts `envOptionsWithValue`). */
const ENV_WITH_VALUE = new Set(['-u', '--unset', '-C', '--chdir', '-a', '--argv0']);

const keyword = (word: string | undefined) => (word ? basename(word).toLowerCase() || undefined : undefined);

/** The program names of a command line (VS Code's `_parseCommand`: past `VAR=value` and `env`). */
export function commandKeywords(command: string): string[] {
	const out = new Set<string>();
	for (const words of shellWords(command)) {
		let i = 0;
		while (i < words.length && ASSIGNMENT.test(words[i]!)) i++;
		let k = keyword(words[i]);
		if (k === 'env') {
			for (let j = i + 1; j < words.length; j++) {
				const w = words[j]!;
				if (ASSIGNMENT.test(w)) continue;
				if (w === '--') {
					i = j + 1;
					break;
				}
				if (w.startsWith('-')) {
					if (!w.includes('=') && ENV_WITH_VALUE.has(w)) j++;
					continue;
				}
				i = j;
				break;
			}
			k = keyword(words[i]);
		}
		if (k) out.add(k);
	}
	return [...out];
}

/** Home paths (`~/…`) a command may read and write beyond the run's folders (`platform`: whose path list). */
export function commandGrants(command: string, platform: string = process.platform): { read: string[]; write: string[] } {
	const keys = commandKeywords(command);
	const ops = new Set<Op>();
	for (const k of keys) {
		const op = KEYWORDS[k];
		if (op) ops.add(op);
		for (const r of DETAIL) if (r.keywords.includes(k)) ops.add(r.op);
	}
	// Docker's socket would give the host away: VS Code skips git's gpg grant (which opens all unix sockets) next to it.
	const docker = keys.some((k) => k.startsWith('docker'));
	const write = WRITES.filter((w) => keys.some((k) => w.keywords.includes(k)) && !(docker && w.keywords.includes('git'))).flatMap((w) => w.paths);
	return { read: [...new Set([...[...ops].flatMap((o) => opPaths(o, platform)), ...write])], write: [...new Set(write)] };
}

/** The PATH folders inside `home` (not home itself: that would re-open all of it). */
export function pathDirsInHome(path: string | undefined, home: string): string[] {
	if (!path) return [];
	const prefix = home.endsWith('/') ? home : `${home}/`;
	return [...new Set(path.split(':').filter((d) => d.startsWith(prefix) && d.length > prefix.length && !d.split('/').includes('..')))];
}
