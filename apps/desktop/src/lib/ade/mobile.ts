// Mobile pairing helpers (no Svelte, tested in mobile.test.ts). Rules: MECHANICS.md › Mobile pairing.

import { grantKey, scopedGrants, type GrantScope, type PermissionAsk } from './permissionAsk';

export type MobileDevice = { id: string; name: string; paired_at: number; last_seen_at: number };
export type NetAddress = { name: string; address: string };
export type MobileStatus = { enabled: boolean; running: boolean; port: number | null; addresses: NetAddress[]; default_address: string | null; devices: MobileDevice[]; error: string | null };
export type Pairing = { code: string; url: string; qr: string; expires_at: number; address: string; port: number };

/** Orca `PAIRING_OFFER_REFRESH_LEAD_MS`: a shown code is replaced a minute before it expires. */
export const REFRESH_LEAD_MS = 60_000;

/** Whole minutes left (rounded up), never below 0. */
export function minutesLeft(expiresAt: number, now: number): number {
	return Math.max(0, Math.ceil((expiresAt - now) / 60_000));
}

/** Orca `usePairingOfferExpiry`: time to fetch a fresh code. */
export function refreshDue(expiresAt: number, now: number): boolean {
	return now >= expiresAt - REFRESH_LEAD_MS;
}

/** A plain IPv4 address (what the Rust side accepts as a custom address). */
export function isIpv4(text: string): boolean {
	const parts = text.trim().split('.');
	return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Newest paired first (Orca lists runtime grants by `pairedAt`, newest first). */
export function sortDevices(devices: MobileDevice[]): MobileDevice[] {
	return [...devices].sort((a, b) => b.paired_at - a.paired_at);
}

/** A task's live agent state for the phone (Rust mobile.rs `LiveTask`). */
export type LivePhase = 'working' | 'permission' | 'question' | 'idle' | 'ended';
/**
 * An open permission prompt for the phone's card (Rust mobile.rs `LiveRequest`); `grants`: `grantKey`s
 * of "Allow for this session", `rules`: of "Always allow" (in this project / everywhere), with
 * whether git would track the file each would be saved to.
 */
export type LiveRequest = { tool: string | null; detail: string | null; unsandboxed: boolean; grants: string[]; rules: string[]; project_tracked: boolean; user_tracked: boolean; held: boolean };
export type LiveTask = { slug: string; phase: LivePhase; message: string | null; ask: unknown; at: number; request: LiveRequest | null };
/** What the phone needs of a task's runtime (model.ts TaskRuntime) and hook state. */
export type LiveEvidence = { live: boolean; working: boolean; pendingPermissions: number; question?: boolean; lastEvent?: string; updatedAt?: number; ask?: unknown; request?: LiveRequest | null };

/**
 * The prompt's request as the phone gets it. `held`: the agent's hook waits for Kingu's answer;
 * without it only keys can answer, so no session grant is offered.
 */
export function liveRequest(ask: PermissionAsk | undefined, held: boolean, tracked?: { project?: boolean; user?: boolean }): LiveRequest | null {
	if (!ask && !held) return null;
	const grants = held && ask && !ask.unsandboxed ? ask.grants : [];
	return {
		tool: ask?.tool ?? null,
		detail: ask?.detail ?? null,
		unsandboxed: ask?.unsandboxed === true,
		grants: grants.map(grantKey),
		rules: scopedGrants(grants, 'project').map(grantKey),
		project_tracked: tracked?.project === true,
		user_tracked: tracked?.user === true,
		held
	};
}

/** One task's row: a permission prompt or a question first (they need you), then working, idle, ended. */
export function liveRow(slug: string, e: LiveEvidence, now: number): LiveTask {
	const phase: LivePhase = e.pendingPermissions > 0 ? 'permission' : e.question ? 'question' : e.working ? 'working' : e.live ? 'idle' : 'ended';
	return { slug, phase, message: e.lastEvent ?? null, ask: phase === 'question' ? (e.ask ?? null) : null, at: e.updatedAt ?? now, request: phase === 'permission' ? (e.request ?? null) : null };
}

/** Kingu: how often a window re-sends its live rows while mobile access is on (Rust drops them after 30 s). */
export const LIVE_HEARTBEAT_MS = 10_000;

/**
 * A phone's answer as Rust hands it over (`mobile:request` with `answer`). `allow_session` comes
 * with the `grants` its card showed, `allow_project` / `allow_user` with the `rules` it showed (in
 * `grants`); a `deny` may come with a `message` for the agent.
 */
export type MobileAnswer = { kind: 'allow' | 'allow_session' | 'allow_project' | 'allow_user' | 'deny' | 'question'; selections: { indices: number[]; other?: string }[] | null; grants?: string[] | null; message?: string | null };

/** The scope a phone's allow answer asks for; undefined: allow once (or not an allow). */
export function answerScope(kind: MobileAnswer['kind']): GrantScope | undefined {
	return kind === 'allow_session' ? 'session' : kind === 'allow_project' ? 'project' : kind === 'allow_user' ? 'user' : undefined;
}
