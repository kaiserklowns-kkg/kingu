// "Allow for This User" on a sandbox retry prompt (VS Code 1.147, "retry with updated sandbox
// permissions"; agent-host sandbox/retry.ts): what the card writes to the user's settings before
// it answers `allow_user` and the host runs the command again.
//
// VS Code's client does the same before it tells the host the grant was saved
// (src/vs/platform/agentHost/common/sandboxPathGrant.ts `applySandboxPathGrant`: only the list
// edits of the grant, other entries kept; `sandboxPathGrantSaved`). The domain grant adds to
// `chat.agent.sandbox.network.allowedDomains`. Kingu reads these settings from the user's
// settings.json only (Rust agent/sandbox.rs), so that is where they go.

import type { SandboxGrant } from './events';

export const PATHS_SETTING = 'chat.agent.sandbox.fileSystem.userConfiguredPaths';
export const DOMAINS_SETTING = 'chat.agent.sandbox.network.allowedDomains';

type UserPaths = { readwritePaths?: string[]; readonlyPaths?: string[]; deniedPaths?: string[]; [k: string]: unknown };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The setting a grant changes. */
export const grantSetting = (g: SandboxGrant) => (g.kind === 'domain' ? DOMAINS_SETTING : PATHS_SETTING);

/** VS Code's `applySandboxPathGrant`: removes the replaced read-only entries, adds the path to its list. */
export function withPathGrant(current: unknown, g: Extract<SandboxGrant, { kind: 'path' }>): UserPaths {
	const result: UserPaths = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as UserPaths) } : {};
	const removed = new Set(g.removed_readonly_paths);
	if (result.readonlyPaths !== undefined) result.readonlyPaths = strings(result.readonlyPaths).filter((p) => !removed.has(p));
	const key = g.access === 'read' ? 'readonlyPaths' : 'readwritePaths';
	result[key] = [...new Set([...strings(result[key]), g.persisted_path])];
	return result;
}

/** The allowed domains with the grant's added (kept in order, no duplicates). */
export function withDomainGrant(current: unknown, g: Extract<SandboxGrant, { kind: 'domain' }>): string[] {
	return [...new Set([...strings(current), ...g.domains])];
}

/** The new value of `grantSetting(g)` from its current user value. */
export function grantedValue(current: unknown, g: SandboxGrant): unknown {
	return g.kind === 'domain' ? withDomainGrant(current, g) : withPathGrant(current, g);
}
