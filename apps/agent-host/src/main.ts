// Entry point: `bun run src/main.ts` (dev) or the `bun build --compile` binary (release).
// Reads JSON-RPC requests from stdin, writes responses/notifications to stdout, logs to stderr.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { AgentHost } from './host.ts';
import pkg from '../package.json' with { type: 'json' };

const SDK_VERSION = pkg.dependencies['@anthropic-ai/claude-agent-sdk'];

/**
 * The Claude Code binary the SDK drives. `KINGU_CLAUDE_BIN` wins. In a `--compile`d binary the
 * SDK cannot resolve its bundled per-platform CLI, so fall back to `claude` on PATH there.
 */
function claudeExecutable(): string | undefined {
	const override = process.env.KINGU_CLAUDE_BIN;
	if (override) return override;
	const compiled = import.meta.path.startsWith('/$bunfs') || import.meta.path.includes('~BUN');
	return compiled ? (Bun.which('claude') ?? undefined) : undefined;
}

const log = (line: string) => process.stderr.write(`[agent-host] ${line}\n`);
const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const pathToClaudeCodeExecutable = claudeExecutable();
const host = new AgentHost({
	query,
	write,
	log,
	options: {
		...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
		env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'kingu-desktop' }
	}
});

write({ jsonrpc: '2.0', method: 'ready', params: { sdkVersion: SDK_VERSION, pid: process.pid } });
log(`ready (sdk ${SDK_VERSION}, claude ${pathToClaudeCodeExecutable ? 'from KINGU_CLAUDE_BIN/PATH' : 'bundled'})`);

// Requests are handled concurrently: an `answer` must get through while a `start` is still
// awaiting, and a slow `interrupt` must not hold up the others.
const decoder = new TextDecoder();
let buffered = '';
for await (const chunk of Bun.stdin.stream()) {
	buffered += decoder.decode(chunk, { stream: true });
	let nl: number;
	while ((nl = buffered.indexOf('\n')) >= 0) {
		const line = buffered.slice(0, nl);
		buffered = buffered.slice(nl + 1);
		void host.handleLine(line);
	}
}
// stdin closed: the app is gone. End every run so no Claude Code process outlives it.
await host.dispatch('shutdown', null);
log('stdin closed, exiting');
process.exit(0);
