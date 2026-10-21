// Codex's shared app-server (Orca's codexTerminalServerIsolation / codexSharedServerWarning).
// Codex 0.156+ runs one background server per CODEX_HOME that every interactive codex joins; it
// runs each terminal's hooks with the first terminal's environment and they all end with it.
// - kingu.codex.terminalServerIsolation (on): a task's codex starts with `--no-daemon` when its
//   binary lists the flag (Rust agent/codex_server.rs probes `--help` on each launch).
// - kingu.codex.sharedServerWarning (on, only with isolation): a codex typed into a terminal that
//   joined a live shared server gets one warning per session (codexSharedServer.svelte.ts).
// Pure, so `bun test` covers it.

type Get = (id: string) => unknown;

export const ISOLATION_SETTING = 'kingu.codex.terminalServerIsolation';
export const WARNING_SETTING = 'kingu.codex.sharedServerWarning';

/** Arguments that need the shared server (or already choose): codex exits 2 on them with --no-daemon. */
export const SHARED_SERVER_ARGS: readonly string[] = ['agents', 'queue', '--no-daemon', '--remote'];

export const isolationOn = (get: Get) => get(ISOLATION_SETTING) !== false;
/** The warning belongs to isolation: with it off, sharing the server is what you chose. */
export const warningOn = (get: Get) => isolationOn(get) && get(WARNING_SETTING) !== false;

export const wantsSharedServer = (args: readonly string[]) => args.some((a) => SHARED_SERVER_ARGS.includes(a) || a.startsWith('--remote='));

/** Index of the program word, past an `env NAME=value …` prefix; -1 when there is none. */
export function programIndex(argv: readonly string[]): number {
	let i = 0;
	if (argv[0] && (argv[0].split('/').pop() ?? '') === 'env') {
		i = 1;
		while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) i++;
	}
	return i < argv.length ? i : -1;
}

/** The program a codex launch would probe for `--no-daemon`, or null when the flag must not be added. */
export function noDaemonProgram(argv: readonly string[], get: Get): string | null {
	const i = programIndex(argv);
	if (i < 0 || !isolationOn(get) || wantsSharedServer(argv.slice(i + 1))) return null;
	return argv[i];
}

/** `--no-daemon` right after the program word (root flags go before a subcommand like `resume`). */
export function withNoDaemon(argv: readonly string[]): string[] {
	const i = programIndex(argv);
	if (i < 0 || argv.includes('--no-daemon')) return [...argv];
	return [...argv.slice(0, i + 1), '--no-daemon', ...argv.slice(i + 1)];
}

/** Foreground jobs that may be codex: the native binary, or node running the npm launcher (Rust reads the command line). */
export const maybeCodex = (name: string) => /^codex/i.test(name) || /^node$/i.test(name);

/** Codex joins or starts the server a few seconds after its process appears: checks at these ages. */
export const CHECK_AFTER_MS: readonly number[] = [1_000, 4_000, 10_000];

/** One foreground codex job being checked: when it was first seen and how many checks ran. */
export type Watch = { pid: number; seenAt: number; checks: number; done: boolean };

/** Whether `w` is due a check at `now` (the next age on the ladder has passed). */
export const checkDue = (w: Watch, now: number) => !w.done && w.checks < CHECK_AFTER_MS.length && now - w.seenAt >= CHECK_AFTER_MS[w.checks];

/**
 * The next watch of a terminal from its foreground job: a new pid starts over, a job that is no
 * longer codex-like (or none) stops watching.
 */
export function nextWatch(prev: Watch | undefined, fg: { pid: number; name: string } | null | undefined, now: number): Watch | undefined {
	if (!fg || !maybeCodex(fg.name)) return undefined;
	if (prev && prev.pid === fg.pid) return prev;
	return { pid: fg.pid, seenAt: now, checks: 0, done: false };
}
