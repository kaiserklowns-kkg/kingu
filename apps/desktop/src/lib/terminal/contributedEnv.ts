// Environment variables other features add to every new terminal (VS Code: the extensions'
// EnvironmentVariableCollection, e.g. js-debug's auto attach NODE_OPTIONS). Each contributor owns
// its entry; terminals started later get the merged variables, ones already running keep theirs.

const contributions = new Map<string, Record<string, string>>();

/** Sets (or with null, removes) a contributor's variables. */
export function contributeTerminalEnv(owner: string, env: Record<string, string> | null) {
	if (env && Object.keys(env).length) contributions.set(owner, env);
	else contributions.delete(owner);
}

/** Every contributor's variables, for a terminal being started. */
export function contributedTerminalEnv(): Record<string, string> {
	return Object.assign({}, ...contributions.values());
}

/** A terminal's shell settings with the contributed variables over terminal.integrated.env.* (a
 * user NODE_OPTIONS is kept after the contributed one, like an appended collection entry). */
export function withContributedEnv<T extends { env: Record<string, string | null> }>(shell: T): T {
	const extra = contributedTerminalEnv();
	if (!Object.keys(extra).length) return shell;
	const env = { ...shell.env, ...extra };
	const own = shell.env.NODE_OPTIONS;
	if (extra.NODE_OPTIONS && own) env.NODE_OPTIONS = `${extra.NODE_OPTIONS} ${own}`;
	return { ...shell, env };
}
