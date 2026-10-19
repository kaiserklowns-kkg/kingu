// Which agent runs a chat (Rust `agent/runtimes.rs`): `claude` (the Claude Agent SDK), Codex
// (`codex app-server`) or an ACP agent (Gemini CLI, Qwen Code, OpenCode, …, or one configured in
// `kingu.agent.acpAgents`). Rust lists the ones found on PATH; what a runtime cannot do (rewind,
// the model picker) the chat hides by its `features`.

export type RuntimeProtocol = 'claude' | 'acp' | 'codex';
export type RuntimeFeatures = { rewind: boolean; models: boolean };
export type RuntimeInfo = { id: string; name: string; protocol: RuntimeProtocol; features: RuntimeFeatures; custom: boolean };

export const CLAUDE_RUNTIME = 'claude';

/** The built-in runtime: listed even before Rust answers. */
export const CLAUDE: RuntimeInfo = { id: CLAUDE_RUNTIME, name: 'Claude Code', protocol: 'claude', features: { rewind: true, models: true }, custom: false };

/** A chat's runtime id (chats saved before runtimes have none: Claude). */
export const runtimeOf = (meta: { runtime?: string | null } | null | undefined) => meta?.runtime || CLAUDE_RUNTIME;

/** What runtime `id` can do; one not found (uninstalled since) can do only what every runtime can. */
export function featuresOf(list: readonly RuntimeInfo[], id: string): RuntimeFeatures {
	if (id === CLAUDE_RUNTIME) return CLAUDE.features;
	return list.find((r) => r.id === id)?.features ?? { rewind: false, models: false };
}

/** The picker's entries: the runtimes found, plus `current` when it is not among them (shown as missing). */
export function runtimeChoices(list: readonly RuntimeInfo[], current: string): { id: string; name: string; missing: boolean }[] {
	const out = list.map((r) => ({ id: r.id, name: r.name, missing: false }));
	if (!out.some((r) => r.id === current)) out.push({ id: current, name: current, missing: true });
	return out;
}

/** The Rust list, checked loosely (an unexpected entry is dropped); Claude always first. */
export function parseRuntimes(v: unknown): RuntimeInfo[] {
	const list = Array.isArray(v) ? v : [];
	const ok = list.filter(
		(r): r is RuntimeInfo =>
			!!r && typeof r === 'object' && typeof r.id === 'string' && typeof r.name === 'string' && ['claude', 'acp', 'codex'].includes(r.protocol) && !!r.features && typeof r.features === 'object'
	);
	return [CLAUDE, ...ok.filter((r) => r.id !== CLAUDE_RUNTIME)];
}
