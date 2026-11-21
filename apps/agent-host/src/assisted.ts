// Assisted permissions (VS Code 1.144's permission level "Assisted permissions": "An LLM judge
// evaluates each tool call. Tools it doesn't approve require your approval."). VS Code's own judge
// lives in the closed Copilot runtime, so Kingu's is its own, kept on the safe side:
//   1. A shell command any of Kingu's threat patterns match (guards/patterns.ts, at any
//      confidence) always goes to the person: the judge never sees it.
//   2. Otherwise a small Claude model, with no tools and no saved session, reads the call and
//      answers `approve` or `requireApproval` with a reason.
//   3. No answer in time, an error or anything but a clear `approve` goes to the person.
// The judge only ever skips a prompt; it never denies on the person's behalf (VS Code: a call it
// does not approve requires your approval).

import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { scanForThreats } from './guards/patterns.ts';
import { threatSummary } from './guards/security.ts';

export type AssistedVerdict = 'approved' | 'needs_you' | 'unavailable';
export type AssistedReview = { verdict: AssistedVerdict; reason: string };

/** The judge's model (the SDK's alias for the current small model). */
export const JUDGE_MODEL = 'haiku';
export const JUDGE_TIMEOUT_MS = 20_000;
/** How much of a call's input the judge reads. */
const MAX_INPUT_CHARS = 6_000;
const MAX_REASON_CHARS = 300;

export const JUDGE_PROMPT = `You review one tool call that a coding agent wants to run in the user's project, and decide whether it can run without asking the user.

Answer "approve" only when the call is clearly low-risk for this project:
- it reads, searches or lists files, or runs tests, builds, linters, formatters or type checks of the project;
- it edits or creates files inside the project folder in an ordinary way;
- it runs a common read-only or local development command (git status/diff/log, ls, cat, package manager install from the project's own manifest).

Answer "requireApproval" when any of these hold, or when you are unsure:
- it deletes, overwrites or moves files outside ordinary project edits, or touches files outside the project folder;
- it pushes, publishes, deploys, force-resets git history, or changes git remotes or credentials;
- it sends data over the network other than fetching project dependencies, or downloads and runs code;
- it reads or prints secrets, keys, tokens or environment variables;
- it changes system settings, installs global software, uses sudo, or kills processes it did not start;
- the input is obfuscated, encoded, or does something different from what it appears to do.

Reply with one line of JSON and nothing else: {"decision":"approve"|"requireApproval","reason":"<one short sentence>"}`;

/** A shell call's command, when the tool is one. */
function commandOf(tool: string, input: unknown): string | null {
	if (!input || typeof input !== 'object') return null;
	const c = (input as Record<string, unknown>).command;
	return (tool === 'Bash' || tool === 'BashOutput' || /shell|terminal|exec/i.test(tool)) && typeof c === 'string' ? c : null;
}

/** Rule 1: the threat patterns' verdict for a shell command (null: they found nothing). */
export function patternReview(tool: string, input: unknown): AssistedReview | null {
	const command = commandOf(tool, input);
	if (command === null) return null;
	const threats = scanForThreats(command);
	return threats.length ? { verdict: 'needs_you', reason: `Kingu's safety patterns matched: ${threatSummary(threats)}` } : null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** What the judge reads about the call. */
export function judgeRequest(tool: string, input: unknown, cwd: string): string {
	let shown: string;
	try {
		shown = JSON.stringify(input ?? {}, null, 1);
	} catch {
		shown = String(input);
	}
	return `Project folder: ${cwd}\nTool: ${tool}\nInput:\n${clip(shown, MAX_INPUT_CHARS)}`;
}

/** The judge's answer: only an explicit "approve" approves. */
export function parseVerdict(text: string): AssistedReview {
	const m = /\{[\s\S]*\}/.exec(text);
	let decision: unknown;
	let reason: unknown;
	try {
		const v = m ? (JSON.parse(m[0]) as Record<string, unknown>) : {};
		decision = v.decision;
		reason = v.reason;
	} catch {
		/* not JSON: needs you */
	}
	const why = typeof reason === 'string' && reason.trim() ? clip(reason.trim().replace(/\s+/g, ' '), MAX_REASON_CHARS) : '';
	return decision === 'approve' ? { verdict: 'approved', reason: why || 'Judged low-risk.' } : { verdict: 'needs_you', reason: why || 'The reviewer did not approve this call.' };
}

type QueryLike = AsyncIterable<unknown> & { interrupt?: () => Promise<void> };
export type JudgeQuery = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryLike;

async function* once(text: string): AsyncIterable<SDKUserMessage> {
	yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

/**
 * Reviews one tool call (rules 1-3). `base`: the host's SDK options (the Claude Code executable,
 * the account's env); the judge runs in `cwd` with no tools, settings or saved session.
 */
export async function reviewToolCall(args: {
	tool: string;
	input: unknown;
	cwd: string;
	query: JudgeQuery;
	base?: Partial<Options>;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<AssistedReview> {
	const byPattern = patternReview(args.tool, args.input);
	if (byPattern) return byPattern;
	const abort = new AbortController();
	const stop = () => abort.abort();
	args.signal?.addEventListener('abort', stop);
	const timer = setTimeout(stop, args.timeoutMs ?? JUDGE_TIMEOUT_MS);
	try {
		const options: Options = {
			...(args.base ?? {}),
			cwd: args.cwd,
			model: JUDGE_MODEL,
			maxTurns: 1,
			tools: [],
			persistSession: false,
			settingSources: [],
			systemPrompt: JUDGE_PROMPT,
			abortController: abort,
			canUseTool: async () => ({ behavior: 'deny', message: 'The reviewer runs no tools.' })
		};
		let text = '';
		for await (const msg of args.query({ prompt: once(judgeRequest(args.tool, args.input, args.cwd)), options })) {
			const m = msg as { type?: string; subtype?: string; result?: unknown };
			if (m?.type === 'result') {
				if (m.subtype === 'success' && typeof m.result === 'string') text = m.result;
				break;
			}
		}
		if (abort.signal.aborted) return { verdict: 'unavailable', reason: 'The reviewer did not answer in time.' };
		return text ? parseVerdict(text) : { verdict: 'unavailable', reason: 'The reviewer gave no answer.' };
	} catch (e) {
		return { verdict: 'unavailable', reason: abort.signal.aborted ? 'The reviewer did not answer in time.' : `The reviewer failed: ${clip(e instanceof Error ? e.message : String(e), 200)}` };
	} finally {
		clearTimeout(timer);
		args.signal?.removeEventListener('abort', stop);
	}
}
