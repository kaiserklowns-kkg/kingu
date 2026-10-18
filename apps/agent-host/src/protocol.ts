// Wire protocol between the Kingu desktop app (Rust) and this sidecar.
//
// Framing: one JSON-RPC 2.0 message per line on stdin/stdout (UTF-8, '\n'-terminated).
// Rust → host requests:  start, send, interrupt, stop, answer, shutdown.
// Host → Rust notifications: `ready` once at startup, `event` {runId, event} for every run event.
// Field names in events are snake_case, mirroring `AgentEvent` in src-tauri/src/agent/events.rs.

export type PermissionMode = 'default' | 'acceptEdits' | 'plan';
export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan'];

export type StartParams = {
	runId: number;
	cwd: string;
	prompt: string;
	model?: string | null;
	permissionMode?: PermissionMode | null;
	/** Session id to continue (from an earlier `system`/`result` event). */
	resume?: string | null;
	/** Stdio MCP servers for this run (from trusted Snaps), by name. */
	mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
	/** Skill plugin folders of active Snaps (absolute; Rust checks they are ones Kingu generated). */
	plugins?: string[];
	/** The active Claude account (`CLAUDE_CONFIG_DIR` or `ANTHROPIC_API_KEY`), over the host's env. Never logged. */
	env?: Record<string, string>;
	/** Auth variables removed from this run's env, so they do not override that account. */
	unsetEnv?: string[];
};
export type SendParams = { runId: number; text: string };
export type RunParams = { runId: number };
/** `allow` once, `allow_always` for the rest of this session, or `deny` with an optional reason. */
export type Decision = 'allow' | 'allow_always' | 'deny';
export type AnswerParams = { runId: number; requestId: string; decision: Decision; message?: string | null };

export type Usage = {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
};

export type DiffStats = { added: number; removed: number };

export type AgentEvent =
	| { kind: 'system'; subtype: string; session_id: string | null; model: string | null }
	| { kind: 'message'; role: string; text: string }
	/** Streaming text/thinking chunk; the complete `message`/`thinking` event follows. */
	| { kind: 'delta'; block: 'text' | 'thinking'; text: string }
	| { kind: 'thinking'; text: string }
	| { kind: 'tool_use'; id: string; name: string; input: unknown }
	| { kind: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }
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
	  }
	| { kind: 'permission_resolved'; request_id: string; decision: Decision | 'cancelled' }
	| { kind: 'error'; message: string }
	| { kind: 'raw'; line: string }
	| { kind: 'stderr'; line: string }
	| { kind: 'exit'; code: number | null; signal: number | null; stopped: boolean };

export type RpcRequest = { jsonrpc?: '2.0'; id: number | string; method: string; params?: unknown };
export type RpcResponse =
	| { jsonrpc: '2.0'; id: number | string; result: unknown }
	| { jsonrpc: '2.0'; id: number | string | null; error: { code: number; message: string } };
export type RpcNotification = { jsonrpc: '2.0'; method: string; params: unknown };
