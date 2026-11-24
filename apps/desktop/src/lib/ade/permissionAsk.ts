// What a terminal agent's permission prompt asks, read from its PermissionRequest hook payload, and
// what a wider answer than "once" would grant. Pure.
//
// - `detail`: Orca's approval summary (shared/agent-hook-listener/interactive-tool.ts
//   `summarizeApprovalInput`: the command, file path, URL or pattern, else the input as JSON),
//   kept to Orca's 2,000 characters for a card (workers/approvals/worker-approval.ts).
// - `grants`: Claude's `permission_suggestions` as "Allow for this session" would apply them
//   (Orca's claude-structured-prompt-replies.ts `allowForSession`: the suggestions, each with
//   `destination: 'session'`). Kingu keeps only the kinds it can name on the card: allow rules, an
//   added folder and the accept-edits mode. Rust (hooks.rs `session_grants`) builds the reply from
//   the hook file by the same rules and refuses an answer whose grants differ from the ones shown.
// - `unsandboxed`: the command asks to run outside Claude's sandbox (`dangerouslyDisableSandbox`;
//   VS Code asks before such a retry, agentHost/node/copilot/copilotShellTools.ts
//   `requestUnsandboxedExecution`). It is said on the card and never gets a session grant.

export type Grant = { kind: 'rule' | 'dir' | 'mode'; value: string };
export type PermissionAsk = {
	tool?: string;
	detail?: string;
	unsandboxed?: boolean;
	/** What "Allow for this session" would grant; empty: only once / deny can be answered. */
	grants: Grant[];
};

export const MAX_DETAIL = 2_000;
/** More or longer grants than these are not offered at all (Rust: the same limits). */
export const MAX_GRANTS = 20;
export const MAX_GRANT_VALUE = 500;
/** A reason sent with Deny (Claude's deny `message`). */
export const MAX_DENY_MESSAGE = 500;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** Orca `summarizeApprovalInput`, with a card's length. */
export function approvalDetail(input: unknown, max = MAX_DETAIL): string {
	if (isObj(input)) {
		const direct = input.command ?? input.file_path ?? input.path ?? input.url ?? input.pattern;
		if (typeof direct === 'string' && direct.length > 0) return clip(direct, max);
	}
	if (input === undefined || input === null) return '';
	try {
		const json = JSON.stringify(input) ?? '';
		return json === '{}' ? '' : clip(json, max);
	} catch {
		return '';
	}
}

/** The grants of one suggestion; null: a kind Kingu does not offer (dropped). */
function grantsOf(s: unknown): Grant[] | null {
	if (!isObj(s)) return null;
	if (s.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules) && s.rules.length) {
		const out: Grant[] = [];
		for (const r of s.rules) {
			if (!isObj(r) || typeof r.toolName !== 'string' || !r.toolName) return null;
			if (r.ruleContent !== undefined && r.ruleContent !== null && typeof r.ruleContent !== 'string') return null;
			out.push({ kind: 'rule', value: r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName });
		}
		return out;
	}
	if (s.type === 'addDirectories' && Array.isArray(s.directories) && s.directories.length) {
		if (!s.directories.every((d) => typeof d === 'string' && d)) return null;
		return (s.directories as string[]).map((value) => ({ kind: 'dir', value }));
	}
	if (s.type === 'setMode' && s.mode === 'acceptEdits') return [{ kind: 'mode', value: 'acceptEdits' }];
	return null;
}

/** What "Allow for this session" would grant for these suggestions (hooks.rs `session_grants`). */
export function sessionGrants(suggestions: unknown): Grant[] {
	if (!Array.isArray(suggestions)) return [];
	const out = suggestions.flatMap((s) => grantsOf(s) ?? []);
	return out.length > MAX_GRANTS || out.some((g) => g.value.length > MAX_GRANT_VALUE) ? [] : out;
}

/** A grant as Rust compares it. */
export const grantKey = (g: Grant) => `${g.kind}:${g.value}`;

/**
 * How far an allow reaches (permission_rules.rs `Scope`): the session (Claude's `session`), this
 * project (`localSettings`, `.claude/settings.local.json`, Claude's own "don't ask again … in this
 * project") or every project (`userSettings`, VS Code's "Always Allow"). Never the default answer.
 */
export type GrantScope = 'session' | 'project' | 'user';

/**
 * What an answer with `scope` grants: the session grants, or for a settings file only their allow
 * rules (Rust `scoped_grants`: never a folder, a mode or anything but allow rules).
 */
export function scopedGrants(grants: Grant[], scope: GrantScope): Grant[] {
	return scope === 'session' ? grants : grants.filter((g) => g.kind === 'rule');
}

/** The request of a PermissionRequest payload (`tool_name`, `tool_input`, `permission_suggestions`). */
export function permissionAsk(tool: string | undefined, input: unknown, suggestions?: unknown): PermissionAsk | undefined {
	const detail = approvalDetail(input);
	const unsandboxed = isObj(input) && input.dangerouslyDisableSandbox === true;
	const grants = unsandboxed ? [] : sessionGrants(suggestions);
	if (!tool && !detail && !grants.length) return undefined;
	return { ...(tool ? { tool } : {}), ...(detail ? { detail } : {}), ...(unsandboxed ? { unsandboxed } : {}), grants };
}

/** A deny reason as it goes to the agent: one line, bounded; undefined when empty. */
export function denyMessage(text: string | null | undefined): string | undefined {
	const line = (text ?? '').replace(/\s+/g, ' ').trim();
	return line ? line.slice(0, MAX_DENY_MESSAGE) : undefined;
}
