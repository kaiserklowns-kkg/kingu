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
export function resumeArgv(agent: string, id: string): string[] {
	if (agent === 'opencode') return ['opencode', '--session', id];
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
	// Hermes and jcode too (`hermes` / `jcode --resume <id>`).
	if (agent === 'hermes' || agent === 'jcode' || agent === 'openclaw' || agent === 'zcode') return [agent, '--resume', id];
	// Pi: `pi --session <id>` (Orca groups it with opencode).
	if (agent === 'pi') return ['pi', '--session', id];
	// Muse: `muse resume <id>` (workspace-scoped, like kimi).
	if (agent === 'muse') return ['muse', 'resume', id];
	if (agent === 'codex') return ['codex', 'resume', id];
	if (agent === 'gemini') return ['gemini', '--resume', id];
	return ['claude', '--resume', id];
}
