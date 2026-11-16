// Mobile pairing helpers (no Svelte, tested in mobile.test.ts). Rules: MECHANICS.md › Mobile pairing.

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
export type LiveTask = { slug: string; phase: LivePhase; message: string | null; ask: unknown; at: number };
/** What the phone needs of a task's runtime (model.ts TaskRuntime) and hook state. */
export type LiveEvidence = { live: boolean; working: boolean; pendingPermissions: number; question?: boolean; lastEvent?: string; updatedAt?: number; ask?: unknown };

/** One task's row: a permission prompt or a question first (they need you), then working, idle, ended. */
export function liveRow(slug: string, e: LiveEvidence, now: number): LiveTask {
	const phase: LivePhase = e.pendingPermissions > 0 ? 'permission' : e.question ? 'question' : e.working ? 'working' : e.live ? 'idle' : 'ended';
	return { slug, phase, message: e.lastEvent ?? null, ask: phase === 'question' ? (e.ask ?? null) : null, at: e.updatedAt ?? now };
}

/** Kingu: how often a window re-sends its live rows while mobile access is on (Rust drops them after 30 s). */
export const LIVE_HEARTBEAT_MS = 10_000;

/** A phone's answer as Rust hands it over (`mobile:request` with `answer`). */
export type MobileAnswer = { kind: 'allow' | 'deny' | 'question'; selections: { indices: number[]; other?: string }[] | null };
