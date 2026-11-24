// Orca's trust presets for an agent started in a tab (Orca pre-trusts the folder of every fresh
// agent launch: shared/agent-launch/permissions/agent-workspace-trust-spawn-request.ts): before the
// CLI starts, its folder is recorded as trusted in that CLI's own config (Rust agent/trust.rs), so
// the first-run "trust this folder?" prompt does not take the prompt or the first keys. A task's
// own CLI gets the same in tasks.svelte.ts.

import { invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { programOf } from './agentProfiles.ts';

/** What `agent_trust_workspace` gets for a tab of `key` (a task slug, or '' for the open folder); null: no trust write. */
export function paneTrustRequest(key: string, argv: readonly string[], o: { enabled: unknown; remote: boolean }): { slug: string | null; program: string } | null {
	// A folder on an SSH host has its CLI config there, not on this machine.
	if (o.enabled === false || o.remote) return null;
	const program = programOf(argv);
	return program ? { slug: key || null, program } : null;
}

/** Trusts the tab's folder for the CLI in `argv`; a failure is only logged (the CLI then asks, as it would anyway). */
export async function trustPaneFolder(key: string, argv: readonly string[], o: { enabled: unknown; remote: boolean }): Promise<void> {
	const request = paneTrustRequest(key, argv, o);
	if (request) await invoke('agent_trust_workspace', request).catch((e) => clientLog('info', `trust ${key || 'folder'}: ${e}`));
}
