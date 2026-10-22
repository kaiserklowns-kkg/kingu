// Orca's prompt-cache timer (promptCacheTimerEnabled / promptCacheTtlMs): after a Claude agent
// finishes a turn and goes idle, how long until its prompt cache expires — after that the next
// message re-sends the whole conversation as uncached input. Pure, so `bun test` covers it.

import { profileOf } from './agentProfiles';
import { cliOf } from './agentCli';
import type { TaskStatus } from './model';

/** `kingu.agent.promptCacheTtl`: Anthropic's standard 5-minute cache, or the 1-hour extended one. */
export const PROMPT_CACHE_TTL_MS: Record<string, number> = { '5m': 300_000, '1h': 3_600_000 };
export const promptCacheTtl = (setting: string | undefined) => PROMPT_CACHE_TTL_MS[setting ?? ''] ?? PROMPT_CACHE_TTL_MS['5m'];

/** A Claude session: a legacy timeline task (the agent host runs Claude) or a terminal task running claude. */
export function isClaudeTask(agent: string): boolean {
	const cli = cliOf(agent);
	return cli ? profileOf(cli).id === 'claude' : !agent.startsWith('cli:');
}

type CacheView = { meta: { agent: string }; status: TaskStatus; runtime?: { working: boolean; updatedAt?: number } };

/**
 * Milliseconds left on the prompt cache of an idle Claude task (finished its turn, session still
 * there), 0 once it expired; null when no countdown applies.
 */
export function promptCacheLeft(v: CacheView, ttlMs: number, now: number): number | null {
	if (!isClaudeTask(v.meta.agent) || v.status !== 'review' || !v.runtime || v.runtime.working || !v.runtime.updatedAt) return null;
	return Math.max(0, ttlMs - (now - v.runtime.updatedAt));
}

/** `4:05`, `59:59`. */
export function formatCacheLeft(ms: number): string {
	const s = Math.ceil(ms / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
