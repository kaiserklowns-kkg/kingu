// Wire protocol between the Kingu desktop app (Rust) and this sidecar.
//
// Framing: one JSON-RPC 2.0 message per line on stdin/stdout (UTF-8, '\n'-terminated).
// Rust → host requests:  start, send, interrupt, stop, answer, set_options, shutdown.
// `start {runtime}` picks the agent behind the run (runtimes/); the other requests are the same for all.
// Host → Rust notifications: `ready` once at startup, `event` {runId, event} for every run event.
// Field names in events are snake_case, mirroring `AgentEvent` in src-tauri/src/agent/events.rs.

/** `bypassPermissions` is "Allow all": no prompts at all (the app confirms it with the user first). */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

export type StartParams = {
	runId: number;
	cwd: string;
	prompt: string;
	model?: string | null;
	permissionMode?: PermissionMode | null;
	/** Session id to continue (from an earlier `system`/`result` event). */
	resume?: string | null;
	/**
	 * With `resume`: continue from this message (an `anchor` uuid) and drop what came after it,
	 * in a fork of the session (the SDK's `resumeSessionAt` + `forkSession`; the new session id
	 * comes back in `system`). Rewinding a chat, or forking it, uses it.
	 */
	resumeAt?: string | null;
	/** MCP servers Kingu hands this run (Snaps, the user's mcp.json, trusted .vscode/.cursor ones), by name. */
	mcpServers?: Record<string, McpServerParams>;
	/**
	 * The project's `.mcp.json` servers (which Claude Code reads itself, `settingSources`): which
	 * may run. Rust decides from Kingu's trust store and the user's disabled list; a name in
	 * `disabled` never starts, whatever the user's Claude settings approve.
	 */
	projectMcp?: { enabled?: string[]; disabled?: string[] } | null;
	/** Tools the session must not have: `mcp__<server>` for each MCP server the user turned off. */
	disallowedTools?: string[];
	/** Skill plugin folders of active Snaps (absolute; Rust checks they are ones Kingu generated). */
	plugins?: string[];
	/** The active Claude account (`CLAUDE_CONFIG_DIR` or `ANTHROPIC_API_KEY`), over the host's env. Never logged. */
	env?: Record<string, string>;
	/** Auth variables removed from this run's env, so they do not override that account. */
	unsetEnv?: string[];
	/** Image files sent with the prompt (absolute paths, checked by Rust and again here). */
	images?: string[];
	/** Snapshot files before the edit tools change them (`file_snapshot` events; chats only). */
	snapshots?: boolean;
	/** Kingu's safety checks (guards/): on unless `false` (`kingu.agent.safetyChecks`). */
	safetyChecks?: boolean | null;
	/**
	 * Kingu's always-ask checks (guards/asks.ts), on in every permission mode: writes outside `cwd`,
	 * file deletes, MCP tools, and paths matching `protectedPaths` (.kinguignore + the setting,
	 * gitignore patterns relative to `cwd`). Rust reads them from the user's settings; null: none.
	 */
	guardAsks?: { outsideCwd?: boolean; deletes?: boolean; mcpTools?: boolean; protectedPaths?: string[] } | null;
	/** Project rules (AGENTS.md, .cursor/rules, …; Rust agent/rules.rs) appended to Claude Code's system prompt. */
	systemPromptAppend?: string | null;
	/** Which agent runs the session (runtimes/): absent or `claude` is the Claude Agent SDK. */
	runtime?: RuntimeSpec | null;
};
/**
 * A runtime other than the Claude Agent SDK, resolved by Rust (agent/runtimes.rs) to a program it
 * found on the login-shell PATH: an ACP agent (Agent Client Protocol, JSON-RPC over stdio) or
 * `codex app-server`. `command` is absolute.
 */
export type RuntimeSpec = { kind: 'claude' } | { kind: 'acp' | 'codex'; command: string; args?: string[] };
/** An MCP server: a program over stdio (`type` absent or `stdio`), or a remote one over `http` / `sse`. */
export type McpServerParams = {
	type?: 'stdio' | 'http' | 'sse';
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
};
export const MCP_TYPES = ['stdio', 'http', 'sse'] as const;

export type SendParams = { runId: number; text: string; images?: string[] };
export type RunParams = { runId: number };
/** Mid-session change of the live run's model and/or permission mode (at least one). */
export type SetOptionsParams = { runId: number; model?: string | null; permissionMode?: PermissionMode | null };
/**
 * `allow` once; `allow_always` for the rest of this session; `allow_workspace` from now on in this
 * folder (the SDK writes the rule to `.claude/settings.local.json`, which is not committed);
 * `allow_user` everywhere (`~/.claude/settings.json`); or `deny` with an optional reason.
 */
export type Decision = 'allow' | 'allow_always' | 'allow_workspace' | 'allow_user' | 'deny';
export const DECISIONS: readonly Decision[] = ['allow', 'allow_always', 'allow_workspace', 'allow_user', 'deny'];
/**
 * `answers`: for an AskUserQuestion request (with `allow`), each question's text → the user's answer
 * (an option label, labels joined by ", " for a multi-select, or their own words).
 */
export type AnswerParams = { runId: number; requestId: string; decision: Decision; message?: string | null; answers?: Record<string, string> | null };

export type Usage = {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
};

export type DiffStats = { added: number; removed: number };

/** A slash command the session knows (SDK `SlashCommand`): built in, a skill, or `.claude/commands`. */
export type SlashCommandInfo = { name: string; description: string; argument_hint: string };

