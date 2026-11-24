// Orca's session-history time: Just now, 5m ago, 3h ago, 2d ago, 4mo ago, 1y ago.
export function sessionAgo(then: number, now: number): string {
	if (!then) return 'Unknown time';
	const s = Math.max(0, now - then) / 1000;
	if (s < 60) return 'Just now';
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
	if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
	if (s < 365 * 86_400) return `${Math.floor(s / (30 * 86_400))}mo ago`;
	return `${Math.floor(s / (365 * 86_400))}y ago`;
}

/** A CLI's own resume command for one of its sessions (claude/gemini `--resume <id>`, `codex resume <id>`,
 * `opencode --session <id>` as Orca's ai-vault-resume-command.ts). */
export function resumeArgv(agent: string, id: string, path?: string | null): string[] {
	if (agent === 'opencode') return ['opencode', '--session', id];
	// OpenCode 2 and Rovo Dev resume through their launch commands (Orca's TUI launchCmd).
	if (agent === 'opencode2') return ['opencode2', '--standalone', '--session', id];
	if (agent === 'rovo') return ['acli', 'rovodev', 'run', '--restore', id];
	// OMP: `omp --resume <id>`, with `--profile <name>` for a transcript in a named profile's store
	// (OMP takes the profile only from a flag or its env; Orca's ompTranscriptProfileArgs).
	if (agent === 'omp') {
		const profile = ompProfile(path);
		return ['omp', ...(profile ? ['--profile', profile] : []), '--resume', id];
	}
	// Antigravity's CLI: `agy --conversation <id>`.
	if (agent === 'antigravity') return ['agy', '--conversation', id];
	// Orca's ai-vault-resume-command.ts: `copilot --resume=<id>`.
	if (agent === 'copilot') return ['copilot', `--resume=${id}`];
	if (agent === 'cursor') return ['cursor-agent', '--resume', id];
	// Orca's `--resume <id>` group (ai-vault-resume-command.ts), with Kingu's profile programs.
	if (agent === 'qoder') return ['qodercli', '--resume', id];
	if (agent === 'codebuddy') return ['codebuddy', '--resume', id];
	if (agent === 'droid') return ['droid', '--resume', id];
	// Kiro keeps its chat subcommand when resuming (Orca: `kiro-cli chat --tui --resume-id <id>`).
	if (agent === 'kiro') return ['kiro-cli', 'chat', '--tui', '--resume-id', id];
	// Orca: `kimi --session <id>` (workspace-scoped, so it runs in the session's worktree) and `cline --id <id>`.
	if (agent === 'kimi') return ['kimi', '--session', id];
	if (agent === 'cline') return ['cline', '--id', id];
	if (agent === 'devin') return ['devin', '--resume', id];
	// Orca groups grok with `--resume <id>` (ai-vault-resume-command.ts; base command `grok`).
	if (agent === 'grok') return ['grok', '--resume', id];
	// Hermes: `-p <profile>` for a session of a `state.db` store, since bare `hermes` follows the
	// sticky `hermes profile use` choice, which may be another profile (Orca's hermesStateDbProfileArgs).
	if (agent === 'hermes') return ['hermes', ...hermesProfileArgs(path), '--resume', id];
	// jcode too (`jcode --resume <id>`).
	if (agent === 'jcode' || agent === 'openclaw' || agent === 'zcode') return [agent, '--resume', id];
	// Pi: `pi --session <id>` (Orca groups it with opencode).
	if (agent === 'pi') return ['pi', '--session', id];
	// Muse: `muse resume <id>` (workspace-scoped, like kimi).
	if (agent === 'muse') return ['muse', 'resume', id];
	if (agent === 'codex') return ['codex', 'resume', id];
	if (agent === 'gemini') return ['gemini', '--resume', id];
	return ['claude', '--resume', id];
}

/**
 * `-p <profile>` for a Hermes session listed out of a profile's store: `<root>/state.db#<id>` is the
 * default profile's, `<root>/profiles/<name>/state.db#<id>` a named one's. Nothing for a
 * `session_*.json` snapshot or a name Hermes would not accept.
 */
export function hermesProfileArgs(path: string | null | undefined): string[] {
	const m = path?.match(/(?:[\\/]profiles[\\/]([^\\/]+))?[\\/]state\.db(?:#[^\\/]+)?$/i);
	if (!m) return [];
	const profile = m[1] ?? 'default';
	return profile === 'default' || /^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile) ? ['-p', profile] : [];
}

/** The named OMP profile whose store holds `path` (`…/profiles/<name>/agent/sessions/…` or
 * `…/omp/profiles/<name>/sessions/…`), when the name is one OMP accepts (Orca's normalizedOmpProfile). */
export function ompProfile(path: string | null | undefined): string | null {
	const m = path?.match(/[\\/]profiles[\\/]([^\\/]+)[\\/]agent[\\/]sessions[\\/]|[\\/]omp[\\/]profiles[\\/]([^\\/]+)[\\/]sessions[\\/]/);
	const name = (m?.[1] ?? m?.[2])?.trim();
	if (!name || name === 'default') return null;
	return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) && !name.endsWith('.') && !/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(name) ? name : null;
}
