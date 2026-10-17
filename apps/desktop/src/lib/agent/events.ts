// Mirrors `AgentEvent` / `WorktreeInfo` in src-tauri/src/agent.

export type AgentEvent =
	| { kind: 'system'; subtype: string; session_id: string | null; model: string | null }
	| { kind: 'message'; role: string; text: string }
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
	  }
	| { kind: 'raw'; line: string }
	| { kind: 'stderr'; line: string }
	| { kind: 'exit'; code: number | null; signal: number | null; stopped: boolean };

export type WorktreeInfo = {
	path: string;
	head: string | null;
	branch: string | null;
	slug: string | null;
	bare: boolean;
	detached: boolean;
	locked: boolean;
	prunable: boolean;
};

const MAX_SLUG = 48;

/** Task title → worktree slug (a-z, 0-9, '-'); titles with no ASCII letters (e.g. Thai) get a generated one. */
export function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_SLUG)
		.replace(/-+$/, '');
	return slug || `task-${Date.now().toString(36)}`;
}

const ARG_KEYS = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description'];

/** One-line argument summary for `● Tool(arg)` rows. */
export function toolArg(input: unknown, max = 80): string {
	let arg = '';
	if (input && typeof input === 'object') {
		const obj = input as Record<string, unknown>;
		const key = ARG_KEYS.find((k) => typeof obj[k] === 'string');
		const first = Object.values(obj).find((v) => typeof v === 'string');
		arg = String(key ? obj[key] : (first ?? ''));
	}
	arg = arg.replace(/\s+/g, ' ').trim();
	return arg.length > max ? `${arg.slice(0, max - 1)}…` : arg;
}

export function firstLine(text: string, max = 120): string {
	const line = text.trim().split('\n', 1)[0] ?? '';
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