/** A model the session can use (SDK `ModelInfo` from `supportedModels()`). */
export type ModelOption = { value: string; display_name: string; description: string };
/** One MCP server of the live session (SDK `mcpServerStatus()`): `tools` are their bare names. */
export type McpServerLive = { name: string; status: string; error: string | null; source: string | null; tools: string[] };

/** On the events of a subagent's own conversation: the id of the Task/Agent `tool_use` that started it. */
export type Parent = { parent_tool_use_id?: string };

export type AgentEvent =
	| { kind: 'system'; subtype: string; session_id: string | null; model: string | null }
	/** What the session started with (`system`/`init`): its slash command names, tools and MCP servers. */
	| { kind: 'session_info'; slash_commands: string[]; tools: string[]; mcp_servers: { name: string; status: string }[] }
	/** The session's MCP servers as they are now (after the start, and after each turn). Replaces the last list. */
	| { kind: 'mcp_status'; servers: McpServerLive[] }
	/** The session's slash commands with descriptions (`supportedCommands()`, or a `commands_changed` push). Replaces the last list. */
	| { kind: 'commands'; commands: SlashCommandInfo[] }
	/** The models the session can switch to (`supportedModels()`, asked once per run). Replaces the last list. */
	| { kind: 'models'; models: ModelOption[] }
	/** How full the context window is after a turn: `used_tokens` of `max_tokens`. */
	| { kind: 'context_usage'; used_tokens: number; max_tokens: number }
	| ({ kind: 'message'; role: string; text: string } & Parent)
	/** Streaming text/thinking chunk of the main agent; the complete `message`/`thinking` event follows. */
	| { kind: 'delta'; block: 'text' | 'thinking'; text: string }
	| ({ kind: 'thinking'; text: string } & Parent)
	/**
	 * The session-log uuid of the SDK message whose events came just before (main-chain user and
	 * assistant messages only). The last one before a request is where `resumeAt` rewinds to.
	 */
	| { kind: 'anchor'; uuid: string }
	| ({ kind: 'tool_use'; id: string; name: string; input: unknown } & Parent)
	| ({ kind: 'tool_result'; tool_use_id: string; content: string; is_error: boolean } & Parent)
	| {
			kind: 'result';
			subtype: string;
			is_error: boolean;
			result: string | null;
			session_id: string | null;
			num_turns: number | null;
			duration_ms: number | null;
			total_cost_usd: number | null;
			usage: Usage | null;
	  }
	| {
			kind: 'permission_request';
			request_id: string;
			tool: string;
			tool_use_id: string | null;
			/** The SDK's own prompt sentence when it has one (e.g. "Claude wants to read foo.txt"). */
			title: string | null;
			/** One readable line: the bash command, the file path, the URL… */
			input_summary: string;
			/** Secondary text, e.g. the Bash tool's `description` or why the prompt was raised. */
			detail: string | null;
			diff: DiffStats | null;
			input: unknown;
			/** False when "allow always" would grant more than this one action. */
			can_always: boolean;
			/** The rules an "always" answer adds, readable (`Bash(npm test:*)`); empty: the whole tool. */
			rules: string[];
	  }
	| { kind: 'permission_resolved'; request_id: string; decision: Decision | 'cancelled' }
	/**
	 * A file's content just before an edit tool (Edit, MultiEdit, Write, NotebookEdit) changes it,
	 * sent from a PreToolUse hook. `existed: false`: the tool creates it. `skipped`: no content
	 * (outside the cwd, a symlink, ≥ 5 MB, or unreadable). Rust stores it and does not pass it on.
	 */
	| {
			kind: 'file_snapshot';
			tool_use_id: string;
			tool: string;
			path: string;
			existed: boolean;
			size: number;
			content_b64: string | null;
			skipped: 'outside' | 'symlink' | 'too_large' | 'unreadable' | null;
	  }
	/**
	 * Kingu's safety check refused a tool call (guards/), in any permission mode. `check`:
	 * `security` (a catastrophic shell command; `threats` are goose pattern names, `detail` their
	 * descriptions) or `repetition` (the third identical call in a row).
	 */
	| { kind: 'guard_blocked'; tool: string; tool_use_id: string | null; check: 'security' | 'repetition'; threats: string[]; detail: string }
	/**
	 * Kingu's always-ask check stopped a tool call for the user's answer (in any permission mode):
	 * the `permission_request` with this `request_id` follows. `check`: `outside_cwd` (writes
	 * outside the run's folder), `delete`, `protected` (a .kinguignore path) or `mcp`; `paths`: what it is about.
	 */
	| { kind: 'guard_asked'; request_id: string; tool: string; tool_use_id: string | null; check: 'outside_cwd' | 'delete' | 'protected' | 'mcp'; paths: string[] }
	| { kind: 'error'; message: string }
	| { kind: 'raw'; line: string }
	| { kind: 'stderr'; line: string }
	| { kind: 'exit'; code: number | null; signal: number | null; stopped: boolean };

export type RpcRequest = { jsonrpc?: '2.0'; id: number | string; method: string; params?: unknown };
export type RpcResponse =
	| { jsonrpc: '2.0'; id: number | string; result: unknown }
	| { jsonrpc: '2.0'; id: number | string | null; error: { code: number; message: string } };
export type RpcNotification = { jsonrpc: '2.0'; method: string; params: unknown };
